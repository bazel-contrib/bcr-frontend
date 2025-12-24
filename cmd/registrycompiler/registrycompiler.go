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
				log.Panicf("module version not found!", mv)
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

// // enrichWithGitHubData fetches GitHub repository metadata and populates it into the registry
// func enrichWithGitHubData(token string, registry *bzpb.Registry, maxCount int) error {
// 	ctx := context.Background()
// 	client := gh.NewClient(token)

// 	// Collect all repos to fetch
// 	repoToModule := make(map[gh.Repo]*bzpb.Module)

// 	for _, module := range registry.Modules {
// 		if module.Metadata == nil {
// 			continue
// 		}

// 		for _, repoStr := range module.Metadata.Repository {
// 			repo, ok := parseGitHubRepo(repoStr)
// 			if !ok {
// 				continue
// 			}

// 			// Skip if we've already seen this repo (map handles dedup)
// 			if _, exists := repoToModule[repo]; exists {
// 				continue
// 			}

// 			repoToModule[repo] = module

// 			if len(repoToModule) > 10 {
// 				break
// 			}
// 		}
// 	}

// 	// Convert map keys to slice
// 	repos := make([]gh.Repo, 0, len(repoToModule))
// 	for repo := range repoToModule {
// 		repos = append(repos, repo)
// 		if len(repos) > maxCount {
// 			break
// 		}
// 	}

// 	if len(repos) == 0 {
// 		log.Printf("No GitHub repositories found to enrich")
// 		return nil
// 	}

// 	log.Printf("Fetching GitHub data for %d repositories...", len(repos))

// 	// Fetch repo info in batch
// 	results, err := gh.FetchRepoInfoBatch(ctx, client, repos)
// 	if err != nil {
// 		return fmt.Errorf("failed to fetch repo info batch: %w", err)
// 	}

// 	// Populate results back to modules
// 	successCount := 0
// 	for _, info := range results {
// 		if info.Error != nil {
// 			log.Printf("Warning: failed to fetch %s/%s: %v", info.Repo.Owner, info.Repo.Name, info.Error)
// 			continue
// 		}

// 		module := repoToModule[info.Repo]
// 		if module.Metadata.RepositoryMetadata == nil {
// 			module.Metadata.RepositoryMetadata = &bzpb.RepositoryMetadata{}
// 		}

// 		module.Metadata.RepositoryMetadata.Organization = info.Repo.Owner
// 		module.Metadata.RepositoryMetadata.Name = info.Repo.Name
// 		module.Metadata.RepositoryMetadata.Description = info.Description
// 		module.Metadata.RepositoryMetadata.Stargazers = int32(info.StargazerCount)

// 		// Convert languages map from int to int32
// 		if len(info.Languages) > 0 {
// 			module.Metadata.RepositoryMetadata.Languages = make(map[string]int32)
// 			for lang, bytes := range info.Languages {
// 				module.Metadata.RepositoryMetadata.Languages[lang] = int32(bytes)
// 			}
// 		}

// 		successCount++
// 	}

// 	log.Printf("Successfully enriched %d/%d repositories with GitHub data", successCount, len(repos))
// 	return nil
// }

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
