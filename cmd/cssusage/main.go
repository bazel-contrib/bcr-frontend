// Command cssusage scans a set of source files for class-name tokens that
// also appear as selectors in a reference CSS file, then emits the sorted
// unique intersection. The output feeds cmd/csspurge so it can drop CSS
// rules whose selector classes are never referenced from project code.
//
// Intersecting with the CSS's own class set (rather than running a
// permissive identifier scan against project sources) sidesteps the
// "what counts as a Primer class" categorization problem — any class name
// in primer.css that we never reference is a candidate for removal; any
// class name we reference that primer.css doesn't define is irrelevant.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"log"
	"os"
	"regexp"
	"sort"
	"strings"
)

type stringSlice []string

func (s *stringSlice) String() string { return strings.Join(*s, ",") }
func (s *stringSlice) Set(v string) error {
	*s = append(*s, v)
	return nil
}

const toolName = "cssusage"

func main() {
	log.SetPrefix(toolName + ": ")
	log.SetOutput(os.Stderr)
	log.SetFlags(0)
	if err := run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}

func run(args []string) error {
	var (
		cssFile    string
		sources    stringSlice
		safelist   string
		outputFile string
	)
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cssFile, "css", "", "reference CSS file — its class selectors define the universe of considered names")
	fs.Var(&sources, "source", "project source file to scan for class-name references (repeatable)")
	fs.StringVar(&safelist, "safelist", "", "optional file with extra class names to keep, one per line")
	fs.StringVar(&outputFile, "output", "", "output path for the sorted unique class-name list")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if cssFile == "" {
		return fmt.Errorf("--css is required")
	}
	if outputFile == "" {
		return fmt.Errorf("--output is required")
	}

	cssClasses, err := classesFromCSS(cssFile)
	if err != nil {
		return fmt.Errorf("scanning CSS %s: %v", cssFile, err)
	}

	usedSet := make(map[string]bool, len(cssClasses))
	for _, src := range sources {
		used, err := classesFromSource(src, cssClasses)
		if err != nil {
			return fmt.Errorf("scanning source %s: %v", src, err)
		}
		for k := range used {
			usedSet[k] = true
		}
	}
	if safelist != "" {
		if err := mergeSafelist(safelist, usedSet); err != nil {
			return fmt.Errorf("reading safelist %s: %v", safelist, err)
		}
	}

	out := make([]string, 0, len(usedSet))
	for k := range usedSet {
		out = append(out, k)
	}
	sort.Strings(out)

	return writeLines(outputFile, out)
}

// classesFromCSS extracts every `.classname` token from a CSS file. The
// regex matches anywhere a class selector can appear — it doesn't validate
// CSS structure, just collects identifiers immediately following a dot.
// Two-class compound selectors (e.g. `.Box.Box--condensed`) yield both
// names independently.
func classesFromCSS(path string) (map[string]bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	re := regexp.MustCompile(`\.([A-Za-z_][A-Za-z0-9_-]*)`)
	out := make(map[string]bool)
	for _, m := range re.FindAllSubmatch(data, -1) {
		out[string(m[1])] = true
	}
	return out, nil
}

// classesFromSource scans a project file for identifiers that match any
// of `universe`. Whitespace-bounded tokens AND quoted-string tokens both
// qualify — covers `class="Box btn"` in HTML and `"Box"` literals in JS.
//
// The token regex is permissive: anything matching the same identifier
// shape we used on the CSS side. We then intersect with `universe` to
// drop noise (variable names, function names, identifiers that happen to
// share shape but aren't Primer classes).
func classesFromSource(path string, universe map[string]bool) (map[string]bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	re := regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_-]*`)
	out := make(map[string]bool)
	for _, m := range re.FindAll(data, -1) {
		s := string(m)
		if universe[s] {
			out[s] = true
		}
	}
	return out, nil
}

// mergeSafelist reads one class name per line, ignoring blank lines and
// lines beginning with `#`. Entries are added to the set regardless of
// whether they appear in the CSS — explicit safelist beats heuristics.
func mergeSafelist(path string, dst map[string]bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		dst[line] = true
	}
	return sc.Err()
}

func writeLines(path string, lines []string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	for _, l := range lines {
		if _, err := w.WriteString(l); err != nil {
			return err
		}
		if err := w.WriteByte('\n'); err != nil {
			return err
		}
	}
	return w.Flush()
}
