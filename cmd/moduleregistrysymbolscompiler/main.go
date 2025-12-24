package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	sympb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/symbol/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

const toolName = "moduleregistrysymbolscompiler"

type config struct {
	outputFile string
	inputFiles moduleVersionSymbolsFileSlice
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

	result := &sympb.ModuleRegistrySymbols{}

	for _, file := range cfg.inputFiles {
		var symbols sympb.ModuleVersionSymbols
		if err := protoutil.ReadFile(file.path, &symbols); err != nil {
			return fmt.Errorf("reading %s: %v", file, err)
		}
		symbols.ModuleName = file.moduleName
		symbols.Version = file.moduleVersion
		result.ModuleVersion = append(result.ModuleVersion, &symbols)
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

type moduleVersionSymbolsFile struct {
	moduleName    string
	moduleVersion string
	path          string
}

// moduleVersionSymbolsFileSlice is a custom flag type for repeatable --input_file flags
type moduleVersionSymbolsFileSlice []*moduleVersionSymbolsFile

func (s *moduleVersionSymbolsFileSlice) String() string {
	var parts []string
	for _, f := range *s {
		parts = append(parts, fmt.Sprintf("%s@%s=%s", f.moduleName, f.moduleVersion, f.path))
	}
	return strings.Join(parts, ",")
}

func (s *moduleVersionSymbolsFileSlice) Set(value string) error {
	chunks := strings.SplitN(value, "=", 2)
	if len(chunks) != 2 {
		return fmt.Errorf("invalid input_file format %q, expected MODULE_ID=PATH", value)
	}

	moduleID := chunks[0]
	parts := strings.SplitN(moduleID, "@", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid moduleID format %q, expected NAME@VERSION", moduleID)
	}
	*s = append(*s, &moduleVersionSymbolsFile{
		moduleName:    parts[0],
		moduleVersion: parts[1],
		path:          chunks[1],
	})

	return nil
}
