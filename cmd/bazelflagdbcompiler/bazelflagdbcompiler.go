// Command bazelflagdbcompiler reads a BazelHelpRegistry (the version × command
// × flag tree produced by bazelhelpregistrycompiler) and emits a flag-centric
// inventory: for each unique flag, the bazel versions where it appears, the
// subcommands it accepts, and canonical metadata (description, type, default,
// category, tags) drawn from the latest version that exposes the flag.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"

	bhpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/help/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

const toolName = "bazelflagdbcompiler"

type config struct {
	outputFile string
	inputFile  string
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
		return err
	}
	if cfg.outputFile == "" {
		return fmt.Errorf("--output_file is required")
	}
	if cfg.inputFile == "" {
		return fmt.Errorf("input bazelhelpregistry.pb is required (positional arg)")
	}

	var registry bhpb.BazelHelpRegistry
	if err := protoutil.ReadFile(cfg.inputFile, &registry); err != nil {
		return fmt.Errorf("read input: %w", err)
	}

	db := buildFlagDb(&registry)

	if err := protoutil.WriteFile(cfg.outputFile, db); err != nil {
		return fmt.Errorf("write output: %w", err)
	}

	log.Printf("compiled %d flags across %d bazel versions to %s",
		len(db.Flag), len(db.BazelVersions), cfg.outputFile)
	return nil
}

func parseFlags(args []string) (cfg config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.outputFile, "output_file", "", "path to the output BazelFlagDb protobuf file")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s --output_file <out> <bazelhelpregistry.pb>\n", toolName)
		fs.PrintDefaults()
	}
	if err = fs.Parse(args); err != nil {
		return
	}
	rest := fs.Args()
	if len(rest) > 1 {
		return cfg, fmt.Errorf("expected exactly one positional argument, got %d", len(rest))
	}
	if len(rest) == 1 {
		cfg.inputFile = rest[0]
	}
	return
}

// buildFlagDb constructs the per-flag inventory. The shared bazel_versions
// table is sorted ascending using semver. Each flag references that table by
// index. Canonical metadata (description, type, default, category, etc.) is
// taken from the LATEST version where the flag appears; tags are unioned.
func buildFlagDb(registry *bhpb.BazelHelpRegistry) *bhpb.BazelFlagDb {
	versions := make([]*bhpb.BazelHelpVersion, 0, len(registry.Version))
	versions = append(versions, registry.Version...)
	sort.Slice(versions, func(i, j int) bool {
		return semverLess(versions[i].Version, versions[j].Version)
	})

	versionTable := make([]string, len(versions))
	for i, v := range versions {
		versionTable[i] = v.Version
	}

	// First pass: collect every distinct command name across the registry so
	// we can build the shared command table BazelFlag.command_index references.
	commandSet := make(map[string]struct{})
	for _, version := range versions {
		for _, cmd := range version.Command {
			if cmd.Command != "" {
				commandSet[cmd.Command] = struct{}{}
			}
		}
	}
	commandTable := keysSorted(commandSet)
	commandIndex := make(map[string]int, len(commandTable))
	for i, c := range commandTable {
		commandIndex[c] = i
	}

	type aggState struct {
		commands     map[int]struct{}
		versionIdxes map[int]struct{}
		canonical    *bhpb.BazelOption
		category     string
		tags         map[string]struct{}
	}
	flags := make(map[string]*aggState)

	for vi, version := range versions {
		for _, cmd := range version.Command {
			ci, hasCmd := commandIndex[cmd.Command]
			for _, cat := range cmd.Category {
				for _, opt := range cat.Option {
					if opt.Name == "" {
						continue
					}
					st, ok := flags[opt.Name]
					if !ok {
						st = &aggState{
							commands:     make(map[int]struct{}),
							versionIdxes: make(map[int]struct{}),
							tags:         make(map[string]struct{}),
						}
						flags[opt.Name] = st
					}
					if hasCmd {
						st.commands[ci] = struct{}{}
					}
					st.versionIdxes[vi] = struct{}{}
					for _, t := range opt.Tag {
						st.tags[t] = struct{}{}
					}
					// versions iterated ascending; last wins for canonical metadata.
					st.canonical = opt
					// Bazel's help output prints category titles as headings
					// like "Options that control build execution:" — useful as
					// a section break in raw output, awkward as a subtitle in
					// the UI. Strip the trailing colon (and any whitespace).
					st.category = strings.TrimRight(strings.TrimSpace(cat.Title), ":")
				}
			}
		}
	}

	out := &bhpb.BazelFlagDb{
		BazelVersions: versionTable,
		Commands:      commandTable,
	}

	names := make([]string, 0, len(flags))
	for name := range flags {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		st := flags[name]
		tags := keysSorted(st.tags)

		versionIdx32 := sortedIntsAsInt32(st.versionIdxes)
		commandIdx32 := sortedIntsAsInt32(st.commands)

		flag := &bhpb.BazelFlag{
			Name:         st.canonical.Name,
			Short:        st.canonical.Short,
			Type:         st.canonical.Type,
			Default:      st.canonical.Default,
			Toggle:       st.canonical.Toggle,
			Description:  append([]string(nil), st.canonical.Description...),
			Tag:          tags,
			VersionIndex: versionIdx32,
			CommandIndex: commandIdx32,
			Category:     st.category,
		}
		out.Flag = append(out.Flag, flag)
	}

	return out
}

func sortedIntsAsInt32(set map[int]struct{}) []int32 {
	out := make([]int, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Ints(out)
	out32 := make([]int32, len(out))
	for i, v := range out {
		out32[i] = int32(v)
	}
	return out32
}

func keysSorted(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// semverLess compares two simple "X.Y.Z" version strings. Non-digit suffixes
// are not expected here (the upstream filter only allows pure-digit triples)
// but we tolerate them by falling back to lexical ordering when parsing fails.
func semverLess(a, b string) bool {
	ap, aok := parseSemver(a)
	bp, bok := parseSemver(b)
	if aok && bok {
		for i := 0; i < 3; i++ {
			if ap[i] != bp[i] {
				return ap[i] < bp[i]
			}
		}
		return false
	}
	return a < b
}

func parseSemver(v string) ([3]int, bool) {
	parts := strings.SplitN(v, ".", 3)
	if len(parts) != 3 {
		return [3]int{}, false
	}
	out := [3]int{}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}
