// Command uiversion stamps the UI's git commit SHA into a JS template.
//
// Reads a Bazel workspace status file (typically `bazel-out/stable-status.txt`),
// extracts the value for STABLE_GIT_COMMIT, and substitutes occurrences of a
// placeholder in the template with that value. If the key is missing or empty,
// the placeholder is replaced with "unknown".
package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
)

const (
	statusKey   = "STABLE_GIT_COMMIT"
	placeholder = "__BCR_FRONTEND_COMMIT_SHA__"
	fallback    = "unknown"
)

func main() {
	log.SetPrefix("uiversion: ")
	log.SetFlags(0)

	var (
		infoFile     = flag.String("info_file", "", "path to bazel stable status file")
		templateFile = flag.String("template", "", "path to JS template containing the placeholder")
		outFile      = flag.String("out", "", "path to write the substituted JS file")
	)
	flag.Parse()

	if *infoFile == "" || *templateFile == "" || *outFile == "" {
		log.Fatalf("--info_file, --template, --out are all required")
	}

	commit, err := readStatusKey(*infoFile, statusKey)
	if err != nil {
		log.Fatalf("reading %s from %s: %v", statusKey, *infoFile, err)
	}
	if commit == "" {
		commit = fallback
	}

	tpl, err := os.ReadFile(*templateFile)
	if err != nil {
		log.Fatalf("reading template %s: %v", *templateFile, err)
	}

	out := strings.ReplaceAll(string(tpl), placeholder, commit)
	if err := os.WriteFile(*outFile, []byte(out), 0o644); err != nil {
		log.Fatalf("writing %s: %v", *outFile, err)
	}
}

// readStatusKey scans a Bazel workspace status file (one "KEY VALUE" pair per
// line, separated by the first space) and returns the value for the named key,
// or "" if the key is absent or has no value.
func readStatusKey(path, key string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		idx := strings.IndexByte(line, ' ')
		if idx <= 0 {
			continue
		}
		if line[:idx] != key {
			continue
		}
		return strings.TrimSpace(line[idx+1:]), nil
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("scanning: %w", err)
	}
	return "", nil
}
