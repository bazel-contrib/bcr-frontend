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
	// into.  See bzlcompiler/config.go for why this matters.
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
	BzlFiles            bzlFileSlice
	PackageFiles        packageFileSlice
	FilesToExtract      []string
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
	fs.Var(&cfg.PackageFiles, "package_file", "package source file mapping in the format REPO|LABEL|PATH (repeatable)")
	fs.Var(&cfg.BzlFiles, "bzl_file", ".bzl source file mapping in the format REPO|LABEL|PATH (repeatable). Staged into the workdir so PackageInfo can resolve transitive load() statements.")
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
		os.Stderr = logFile
		cfg.Logger = log.New(logFile, toolName+": ", log.LstdFlags)
	} else {
		cfg.Logger = log.New(os.Stderr, toolName+": ", 0)
	}

	if cfg.PersistentWorker {
		return &cfg, nil
	}

	cfg.FilesToExtract = fs.Args()

	if cfg.OutputFile == "" {
		return nil, fmt.Errorf("--output_file is required")
	}
	if len(cfg.PackageFiles) == 0 {
		return nil, fmt.Errorf("--package_file list must not be empty")
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

	return &cfg, nil
}

type bzlFile struct {
	RepoName string
	Path     string
	Label    *slpb.Label
}

type bzlFileSlice []*bzlFile

func (s *bzlFileSlice) String() string {
	var parts []string
	for _, f := range *s {
		parts = append(parts, fmt.Sprintf("%s|%s|%s", f.RepoName, f.Label, f.Path))
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

type packageFile struct {
	RepoName string
	Path     string
	Label    *slpb.Label
}

type packageFileSlice []*packageFile

func (s *packageFileSlice) String() string {
	var parts []string
	for _, file := range *s {
		parts = append(parts, fmt.Sprintf("%s|%s|%s", file.RepoName, file.Label, file.Path))
	}
	return strings.Join(parts, ",")
}

func (s *packageFileSlice) Set(value string) error {
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

	// Strip the .package suffix so starlarkserver sees a real BUILD filename.
	name := strings.TrimSuffix(filepath.Base(path), ".package")

	*s = append(*s, &packageFile{
		RepoName: repoName,
		Path:     path,
		Label:    &slpb.Label{Repo: repoName, Pkg: lbl.Pkg, Name: name},
	})

	return nil
}

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

	parts := strings.SplitN(value, ":", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid module_dep format %q, expected DOCS_REPO_NAME=MODULE_NAME:MODULE_VERSION:REPO_NAME", value)
	}

	docsRepoName := parts[0]

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
