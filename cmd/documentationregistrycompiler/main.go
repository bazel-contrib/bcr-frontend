package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/protoutil"
)

const toolName = "documentationregistrycompiler"

type config struct {
	outputFile string
	inputFiles documentationInfoFileSlice
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

	result := &bzpb.DocumentationRegistry{}

	for _, file := range cfg.inputFiles {
		var doc bzpb.DocumentationInfo
		if err := protoutil.ReadFile(file.path, &doc); err != nil {
			return fmt.Errorf("reading %s: %v", file, err)
		}
		doc.ModuleName = file.moduleName
		doc.Version = file.moduleVersion
		result.Documentation = append(result.Documentation, &doc)
	}

	if err := protoutil.WriteFile(cfg.outputFile, result); err != nil {
		return fmt.Errorf("failed to write output file: %v", err)
	}

	return nil
}

func parseFlags(args []string) (cfg config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.outputFile, "output_file", "", "the output file to write")
	fs.Var(&cfg.inputFiles, "input_file", "a generated documentationinfo.pb file, with associated moduleID")

	if err = fs.Parse(args); err != nil {
		return
	}

	if cfg.outputFile == "" {
		return cfg, fmt.Errorf("output_file is required")
	}

	return
}

type documentationInfoFile struct {
	moduleName    string
	moduleVersion string
	path          string
}

// documentationInfoFileSlice is a custom flag type for repeatable --input_file flags
type documentationInfoFileSlice []*documentationInfoFile

func (s *documentationInfoFileSlice) String() string {
	var parts []string
	for _, f := range *s {
		parts = append(parts, fmt.Sprintf("%s@%s=%s", f.moduleName, f.moduleVersion, f.path))
	}
	return strings.Join(parts, ",")
}

func (s *documentationInfoFileSlice) Set(value string) error {
	chunks := strings.SplitN(value, "=", 2)
	if len(chunks) != 2 {
		return fmt.Errorf("invalid input_file format %q, expected MODULE_ID=PATH", value)
	}

	moduleID := chunks[0]
	parts := strings.SplitN(moduleID, "@", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid moduleID format %q, expected NAME@VERSION", moduleID)
	}
	*s = append(*s, &documentationInfoFile{
		moduleName:    parts[0],
		moduleVersion: parts[1],
		path:          chunks[1],
	})

	return nil
}
