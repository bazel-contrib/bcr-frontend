package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"github.com/stackb/centrl/pkg/modulebazel"
	"github.com/stackb/centrl/pkg/paramsfile"
	"github.com/stackb/centrl/pkg/presubmityml"
	"github.com/stackb/centrl/pkg/protoutil"
	"github.com/stackb/centrl/pkg/sourcejson"
)

const toolName = "moduleversioncompiler"

type Config struct {
	OutputFile       string
	ModuleBazelFile  string
	SourceJsonFile   string
	PresubmitYmlFile string
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
	log.Println("args:", args)

	cwd, _ := os.Getwd()
	log.Println("cwd:", cwd)

	ListFiles(cwd)
	parsedArgs, err := paramsfile.ReadArgsParamsFile(args)
	log.Println("parsedArgs:", parsedArgs)
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
	module, err := modulebazel.ReadFile(cfg.ModuleBazelFile)
	if err != nil {
		return fmt.Errorf("failed to read MODULE.bazel: %v", err)
	}

	// Read source.json file (optional)
	if cfg.SourceJsonFile != "" {
		source, err := sourcejson.ReadFile(cfg.SourceJsonFile)
		if err != nil {
			return fmt.Errorf("failed to read source.json: %v", err)
		}
		module.Source = source
	}

	// Read presubmit.yml file (optional)
	if cfg.PresubmitYmlFile != "" {
		presubmit, err := presubmityml.ReadFile(cfg.PresubmitYmlFile)
		if err != nil {
			return fmt.Errorf("failed to read presubmit.yml: %v", err)
		}
		module.Presubmit = presubmit
	}

	// Write the compiled ModuleVersion to output file
	if err := protoutil.WriteFile(cfg.OutputFile, module); err != nil {
		return fmt.Errorf("failed to write output file: %v", err)
	}

	log.Printf("Successfully compiled module version to %s", cfg.OutputFile)
	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.ModuleBazelFile, "module_bazel_file", "", "the MODULE.bazel file to read (required)")
	fs.StringVar(&cfg.SourceJsonFile, "source_json_file", "", "the source.json file to read (optional)")
	fs.StringVar(&cfg.PresubmitYmlFile, "presubmit_yml_file", "", "the presubmit.yml file to read (optional)")
	fs.StringVar(&cfg.OutputFile, "output_file", "", "the output file to write")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s @PARAMS_FILE", toolName)
		fs.PrintDefaults()
	}

	if err = fs.Parse(args); err != nil {
		return
	}

	return
}

// ListFiles is a convenience debugging function to log the files under a given dir.
func ListFiles(dir string) error {
	log.Println("Listing files under " + dir)
	return filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			log.Printf("%v\n", err)
			return err
		}
		log.Println(path)
		return nil
	})
}
