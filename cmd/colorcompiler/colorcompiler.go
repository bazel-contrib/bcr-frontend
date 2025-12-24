package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/bazel-contrib/bcr-frontend/pkg/css"
	"github.com/bazel-contrib/bcr-frontend/pkg/paramsfile"
	"github.com/teacat/noire"
)

const toolName = "colorcompiler"

type Color struct {
	Hex string `json:"color"`
	URL string `json:"url"`
}

type Config struct {
	OutputFile         string
	ColorsJsonFile     string
	LanuguagesJsonFile string
	Colors             map[string]Color
	Languages          []string
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

	if cfg.OutputFile == "" {
		return fmt.Errorf("output_file is required")
	}
	if cfg.ColorsJsonFile == "" {
		return fmt.Errorf("colors_json_file is required")
	}
	if cfg.ColorsJsonFile == "" {
		return fmt.Errorf("languages_json_file is required")
	}

	// Parse colors.json into cfg.Colors
	colorsData, err := os.ReadFile(cfg.ColorsJsonFile)
	if err != nil {
		return fmt.Errorf("failed to read colors.json: %v", err)
	}
	if err := json.Unmarshal(colorsData, &cfg.Colors); err != nil {
		return fmt.Errorf("failed to parse colors.json: %v", err)
	}

	// Parse languages.json into cfg.Languages
	languagesData, err := os.ReadFile(cfg.LanuguagesJsonFile)
	if err != nil {
		return fmt.Errorf("failed to read languages.json: %v", err)
	}
	if err := json.Unmarshal(languagesData, &cfg.Languages); err != nil {
		return fmt.Errorf("failed to parse languages.json: %v", err)
	}

	var out strings.Builder

	// Write CSS custom properties for each language
	fmt.Fprintf(&out, ":root {\n")
	for _, lang := range cfg.Languages {
		if color, ok := cfg.Colors[lang]; ok {
			if color.Hex != "" {
				sanitizedLang := css.SanitizeIdentifier(lang)
				bgColor := noire.NewHex(color.Hex)
				fgColor := bgColor.Foreground()

				// Mute the foreground color by mixing it 80% with the background
				// This creates a softer, less stark contrast
				mutedFg := fmt.Sprintf("color-mix(in srgb, #%s 80%%, %s)", fgColor.Hex(), color.Hex)

				fmt.Fprintf(&out, "  --lang-%s-bg: %s;\n", sanitizedLang, color.Hex)
				fmt.Fprintf(&out, "  --lang-%s-fg: %s;\n", sanitizedLang, mutedFg)
			}
		} else {
			log.Println("warning: color not found for language:", lang)
		}
	}
	fmt.Fprintf(&out, "}\n\n")

	if err := os.WriteFile(cfg.OutputFile, []byte(out.String()), 0644); err != nil {
		return fmt.Errorf("failed to write output file: %v", err)
	}

	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.OutputFile, "output_file", "", "the output file to write")
	fs.StringVar(&cfg.ColorsJsonFile, "colors_json_file", "", "the colors.json file to read")
	fs.StringVar(&cfg.LanuguagesJsonFile, "languages_json_file", "", "the languages.json file to read")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s @PARAMS_FILE", toolName)
		fs.PrintDefaults()
	}

	if err = fs.Parse(args); err != nil {
		return
	}

	return
}
