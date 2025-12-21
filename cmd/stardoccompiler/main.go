package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	bzpb "github.com/stackb/centrl/build/stack/bazel/registry/v1"
	"github.com/stackb/centrl/pkg/protoutil"
	"github.com/stackb/centrl/pkg/stardoc"
	sdpb "github.com/stackb/centrl/stardoc_output"
)

const toolName = "stardoccompiler"

type Config struct {
	OutputFile string
	Files      []string
}

func main() {
	log.SetPrefix(toolName + ": ")
	log.SetOutput(os.Stderr)
	log.SetFlags(0)

	if err := run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}

func run(args []string) error {
	cfg, err := parseFlags(args)
	if err != nil {
		return fmt.Errorf("failed to parse args: %w", err)
	}

	result := &bzpb.DocumentationInfo{
		Source: bzpb.DocumentationSource_PUBLISHED,
	}

	for _, file := range cfg.Files {
		var module sdpb.ModuleInfo
		if err := protoutil.ReadFile(file, &module); err != nil {
			return fmt.Errorf("reading %s: %v", file, err)
		}
		fileInfo := stardoc.ModuleInfoToFileInfo(&module)
		result.File = append(result.File, fileInfo)
	}

	if err := protoutil.WriteFile(cfg.OutputFile, result); err != nil {
		return fmt.Errorf("failed to write output file: %v", err)
	}

	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.OutputFile, "output_file", "", "the output file to write")

	if err = fs.Parse(args); err != nil {
		return
	}

	cfg.Files = fs.Args()

	if cfg.OutputFile == "" {
		return cfg, fmt.Errorf("output_file is required")
	}

	if len(cfg.Files) == 0 {
		return cfg, fmt.Errorf("at least one asset is required")
	}

	return
}
