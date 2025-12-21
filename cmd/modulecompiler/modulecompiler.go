package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"slices"

	bzpb "github.com/stackb/centrl/build/stack/bazel/registry/v1"
	"github.com/stackb/centrl/pkg/metadatajson"
	"github.com/stackb/centrl/pkg/paramsfile"
	"github.com/stackb/centrl/pkg/protoutil"
	"github.com/stackb/centrl/pkg/repositorymetadatajson"
)

const toolName = "modulecompiler"

type Config struct {
	OutputFile             string
	ModuleMetadataFile     string
	RepositoryMetadataFile string
	SourceJsonFile         string
	PresubmitYmlFile       string
	ModuleVersionFiles     []string
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

	if cfg.ModuleMetadataFile == "" {
		return fmt.Errorf("metadata.json file is required")
	}
	if cfg.OutputFile == "" {
		return fmt.Errorf("output_file is required")
	}
	if len(cfg.ModuleVersionFiles) == 0 {
		return fmt.Errorf("module_version_file list must not be empty (positional args)")
	}

	var module bzpb.Module

	metadata, err := metadatajson.ReadFile(cfg.ModuleMetadataFile)
	if err != nil {
		return fmt.Errorf("failed to read %s: %v", cfg.ModuleMetadataFile, err)
	}
	module.Metadata = metadata

	if cfg.RepositoryMetadataFile != "" {
		md, err := repositorymetadatajson.ReadFile(cfg.RepositoryMetadataFile)
		if err != nil {
			return fmt.Errorf("failed to read %s: %v", cfg.RepositoryMetadataFile, err)
		}
		module.RepositoryMetadata = md
	}

	for _, file := range cfg.ModuleVersionFiles {
		var version bzpb.ModuleVersion
		if err := protoutil.ReadFile(file, &version); err != nil {
			return fmt.Errorf("reading %s: %v", file, err)
		}
		module.Name = version.Name
		module.Versions = append(module.Versions, &version)
	}

	// Sort versions by commit date (newest first).  This is safe to sort by
	// string comparison here because the commit dates are in ISO 8601 format
	// (RFC3339), which is specifically designed to be lexicographically
	// sortable
	slices.SortFunc(module.Versions, func(a, b *bzpb.ModuleVersion) int {
		// Handle nil commits
		if a.Commit == nil && b.Commit == nil {
			return 0
		}
		if a.Commit == nil {
			return 1 // Put versions without commits at the end
		}
		if b.Commit == nil {
			return -1
		}

		// Compare dates (reverse order for newest first)
		if a.Commit.Date > b.Commit.Date {
			return -1
		}
		if a.Commit.Date < b.Commit.Date {
			return 1
		}
		return 0
	})

	// Write the compiled ModuleVersion to output file
	if err := protoutil.WriteFile(cfg.OutputFile, &module); err != nil {
		return fmt.Errorf("failed to write output file: %v", err)
	}

	// log.Printf("Successfully compiled module: %s", cfg.OutputFile)
	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.ModuleMetadataFile, "module_metadata_file", "", "the metadata.json file to read (required)")
	fs.StringVar(&cfg.RepositoryMetadataFile, "repository_metadata_file", "", "the repository.json file to read (optional)")
	fs.StringVar(&cfg.OutputFile, "output_file", "", "the output file to write")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s @PARAMS_FILE", toolName)
		fs.PrintDefaults()
	}

	if err = fs.Parse(args); err != nil {
		return
	}

	cfg.ModuleVersionFiles = fs.Args()

	return
}
