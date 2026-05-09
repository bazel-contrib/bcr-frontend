package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	sympb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/symbol/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/gh"
	"github.com/bazel-contrib/bcr-frontend/pkg/paramsfile"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

const toolName = "registrycompiler"

type Config struct {
	OutputFile                string
	ModuleRegistrySymbolsFile string
	ModuleFiles               []string
	GithubToken               string
	RepositoryURL             string
	RegistryURL               string
	Branch                    string
	Commit                    string
	CommitDate                string
}

func main() {
	log.SetPrefix(toolName + ": ")
	log.SetOutput(os.Stderr)
	log.SetFlags(0) // don't print timestamps

	if err := run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}

func run(args []string) error {
	parsedArgs, err := paramsfile.ReadArgsParamsFile(args)
	if err != nil {
		return fmt.Errorf("failed to read params file: %v", err)
	}

	cfg, err := parseFlags(parsedArgs)
	if err != nil {
		return fmt.Errorf("failed to parse args: %v", err)
	}

	if cfg.OutputFile == "" {
		return fmt.Errorf("output_file is required")
	}

	var registry bzpb.Registry

	// Populate registry metadata fields
	registry.RepositoryUrl = cfg.RepositoryURL
	registry.RegistryUrl = cfg.RegistryURL
	registry.Branch = cfg.Branch
	registry.CommitSha = cfg.Commit
	registry.CommitDate = cfg.CommitDate

	moduleVersionsById := make(map[string]*bzpb.ModuleVersion)

	for _, file := range cfg.ModuleFiles {
		var module bzpb.Module
		if err := protoutil.ReadFile(file, &module); err != nil {
			return fmt.Errorf("reading %s: %v", file, err)
		}
		for _, mv := range module.Versions {
			id := fmt.Sprintf("%s@%s", mv.Name, mv.Version)
			moduleVersionsById[id] = mv
		}
		registry.Modules = append(registry.Modules, &module)
	}

	if cfg.ModuleRegistrySymbolsFile != "" {
		var docRegistry sympb.ModuleRegistrySymbols
		if err := protoutil.ReadFile(cfg.ModuleRegistrySymbolsFile, &docRegistry); err != nil {
			return fmt.Errorf("reading %s: %v", cfg.ModuleRegistrySymbolsFile, err)
		}
		for _, d := range docRegistry.ModuleVersion {
			id := fmt.Sprintf("%s@%s", d.ModuleName, d.Version)
			if mv, ok := moduleVersionsById[id]; ok {
				if mv.Source.Documentation == nil {
					mv.Source.Documentation = d
				}
			} else {
				// The doc registry may carry entries for module versions that
				// are no longer in the main registry (e.g. yanked, or the doc
				// snapshot is newer than the registry snapshot). Skip them
				// rather than failing the build.
				log.Printf("warning: skipping documentation for unknown module version %s", id)
			}
		}
	}

	// Write the compiled ModuleVersion to output file
	if err := protoutil.WriteFile(cfg.OutputFile, &registry); err != nil {
		return fmt.Errorf("failed to write output file: %v", err)
	}

	// log.Printf("Successfully compiled registry: %s", cfg.OutputFile)
	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.OutputFile, "output_file", "", "the output file to write")
	fs.StringVar(&cfg.ModuleRegistrySymbolsFile, "documentation_registry_file", "", "the doc registry file to read")
	fs.StringVar(&cfg.RepositoryURL, "repository_url", "", "repository URL of the registry (e.g. 'https://github.com/bazelbuild/bazel-central-registry')")
	fs.StringVar(&cfg.RegistryURL, "registry_url", "", "URL of the registry UI (e.g. 'https://registry.bazel.build')")
	fs.StringVar(&cfg.Branch, "branch", "", "branch name of the repository data (e.g. 'main')")
	fs.StringVar(&cfg.Commit, "commit", "", "commit sha1 of the repository data")
	fs.StringVar(&cfg.CommitDate, "commit_date", "", "timestamp of the commit date (ISO 8601 format)")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s @PARAMS_FILE", toolName)
		fs.PrintDefaults()
	}

	if err = fs.Parse(args); err != nil {
		return
	}

	cfg.ModuleFiles = fs.Args()

	return
}

// parseGitHubRepo parses a repository string like "github:owner/repo" and returns owner and repo name
func parseGitHubRepo(repoStr string) (gh.Repo, bool) {
	// Handle formats like:
	// - "github:owner/repo"
	// - "https://github.com/owner/repo"
	// - "owner/repo"

	if after, found := strings.CutPrefix(repoStr, "github:"); found {
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "https://github.com/"); found {
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "http://github.com/"); found {
		repoStr = after
	}

	parts := strings.Split(repoStr, "/")
	if len(parts) < 2 {
		return gh.Repo{}, false
	}

	return gh.Repo{
		Owner: parts[0],
		Name:  parts[1],
	}, true
}
