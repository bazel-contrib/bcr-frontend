package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"slices"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/metadatajson"
	"github.com/bazel-contrib/bcr-frontend/pkg/paramsfile"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
	"github.com/bazel-contrib/bcr-frontend/pkg/repositorymetadatajson"
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

	// Sort versions according to moduleMetadata.Versions order (latest last),
	// then reverse to put latest first
	versionOrder := make(map[string]int)
	for i, v := range metadata.Versions {
		versionOrder[v] = i
	}

	slices.SortFunc(module.Versions, func(a, b *bzpb.ModuleVersion) int {
		aOrder, aExists := versionOrder[a.Version]
		bOrder, bExists := versionOrder[b.Version]

		// If version not in metadata, put at end
		if !aExists && !bExists {
			return 0
		}
		if !aExists {
			return 1
		}
		if !bExists {
			return -1
		}

		// Compare by metadata order (reversed - higher index = newer = comes first)
		return bOrder - aOrder
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
