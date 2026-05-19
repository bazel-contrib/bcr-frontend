// attestationscompiler reads a module-version's attestations.json plus any
// fetched .intoto.jsonl bundles, parses each bundle into an AttestationPayload,
// and writes a compiled Attestations proto to --output_file.
//
// In PR 2 no .intoto.jsonl files are passed in (Gazelle does not yet fetch
// them); the tool effectively translates attestations.json into proto form
// with empty payloads. PR 3 wires the fetched bundles through.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/attestationsjson"
	"github.com/bazel-contrib/bcr-frontend/pkg/intoto"
	"github.com/bazel-contrib/bcr-frontend/pkg/paramsfile"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

const toolName = "attestationscompiler"

type Config struct {
	AttestationsJsonFile string
	IntotoFiles          []string // "<filename>=<path>" entries
	OutputFile           string
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
	parsedArgs, err := paramsfile.ReadArgsParamsFile(args)
	if err != nil {
		return fmt.Errorf("failed to read params file: %v", err)
	}

	cfg, err := parseFlags(parsedArgs)
	if err != nil {
		return fmt.Errorf("failed to parse args: %v", err)
	}
	if cfg.AttestationsJsonFile == "" {
		return fmt.Errorf("attestations_json_file is required")
	}
	if cfg.OutputFile == "" {
		return fmt.Errorf("output_file is required")
	}

	att, err := attestationsjson.ReadFile(cfg.AttestationsJsonFile)
	if err != nil {
		return fmt.Errorf("reading attestations.json: %v", err)
	}
	if att.Attestations == nil {
		att.Attestations = map[string]*bzpb.Attestations_Attestation{}
	}

	for _, spec := range cfg.IntotoFiles {
		filename, path, ok := strings.Cut(spec, "=")
		if !ok || filename == "" || path == "" {
			return fmt.Errorf("invalid --intoto_file %q; want <filename>=<path>", spec)
		}
		entry, ok := att.Attestations[filename]
		if !ok || entry == nil {
			return fmt.Errorf("--intoto_file refers to unknown filename %q (not in attestations.json)", filename)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("reading %s: %v", path, err)
		}
		// NOTE: entry.Integrity is the SRI of the .intoto.jsonl bundle itself
		// (used by Bazel's http_file fetch for content-pinning), not of the
		// subject file being attested. Verifying that payload.SubjectSha256
		// matches the actual subject file (e.g. source.json) requires access
		// to that file's bytes, which the attestations compiler does not have
		// here; SubjectMatches stays false and is computed downstream.
		entry.Payload = intoto.Parse(data)
	}

	if err := protoutil.WriteFile(cfg.OutputFile, att); err != nil {
		return fmt.Errorf("writing output: %v", err)
	}
	return nil
}

// repeatedString is a flag.Value that accumulates each occurrence of a flag
// into a slice. Used for --intoto_file.
type repeatedString []string

func (r *repeatedString) String() string {
	if r == nil {
		return ""
	}
	return strings.Join(*r, ",")
}

func (r *repeatedString) Set(v string) error {
	*r = append(*r, v)
	return nil
}

func parseFlags(args []string) (Config, error) {
	var cfg Config
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.AttestationsJsonFile, "attestations_json_file", "", "the attestations.json source file (required)")
	fs.StringVar(&cfg.OutputFile, "output_file", "", "the output .pb file to write (required)")
	var intotoFiles repeatedString
	fs.Var(&intotoFiles, "intoto_file", "<filename>=<path>; repeated; provides a .intoto.jsonl file for the named attestation entry")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s @PARAMS_FILE\n", toolName)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	cfg.IntotoFiles = intotoFiles
	return cfg, nil
}
