package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	bzpb "github.com/stackb/centrl/build/stack/bazel/registry/v1"
	"github.com/stackb/centrl/pkg/protoutil"
)

var (
	toolName = "bazelhelpregistrycompiler"
)

type Config struct {
	OutputFile string
	InputFiles []string
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

	if cfg.OutputFile == "" {
		return fmt.Errorf("--output_file is required")
	}
	if len(cfg.InputFiles) == 0 {
		return fmt.Errorf("at least one input file is required")
	}

	var registry bzpb.BazelHelpRegistry

	for _, filename := range cfg.InputFiles {
		var version bzpb.BazelHelpVersion
		if err := protoutil.ReadFile(filename, &version); err != nil {
			return err
		}
		registry.Version = append(registry.Version, &version)
	}

	if err := protoutil.WriteFile(cfg.OutputFile, &registry); err != nil {
		return fmt.Errorf("failed to write output: %w", err)
	}

	log.Printf("Compiled %d help categories to %s", len(cfg.InputFiles), cfg.OutputFile)
	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.OutputFile, "output_file", "", "path to the output BazelHelp protobuf file")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s [options] <input_file>...\n", toolName)
		fs.PrintDefaults()
	}

	if err = fs.Parse(args); err != nil {
		return
	}

	// Remaining args are input files
	cfg.InputFiles = fs.Args()

	return
}
