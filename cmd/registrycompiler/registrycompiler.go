package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
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
	Thin                      bool
	ModuleVersionsDir         string
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

	if cfg.Thin {
		if err := thinRegistry(&registry, cfg.ModuleVersionsDir); err != nil {
			return err
		}
	}

	// Write the compiled ModuleVersion to output file
	if err := protoutil.WriteFile(cfg.OutputFile, &registry); err != nil {
		return fmt.Errorf("failed to write output file: %v", err)
	}

	// log.Printf("Successfully compiled registry: %s", cfg.OutputFile)
	return nil
}

// thinRegistry strips per-version detail from every non-latest ModuleVersion,
// optionally writing the untouched record to moduleVersionsDir first so the
// frontend can fetch it on demand.
//
// Motivation: the boot payload is base64+gzipped into a <script> and parsed in
// full on every page load. At ~15.8MB of wire format it expands to roughly
// 740MB of JS objects, which exceeds the per-tab memory cap on iOS Safari --
// WebContent gets killed with `highwater`, Safari reloads the tab, and the
// cycle repeats until it gives up. Thinning takes the payload to ~5.7MB.
//
// What stays on every version, and why:
//
//   - name, version, compatibility_level, bazel_compatibility, repo_name
//   - deps and override: the frontend builds a reverse-dependency index and
//     runs MVS resolution across the *entire* version history, so the
//     dependency graph cannot be reduced to latest-only. See
//     buildReverseDependencyIndex in app/bcr/registry.js and app/bcr/mvs.js.
//   - a reduced commit (date, pull_request, github_user, github_name): the
//     home "recently added" feed reads the OLDEST version of each module, and
//     the maintainers page attributes every version by commit.github_user.
//     Only sha1 and the (large) commit message are dropped.
//
// Everything else -- source, attestations, presubmit, toolchains_to_register
// -- is only ever rendered on a module detail page for the single version
// being viewed, so it is served per-version instead.
func thinRegistry(registry *bzpb.Registry, moduleVersionsDir string) error {
	for _, module := range registry.Modules {
		for _, mv := range module.Versions {
			if mv.IsLatestVersion {
				continue
			}
			if moduleVersionsDir != "" {
				if err := writeModuleVersionRecord(moduleVersionsDir, mv); err != nil {
					return err
				}
			}
			mv.Source = nil
			mv.Attestations = nil
			mv.Presubmit = nil
			mv.ToolchainsToRegister = nil
			mv.RepositoryMetadata = nil
			if mv.Commit != nil {
				mv.Commit = &bzpb.ModuleCommit{
					Date:        mv.Commit.Date,
					PullRequest: mv.Commit.PullRequest,
					GithubUser:  mv.Commit.GithubUser,
					GithubName:  mv.Commit.GithubName,
				}
			}
		}
	}
	return nil
}

// writeModuleVersionRecord writes the full ModuleVersion to
// <dir>/<name>/<version>/moduleversion.pb.gz. releasecompiler copies the tree
// into the tarball under modules/, giving the frontend a URL that mirrors the
// existing documentationinfo.pb.gz / packageinfo.pb.gz convention.
func writeModuleVersionRecord(dir string, mv *bzpb.ModuleVersion) error {
	path := filepath.Join(dir, mv.Name, mv.Version, "moduleversion.pb.gz")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("creating %s: %v", filepath.Dir(path), err)
	}
	if err := protoutil.WriteFile(path, mv); err != nil {
		return fmt.Errorf("writing %s: %v", path, err)
	}
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
	fs.BoolVar(&cfg.Thin, "thin", false, "strip per-version detail (source, attestations, presubmit, commit sha1/message) from non-latest module versions. Keeps the full dependency graph and the commit fields the home/maintainers feeds read. Shrinks the boot payload from ~15.8MB to ~5.7MB of wire format")
	fs.StringVar(&cfg.ModuleVersionsDir, "module_versions_dir", "", "with -thin, write each non-latest version's untouched record to <dir>/<name>/<version>/moduleversion.pb.gz for the frontend to fetch on demand")
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
