package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	lgpb "github.com/bazel-contrib/bcr-frontend/build/stack/livegrep/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/codesearch"
	"github.com/junkblocker/codesearch/index"
)

type Config struct {
	Files        []string
	IndexFile    string
	ContextLines int
	Query        *lgpb.Query
}

func main() {
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

	idx := index.Open(cfg.IndexFile)

	w, err := codesearch.SearchIndex(cfg.IndexFile, idx, cfg.Query)
	if err != nil {
		return err
	}

	for _, result := range w.Results {
		log.Println()
		for i, line := range result.ContextBefore {
			lineNo := int(result.LineNumber) - len(result.ContextBefore) + i
			log.Printf("%s:%d | %s", result.Path, lineNo, line)
		}
		log.Printf("%s:%d > %s", result.Path, result.LineNumber, result.Line)
		for i, line := range result.ContextAfter {
			lineNo := int(result.LineNumber) + i + 1
			log.Printf("%s:%d | %s", result.Path, lineNo, line)
		}
	}

	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	fs := flag.NewFlagSet("codesearch", flag.ExitOnError)
	fs.StringVar(&cfg.IndexFile, "index", "", "the index to search")
	fs.IntVar(&cfg.ContextLines, "context", 3, "number of lines of context to display")

	if err = fs.Parse(args); err != nil {
		return
	}

	if cfg.IndexFile == "" {
		return cfg, fmt.Errorf("output_file is required")
	}

	cfg.Query = &lgpb.Query{}
	cfg.Query.Line = strings.Join(fs.Args(), " ")
	cfg.Query.ContextLines = int32(cfg.ContextLines)

	return
}
