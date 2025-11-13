package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"slices"
	"strings"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/metadatajson"
	"github.com/stackb/centrl/pkg/paramsfile"
	"github.com/stackb/centrl/pkg/protoutil"
)

const toolName = "modulecompiler"

type Config struct {
	OutputFile         string
	ModuleMetadataFile string
	SourceJsonFile     string
	PresubmitYmlFile   string
	ModuleVersionFiles []string
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

	// Read source.json file (optional)
	if cfg.ModuleMetadataFile != "" {
		metadata, err := metadatajson.ReadFile(cfg.ModuleMetadataFile)
		if err != nil {
			return fmt.Errorf("failed to read %s: %v", cfg.ModuleMetadataFile, err)
		}
		module.Metadata = metadata
		module.AvatarUrl = githubOrgAvatarUrl(metadata.Repository)
	}

	for _, file := range cfg.ModuleVersionFiles {
		var version bzpb.ModuleVersion
		if err := protoutil.ReadFile(file, &version); err != nil {
			return fmt.Errorf("reading %s: %v", file, err)
		}
		module.Name = version.Name
		module.Versions = append(module.Versions, &version)
	}
	slices.Reverse(module.Versions)

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

func githubOrgAvatarUrl(repositories []string) string {
	for _, repo := range repositories {
		orgName := strings.TrimPrefix(repo, "github:")
		if orgName == repo {
			continue
		}
		parts := strings.SplitN(orgName, "/", 2)
		return "https://github.com/" + parts[0] + ".png"
	}
	return "https://github.com/bazelbuild.png"
}
