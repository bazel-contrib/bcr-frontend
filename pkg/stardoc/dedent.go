package stardoc

import (
	"regexp"
	"strings"
)

var (
	whitespaceOnly    = regexp.MustCompile("(?m)^[ \t]+$")
	leadingWhitespace = regexp.MustCompile("(?m)(^[ \t]*)(?:[^ \t\n])")
)

// Dedent removes any common leading whitespace from every line in text.
//
// This can be used to make multiline strings to line up with the left edge of
// the display, while still presenting them in the source code in indented
// form.
//
// If the first line has no indentation but subsequent lines do, the margin
// is calculated from the subsequent lines only, ignoring the first line.
//
// Based on github.com/lithammer/dedent (MIT License)
func Dedent(text string) string {
	var margin string

	text = whitespaceOnly.ReplaceAllString(text, "")
	indents := leadingWhitespace.FindAllStringSubmatch(text, -1)

	if len(indents) == 0 {
		return text
	}

	// Check if first line has no indentation
	firstLineNoIndent := len(indents) > 0 && indents[0][1] == ""

	// Look for the longest leading string of spaces and tabs common to all
	// lines (skipping first line if it has no indentation).
	startIdx := 0
	if firstLineNoIndent {
		startIdx = 1
	}

	for i := startIdx; i < len(indents); i++ {
		indent := indents[i]
		if i == startIdx {
			margin = indent[1]
		} else if strings.HasPrefix(indent[1], margin) {
			// Current line more deeply indented than previous winner:
			// no change (previous winner is still on top).
			continue
		} else if strings.HasPrefix(margin, indent[1]) {
			// Current line consistent with and no deeper than previous winner:
			// it's the new winner.
			margin = indent[1]
		} else {
			// Current line and previous winner have no common whitespace:
			// there is no margin.
			margin = ""
			break
		}
	}

	if margin != "" {
		text = regexp.MustCompile("(?m)^"+margin).ReplaceAllString(text, "")
	}
	return text
}
