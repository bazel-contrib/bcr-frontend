package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	slpb "github.com/bazel-contrib/bcr-frontend/build/stack/starlark/v1beta1"
	"github.com/bazelbuild/bazel-gazelle/label"
)

const (
	// workDir is a relative path (from the execroot) that we rewrite files
	// into.  If you try and overwrite "external/bazel_tools/..." it ends up
	// corrupting the bazel install!
	workDir = "work"
)

type config struct {
	Client              slpb.StarlarkClient
	Cwd                 string
	JavaInterpreterFile string
	LogFile             string
	Logger              *log.Logger
	OutputFile          string
	PersistentWorker    bool
	ErrorLimit          int
	Port                int
	ServerJarFile       string
	BzlFiles            bzlFileSlice // the transitive set of .bzl files in the sandbox
	FilesToExtract      []string     // list of files to extract docs for
	moduleDeps          moduleDepsMap
}

func parseConfig(args []string) (*config, error) {
	var cfg config

	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.JavaInterpreterFile, "java_interpreter_file", "", "path to a java interpreter")
	fs.StringVar(&cfg.ServerJarFile, "server_jar_file", "", "the executable jar file for the server")
	fs.StringVar(&cfg.LogFile, "log_file", "", "path to log file (optional, defaults to stderr)")
	fs.StringVar(&cfg.OutputFile, "output_file", "", "the output file to write")
	fs.IntVar(&cfg.Port, "port", 0, "the port number to use for the server process.  If a port is assigned, assume server is running external to this worker.  If it is unassigned, self-host the server as a child process.")
	fs.BoolVar(&cfg.PersistentWorker, "persistent_worker", false, "present if this tool is being invoked as a bazel persistent worker")
	fs.IntVar(&cfg.ErrorLimit, "error_limit", 0, "fail if we exceed this limit (must be non-zero to take effect)")
	fs.Var(&cfg.BzlFiles, "bzl_file", "bzl source file mapping in the format LABEL=PATH (repeatable)")
	fs.Var(&cfg.moduleDeps, "module_dep", "module dependency map (repeatable)")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s @PARAMS_FILE", toolName)
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	wd, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("getting os cwd: %v", err)
	}
	cfg.Cwd = wd

	if cfg.LogFile != "" {
		logFile, err := os.OpenFile(cfg.LogFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0666)
		if err != nil {
			return nil, fmt.Errorf("failed to open log file: %v", err)
		}
		// Don't close logFile - it needs to stay open for the lifetime of the program
		// to capture panics. Redirect stderr so panics are written to the log file.
		os.Stderr = logFile
		cfg.Logger = log.New(logFile, toolName+": ", log.LstdFlags)
	} else {
		cfg.Logger = log.New(os.Stderr, toolName+": ", 0)
	}

	// For persistent worker mode, we only get --persistent_worker flag initially.
	// All other flags come in WorkRequest messages.
	if cfg.PersistentWorker {
		return &cfg, nil
	}

	cfg.FilesToExtract = fs.Args()

	if cfg.OutputFile == "" {
		return nil, fmt.Errorf("--output_file is required")
	}
	if len(cfg.BzlFiles) == 0 {
		return nil, fmt.Errorf("--bzl_file list must not be empty")
	}
	if len(cfg.FilesToExtract) == 0 {
		return nil, fmt.Errorf("extract file list must not be empty")
	}
	if cfg.JavaInterpreterFile == "" {
		return nil, fmt.Errorf("--java_interpreter_file is required")
	}
	if cfg.ServerJarFile == "" {
		return nil, fmt.Errorf("--server_jar_file is required")
	}
	if cfg.OutputFile == "" {
		return nil, fmt.Errorf("--output_file is required")
	}

	return &cfg, nil
}

type bzlFile struct {
	RepoName string // the name of the repo to which the file belongs (e.g. "rules_go")
	Path     string // the original path
	Label    *slpb.Label
}

// bzlFileSlice is a custom flag type for repeatable --mapping flags
type bzlFileSlice []*bzlFile

func (s *bzlFileSlice) String() string {
	var parts []string
	for _, file := range *s {
		parts = append(parts, fmt.Sprintf("%s|%s|%s", file.RepoName, file.Label, file.Path))
	}
	return strings.Join(parts, ",")
}

func (s *bzlFileSlice) Set(value string) error {
	parts := strings.SplitN(value, "|", 3)
	if len(parts) != 3 {
		return fmt.Errorf("invalid mapping format %q, expected REPO_NAME|LABEL|PATH", value)
	}

	repoName := parts[0]
	lbl, err := label.Parse(parts[1])
	if err != nil {
		return fmt.Errorf("invalid mapping format %q, malformed label %s: %v", value, parts[2], err)
	}
	path := parts[2]

	*s = append(*s, &bzlFile{
		RepoName: repoName,
		Path:     path,
		Label:    &slpb.Label{Repo: repoName, Pkg: lbl.Pkg, Name: filepath.Base(path)},
	})

	return nil
}

// moduleDepsMap is a custom flag type for repeatable --module_dep flags
type moduleDepsMap map[string][]*bzpb.ModuleDependency

func (m *moduleDepsMap) String() string {
	if *m == nil {
		return ""
	}
	var parts []string
	for docsRepo, deps := range *m {
		parts = append(parts, fmt.Sprintf("%s=%+v", docsRepo, deps))
	}
	return strings.Join(parts, ",")
}

func (m *moduleDepsMap) Set(value string) error {
	if *m == nil {
		*m = make(map[string][]*bzpb.ModuleDependency)
	}

	// Parse DOCS_REPO_NAME=MODULE_NAME:MODULE_VERSION:REPO_NAME
	parts := strings.SplitN(value, ":", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid module_dep format %q, expected DOCS_REPO_NAME=MODULE_NAME:MODULE_VERSION:REPO_NAME", value)
	}

	docsRepoName := parts[0]

	// special handling for NONE to populate the map key with an empty list
	if parts[1] == "NONE" {
		(*m)[docsRepoName] = []*bzpb.ModuleDependency{}
		return nil
	}

	depParts := strings.Split(parts[1], "=")
	if len(depParts) != 2 {
		return fmt.Errorf("invalid module_dep format %q, expected MODULE_NAME:DEP_NAME=REPO_NAME after =", value)
	}

	(*m)[docsRepoName] = append((*m)[docsRepoName], &bzpb.ModuleDependency{
		Name:     depParts[0],
		RepoName: depParts[1],
	})

	return nil
}
