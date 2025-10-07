package paramsfile

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// ReadArgsParamsFile reads the and maybe loads from the params file if the sole
// argument starts with '@'; if so args are loaded from that file.
func ReadArgsParamsFile(args []string) ([]string, error) {
	if len(args) != 1 {
		return args, nil
	}
	if !strings.HasPrefix(args[0], "@") {
		return args, nil
	}

	paramsFile := args[0][1:]
	var err error
	args, err = readParamsFile(paramsFile)
	if err != nil {
		return nil, fmt.Errorf("failed to read params file %s: %v", paramsFile, err)
	}
	return args, nil
}

func readParamsFile(filename string) ([]string, error) {
	params := []string{}
	f, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		params = append(params, trimQuotes(line))
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return params, nil
}

func trimQuotes(s string) string {
	if len(s) >= 2 {
		if c := s[len(s)-1]; s[0] == c && (c == '"' || c == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}
