package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/attestationsjson"
	"github.com/stackb/centrl/pkg/modulebazel"
	"github.com/stackb/centrl/pkg/paramsfile"
	"github.com/stackb/centrl/pkg/presubmityml"
	"github.com/stackb/centrl/pkg/protoutil"
	"github.com/stackb/centrl/pkg/sourcejson"
)

const toolName = "moduleversioncompiler"

type Config struct {
	OutputFile            string
	ModuleBazelFile       string
	SourceJsonFile        string
	AttestationsJsonFile  string
	PresubmitYmlFile      string
	DocumentationInfoFile string
	CommitSha1            string
	CommitDate            string
	CommitMessage         string
	UnresolvedDeps        string
	UrlStatusCode         int
	UrlStatusMessage      string
	DocsUrlStatusCode     int
	DocsUrlStatusMessage  string
	SourceCommitSha       string
	IsLatestVersion       bool
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

	// Validate required flags
	if cfg.ModuleBazelFile == "" {
		return fmt.Errorf("module_bazel_file is required")
	}
	if cfg.OutputFile == "" {
		return fmt.Errorf("output_file is required")
	}

	// Read MODULE.bazel file (required)
	module, err := modulebazel.ExecFile(cfg.ModuleBazelFile)
	if err != nil {
		return fmt.Errorf("failed to read MODULE.bazel: %v", err)
	}

	module.IsLatestVersion = cfg.IsLatestVersion

	// Read source.json file (optional)
	if cfg.SourceJsonFile != "" {
		source, err := sourcejson.ReadFile(cfg.SourceJsonFile)
		if err != nil {
			return fmt.Errorf("failed to read source.json: %v", err)
		}
		module.Source = source
		module.Source.CommitSha = cfg.SourceCommitSha
		if module.Source.Url != "" {
			module.Source.UrlStatus = &bzpb.ResourceStatus{
				Url:     module.Source.Url,
				Code:    int32(cfg.UrlStatusCode),
				Message: cfg.UrlStatusMessage,
			}
		}
		if module.Source.DocsUrl != "" {
			module.Source.UrlStatus = &bzpb.ResourceStatus{
				Url:     module.Source.DocsUrl,
				Code:    int32(cfg.DocsUrlStatusCode),
				Message: cfg.DocsUrlStatusMessage,
			}
		}
		if cfg.DocumentationInfoFile != "" {
			var docs bzpb.DocumentationInfo
			if err := protoutil.ReadFile(cfg.DocumentationInfoFile, &docs); err != nil {
				return fmt.Errorf("failed to read docs: %v", err)
			}
			module.Source.Documentation = &docs
		}
	}

	// Read presubmit.yml file (optional)
	if cfg.PresubmitYmlFile != "" {
		presubmit, err := presubmityml.ReadFile(cfg.PresubmitYmlFile)
		if err != nil {
			// TODO: fix parsing of the YAML
			log.Printf("failed to read presubmit.yml: %v", err)
		} else {
			module.Presubmit = presubmit
		}
	}

	// Read attestions.json file (optional)
	if cfg.AttestationsJsonFile != "" {
		attestations, err := attestationsjson.ReadFile(cfg.AttestationsJsonFile)
		if err != nil {
			return fmt.Errorf("failed to read presubmit.yml: %v", err)
		}
		module.Attestations = attestations
	}

	// Add commit information (optional)
	if cfg.CommitSha1 != "" && cfg.CommitDate != "" {
		module.Commit = &bzpb.ModuleCommit{
			Sha1:        cfg.CommitSha1,
			Date:        cfg.CommitDate,
			Message:     cfg.CommitMessage,
			PullRequest: parsePullRequestFromCommitMessage(cfg.CommitMessage),
		}
	}

	if cfg.UnresolvedDeps != "" {
		depNames := strings.Split(cfg.UnresolvedDeps, ",")
		for _, name := range depNames {
			dep := mustFindDependencyByName(module, name)
			dep.Unresolved = true
		}
	}

	// Write the compiled ModuleVersion to output file
	if err := protoutil.WriteFile(cfg.OutputFile, module); err != nil {
		return fmt.Errorf("failed to write output file: %v", err)
	}

	// log.Printf("Successfully compiled module version to %s", cfg.OutputFile)
	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.ModuleBazelFile, "module_bazel_file", "", "the MODULE.bazel file to read (required)")
	fs.StringVar(&cfg.SourceJsonFile, "source_json_file", "", "the source.json file to read (optional)")
	fs.StringVar(&cfg.DocumentationInfoFile, "documentation_info_file", "", "the (optional) DocumentationInfo proto file to read")
	fs.StringVar(&cfg.PresubmitYmlFile, "presubmit_yml_file", "", "the presubmit.yml file to read (optional)")
	fs.StringVar(&cfg.AttestationsJsonFile, "attestations_json_file", "", "the attestations.json file to read (optional)")
	fs.StringVar(&cfg.CommitSha1, "commit_sha1", "", "the git commit SHA-1 hash (optional)")
	fs.StringVar(&cfg.CommitDate, "commit_date", "", "the git commit date in ISO 8601 format (optional)")
	fs.StringVar(&cfg.CommitMessage, "commit_message", "", "the git commit message (optional)")
	fs.StringVar(&cfg.OutputFile, "output_file", "", "the output file to write")
	fs.StringVar(&cfg.UnresolvedDeps, "unresolved_deps", "", "comma-separated list of dep names that failed to resolve to a known version")
	fs.IntVar(&cfg.UrlStatusCode, "url_status_code", 0, "HTTP status code for the source URL (optional)")
	fs.StringVar(&cfg.UrlStatusMessage, "url_status_message", "", "HTTP status message for the source URL (optional)")
	fs.IntVar(&cfg.DocsUrlStatusCode, "docs_url_status_code", 0, "HTTP status code for the docs URL (optional)")
	fs.StringVar(&cfg.DocsUrlStatusMessage, "docs_url_status_message", "", "HTTP status message for the docs URL (optional)")
	fs.StringVar(&cfg.SourceCommitSha, "source_commit_sha", "", "the git commit SHA for the source URL (resolved from tags/releases, optional)")
	fs.BoolVar(&cfg.IsLatestVersion, "is_latest_version", false, "if true, marks this module version as the latest one")

	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s @PARAMS_FILE", toolName)
		fs.PrintDefaults()
	}

	if err = fs.Parse(args); err != nil {
		return
	}

	return
}

func mustFindDependencyByName(module *bzpb.ModuleVersion, name string) *bzpb.ModuleDependency {
	for _, dep := range module.Deps {
		if name == dep.Name {
			return dep
		}
	}
	log.Fatalf("unable to find dependency %s in module version %s/%s (this is a bug)", name, module.Name, module.Version)
	return nil
}

var pullRequestRegex = regexp.MustCompile(`\(#(\d+)\)`)

// parsePullRequestFromCommitMessage extracts the pull request number from a commit message.
// Example: "Add basic support for Boost 1.89.0 (#5514)" returns "5514"
func parsePullRequestFromCommitMessage(message string) string {
	matches := pullRequestRegex.FindStringSubmatch(message)
	if len(matches) > 1 {
		return matches[1]
	}
	return ""
}
