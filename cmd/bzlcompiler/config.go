package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	slpb "github.com/stackb/centrl/build/stack/starlark/v1beta1"
)

const (
	// workDir is a relative path (from the execroot) that we rewrite files
	// into.  If you try and overwrite "external/bazel_tools/..." it ends up
	// corrupting the bazel install!
	workDir = "work"
)

type Config struct {
	BuiltinsBzlPath     string // TODO: load bb //src/main/starlark/builtins_bzl:builtins_bzl_zip?
	Client              slpb.StarlarkClient
	Cwd                 string
	JavaInterpreterFile string
	LogFile             string
	Logger              *log.Logger
	OutputFile          string
	PersistentWorker    bool
	Port                int
	ServerJarFile       string
	BzlFiles            bzlFileSlice // the transitive set of .bzl files in the sandbox
	FilesToExtract      []string     // list of files to extract docs for
	WorkspaceCwd        string
	WorkspaceOutputBase string
	BazelToolsRepoName  string
	moduleDeps          moduleDepsMap
}

func parseConfig(args []string) (*Config, error) {
	var cfg Config

	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.JavaInterpreterFile, "java_interpreter_file", "", "path to a java interpreter")
	fs.StringVar(&cfg.ServerJarFile, "server_jar_file", "", "the executable jar file for the server")
	fs.StringVar(&cfg.LogFile, "log_file", "", "path to log file (optional, defaults to stderr)")
	fs.StringVar(&cfg.OutputFile, "output_file", "", "the output file to write")
	fs.StringVar(&cfg.WorkspaceCwd, "workspace_cwd", "", "the workspace root dir")
	fs.StringVar(&cfg.WorkspaceOutputBase, "workspace_output_base", "", "workspace output base")
	fs.StringVar(&cfg.BazelToolsRepoName, "bazel_tools_repo_name", "", "the canonical repository name for bazel tools sources")
	fs.IntVar(&cfg.Port, "port", 0, "the port number to use for the server process.  If a port is assigned, assume server is running external to this worker.  If it is unassigned, self-host the server as a child process.")
	fs.BoolVar(&cfg.PersistentWorker, "persistent_worker", false, "present if this tool is being invoked as a bazel persistent worker")
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
		defer logFile.Close()
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
	if cfg.WorkspaceCwd == "" {
		return nil, fmt.Errorf("--workspace_cwd is required")
	}
	if cfg.WorkspaceOutputBase == "" {
		return nil, fmt.Errorf("--workspace_output_base is required")
	}

	return &cfg, nil
}

type bzlFile struct {
	RepoName      string // the name of the repo to which the file belongs (e.g. "rules_go")
	Path          string // the original path
	RelativePath  string // non-external path
	EffectivePath string // the remapped path
	Label         *bzpb.Label
}

// bzlFileSlice is a custom flag type for repeatable --mapping flags
type bzlFileSlice []*bzlFile

func (s *bzlFileSlice) String() string {
	var parts []string
	for _, sf := range *s {
		parts = append(parts, fmt.Sprintf("%s:%s", sf.RepoName, sf.Path))
	}
	return strings.Join(parts, ",")
}

func (s *bzlFileSlice) Set(value string) error {
	parts := strings.SplitN(value, ":", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid mapping format %q, expected REPO_NAME:PATH", value)
	}

	*s = append(*s, &bzlFile{
		RepoName: parts[0],
		Path:     parts[1],
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
