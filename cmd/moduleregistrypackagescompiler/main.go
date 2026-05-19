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

const toolName = "moduleregistrypackagescompiler"

type config struct {
	outputFile      string
	inputFiles      moduleVersionPackagesFileSlice
	emptyModuleVers moduleVersionIDSlice
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

	result := &sympb.ModuleRegistryPackages{}

	for _, file := range cfg.inputFiles {
		var packages sympb.ModuleVersionPackages
		if err := protoutil.ReadFile(file.path, &packages); err != nil {
			return fmt.Errorf("reading %s: %v", file, err)
		}
		packages.ModuleName = file.moduleName
		packages.Version = file.moduleVersion
		result.ModuleVersion = append(result.ModuleVersion, &packages)
	}

	for _, id := range cfg.emptyModuleVers {
		result.ModuleVersion = append(result.ModuleVersion, &sympb.ModuleVersionPackages{
			ModuleName: id.moduleName,
			Version:    id.moduleVersion,
			Source:     sympb.SymbolSource_BEST_EFFORT,
		})
	}

	if err := protoutil.WriteFile(cfg.outputFile, result); err != nil {
		return fmt.Errorf("failed to write output file: %v", err)
	}

	return nil
}

func parseFlags(args []string) (cfg config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.outputFile, "output_file", "", "the output file to write")
	fs.Var(&cfg.inputFiles, "input_file", "a generated packagesinfo.pb file, with associated moduleID")
	fs.Var(&cfg.emptyModuleVers, "empty", "a module version ID (NAME@VERSION) to record as a stub empty BEST_EFFORT entry; repeatable")

	if err = fs.Parse(args); err != nil {
		return
	}

	if cfg.outputFile == "" {
		return cfg, fmt.Errorf("output_file is required")
	}

	return
}

type moduleVersionPackagesFile struct {
	moduleName    string
	moduleVersion string
	path          string
}

type moduleVersionPackagesFileSlice []*moduleVersionPackagesFile

func (s *moduleVersionPackagesFileSlice) String() string {
	var parts []string
	for _, f := range *s {
		parts = append(parts, fmt.Sprintf("%s@%s=%s", f.moduleName, f.moduleVersion, f.path))
	}
	return strings.Join(parts, ",")
}

func (s *moduleVersionPackagesFileSlice) Set(value string) error {
	chunks := strings.SplitN(value, "=", 2)
	if len(chunks) != 2 {
		return fmt.Errorf("invalid input_file format %q, expected MODULE_ID=PATH", value)
	}

	moduleID := chunks[0]
	parts := strings.SplitN(moduleID, "@", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid moduleID format %q, expected NAME@VERSION", moduleID)
	}
	*s = append(*s, &moduleVersionPackagesFile{
		moduleName:    parts[0],
		moduleVersion: parts[1],
		path:          chunks[1],
	})

	return nil
}

type moduleVersionID struct {
	moduleName    string
	moduleVersion string
}

type moduleVersionIDSlice []moduleVersionID

func (s *moduleVersionIDSlice) String() string {
	var parts []string
	for _, id := range *s {
		parts = append(parts, fmt.Sprintf("%s@%s", id.moduleName, id.moduleVersion))
	}
	return strings.Join(parts, ",")
}

func (s *moduleVersionIDSlice) Set(value string) error {
	parts := strings.SplitN(value, "@", 2)
	if len(parts) != 2 {
		return fmt.Errorf("invalid empty format %q, expected NAME@VERSION", value)
	}
	*s = append(*s, moduleVersionID{moduleName: parts[0], moduleVersion: parts[1]})
	return nil
}
