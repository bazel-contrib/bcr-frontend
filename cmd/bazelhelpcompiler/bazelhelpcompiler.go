package main

import (
	"bufio"
	"bytes"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"regexp"
	"strings"

	bhpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/help/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

var (
	toolName           = "bazelhelpcompiler"
	helpFlagRegexp     = regexp.MustCompile(`(\t|  )--(?P<toggle>\[no\])?(?P<name>[-_a-z0-9]+)( (\[-(?P<short>[a-z])\] )?\((?P<type>[^;]+); (?P<default>[^)]+)\))?.*`)
	defaultValueRegexp = regexp.MustCompile(`default: "(?P<default>[^"]+)?"`)
)

type Config struct {
	Version    string
	OutputFile string
	InputFiles []string
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

	if cfg.OutputFile == "" {
		return fmt.Errorf("--output_file is required")
	}
	if cfg.Version == "" {
		return fmt.Errorf("--version is required")
	}
	if len(cfg.InputFiles) == 0 {
		return fmt.Errorf("at least one input file is required")
	}

	help, err := compileBazelHelpVersion(&cfg)
	if err != nil {
		return fmt.Errorf("failed to compile help: %w", err)
	}

	if err := protoutil.WriteFile(cfg.OutputFile, help); err != nil {
		return fmt.Errorf("failed to write output: %w", err)
	}

	log.Printf("Compiled %d help categories to %s", len(cfg.InputFiles), cfg.OutputFile)
	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.OutputFile, "output_file", "", "path to the output BazelHelp protobuf file")
	fs.StringVar(&cfg.Version, "version", "", "bazel version")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s [options] <input_file>...\n", toolName)
		fs.PrintDefaults()
	}

	if err = fs.Parse(args); err != nil {
		return
	}

	// Remaining args are input files
	cfg.InputFiles = fs.Args()

	return
}

func compileBazelHelpVersion(cfg *Config) (*bhpb.BazelHelpVersion, error) {
	help := bhpb.BazelHelpVersion{
		Version: cfg.Version,
	}

	for _, inputFile := range cfg.InputFiles {
		category, err := parseHelpFileForCommand(inputFile)
		if err != nil {
			return nil, fmt.Errorf("failed to parse %s: %w", inputFile, err)
		}
		help.Command = append(help.Command, category)
	}

	return &help, nil
}

func parseHelpFileForCommand(filename string) (*bhpb.BazelHelpCommand, error) {
	content, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	return parseHelp(bytes.NewReader(content)), nil
}

func parseHelp(in io.Reader) *bhpb.BazelHelpCommand {
	cmd := &bhpb.BazelHelpCommand{}
	scanner := bufio.NewScanner(in)

	mode := bhpb.BazelHelpParseMode_USAGE
	var category *bhpb.BazelHelpCategory
	var currentFlag *bhpb.BazelOption
	var previousLine string

	for scanner.Scan() {
		line := scanner.Text()

		switch mode {
		case bhpb.BazelHelpParseMode_USAGE:
			if isOptionLine(line) {
				// Previous line is the category title
				category = &bhpb.BazelHelpCategory{Title: previousLine}
				cmd.Category = append(cmd.Category, category)

				currentFlag = newFlag(line, category)
				if currentFlag.Name == "" {
					log.Printf("%sINVALID line: %q", toolName, line)
				}
				mode = bhpb.BazelHelpParseMode_FLAG
			} else {
				cmd.Usage = append(cmd.Usage, line)
			}

		case bhpb.BazelHelpParseMode_FLAG:
			if line == "" {
				// Blank line indicates end of category
				mode = bhpb.BazelHelpParseMode_USAGE
				category = nil
				currentFlag = nil
			} else if isOptionLine(line) {
				// New flag in same category
				currentFlag = newFlag(line, category)
			} else if currentFlag != nil {
				// Continuation of current flag description
				currentFlag.Description = append(currentFlag.Description, line)
			}
		}

		previousLine = line
	}

	extractTags(cmd)
	return cmd
}

func isOptionLine(line string) bool {
	return strings.HasPrefix(line, "\t--") || strings.HasPrefix(line, "  --")
}

func extractTags(cmd *bhpb.BazelHelpCommand) {
	for _, category := range cmd.Category {
		for _, option := range category.Option {
			for i, line := range option.Description {
				if !strings.Contains(line, "Tags: ") {
					continue
				}

				// Join remaining lines and extract tags
				tagLine := strings.Join(option.Description[i:], "")
				tagLine = strings.TrimSpace(tagLine)
				tagLine = strings.TrimPrefix(tagLine, "Tags: ")

				tags := strings.Split(tagLine, ", ")
				for j := range tags {
					tags[j] = strings.TrimSpace(tags[j])
				}

				option.Tag = append(option.Tag, tags...)
				option.Description = option.Description[:i]
				break
			}
		}
	}
}

func newFlag(line string, category *bhpb.BazelHelpCategory) *bhpb.BazelOption {
	matches := regexpMatch(helpFlagRegexp, line)
	if matches == nil {
		matches = make(map[string]string)
	}

	optionType := normalizeType(matches["type"])
	defaultValue := normalizeDefault(matches["default"])

	option := &bhpb.BazelOption{
		Name:    matches["name"],
		Type:    optionType,
		Default: defaultValue,
		Short:   matches["short"],
		Toggle:  matches["toggle"] != "",
	}

	category.Option = append(category.Option, option)
	return option
}

func normalizeType(t string) string {
	t = strings.TrimPrefix(t, "an ")
	t = strings.TrimPrefix(t, "a ")
	return t
}

func normalizeDefault(defaultValue string) string {
	if defaultValue == "" {
		return ""
	}

	// Try to extract quoted default value
	if matches := regexpMatch(defaultValueRegexp, defaultValue); matches != nil {
		if extracted := matches["default"]; extracted != "" {
			return extracted
		}
	}

	// Handle special case
	if defaultValue == `default: ""` {
		return `""`
	}

	return defaultValue
}

func regexpMatch(r *regexp.Regexp, str string) map[string]string {
	match := r.FindStringSubmatch(str)
	if match == nil {
		return nil
	}

	result := make(map[string]string)
	for i, name := range r.SubexpNames() {
		if i > 0 && name != "" {
			result[name] = match[i]
		}
	}

	return result
}
