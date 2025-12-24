// codesearch.go contains common functions when dealing with indexes.
package codesearch

import (
	"bufio"
	"bytes"
	"fmt"
	"log"
	"os"
	stdRegexp "regexp"
	"strconv"

	"github.com/junkblocker/codesearch/index"
	"github.com/junkblocker/codesearch/regexp"
	"github.com/samthor/sre2"

	lgpb "github.com/bazel-contrib/bcr-frontend/build/stack/livegrep/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/status"
)

var lineNoRegexp = stdRegexp.MustCompile(`:[0-9]+:`)

func OpenIndex(filename string) *index.Index {
	// Set this in case the file index is corrupt; user will get a more accurate
	// error message
	os.Setenv("CSEARCHINDEX", filename)

	return index.Open(filename)
}

func IndexFiles(filename string, iw *index.IndexWriter, filenames []string) {
	for _, filename := range filenames {
		iw.AddFile(filename)
	}
	iw.Flush()
	iw.Close()
}

func SearchIndex(indexName string, ix *index.Index, req *lgpb.Query) (*lgpb.CodeSearchResult, error) {

	var stdout bytes.Buffer

	g := regexp.Grep{
		Stdout: &stdout,
		Stderr: os.Stderr,
	}
	g.N = true // print line numbers

	pat := getRegexpPattern(req.Line, req.FoldCase)
	re, err := regexp.Compile(pat)
	if err != nil {
		return nil, status.InvalidArgumentErrorf("could not compile regexp: %v", pat)
	}
	g.Regexp = re
	if req.MaxMatches > 0 {
		g.LimitPrintCount(int64(req.MaxMatches), int64(req.MaxMatches))
	}

	q := index.RegexpQuery(re.Syntax)

	files := ix.PostingQuery(q)

	for _, fileid := range files {
		name := ix.Name(fileid)
		g.File(name)
		// short circuit here too
		if g.Done {
			break
		}
	}

	csr := &lgpb.CodeSearchResult{
		IndexName: indexName,
	}

	if !g.Match {
		return csr, nil
	}

	// at this point we know there are matches.  In order to populate the search
	// results with Bounds, we have to do extra work.  After looking through
	// google/codesearch repo, I was not able to determine a simple way to
	// extract or reconstruct the indices of each match using either the Grep,
	// Regexp, or Index structs.  So, we'll re-compile the regexp using a
	// different re2 library and run the regexp against pre-matched lines.
	re2, errMsg := sre2.Parse(pat)
	if errMsg != nil {
		log.Printf("WARN: could not parse re2 expression %q: %v", pat, *errMsg)
		return nil, status.FailedPreconditionErrorf("could not compile regexp: %v", errMsg)
	}

	scanner := bufio.NewScanner(&stdout)

	for scanner.Scan() {
		line := scanner.Text()
		sr, err := makeSearchResult(line)
		if err != nil {
			return nil, status.InternalErrorf("could not parse search result %q: %v", line, err)
		}

		index := re2.MatchIndex(sr.Line)
		if index != nil {
			sr.Bounds = &lgpb.Bounds{
				Left:  int32(index[0]),
				Right: int32(index[1]),
			}
		}

		if req.ContextLines > 0 {
			before, after, _, err := readFileContextLines(sr.Path, int(sr.LineNumber), int(req.ContextLines))
			if err != nil {
				log.Printf("WARN: could not read file context lines: %v", err)
			} else {
				sr.ContextBefore = before
				sr.ContextAfter = after
			}
		}

		csr.Results = append(csr.Results, sr)
	}

	for _, fileid := range files {
		name := ix.Name(fileid)
		if index := re2.MatchIndex(name); index != nil {
			csr.FileResults = append(csr.FileResults, &lgpb.FileResult{
				Path: name,
				Bounds: &lgpb.Bounds{
					Left:  int32(index[0]),
					Right: int32(index[1]),
				},
			})
		}
	}

	return csr, nil
}

func getRegexpPattern(pat string, ignoreCase bool) string {
	if ignoreCase {
		return "(?i)(?m)" + pat
	}
	return "(?m)" + pat
}

func makeSearchResult(line string) (*lgpb.SearchResult, error) {
	// expect FILENAME:LINENO:LINE\n
	// or
	// expect C:/FILENAME:LINENO:LINE\n

	// Locate the bit in the middle like ':LINENO'.
	digitRange := lineNoRegexp.FindStringIndex(line)
	if digitRange == nil {
		return nil, fmt.Errorf("parse error: expected colon-delimited triple")
	}

	// for a line like 'filename:10:foo' and the string ':10:' having range [8,
	// 12], parse the bit from 9..11.
	lineNo := line[digitRange[0]+1 : digitRange[1]-1]
	lineNumber, err := strconv.Atoi(lineNo)
	if err != nil {
		return nil, fmt.Errorf("could not parse line number: %v", err)
	}
	path := line[:digitRange[0]]
	rest := line[digitRange[0]+len(lineNo)+2:]

	return &lgpb.SearchResult{
		Path:       path,
		Line:       rest,
		LineNumber: int64(lineNumber),
	}, nil
}

func readFileContextLines(filename string, lineNumber int, contextLines int) ([]string, []string, string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, nil, "", err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)

	before := make([]string, 0)
	after := make([]string, 0)
	match := ""

	beginLine := lineNumber - contextLines
	endLine := lineNumber + contextLines

	if beginLine < 1 {
		beginLine = 1
	}

	lno := 0
	for scanner.Scan() {
		lno++
		if lno < beginLine {
			continue
		}
		if lno > endLine {
			break
		}
		line := scanner.Text()
		if lno < lineNumber {
			before = append(before, line)
		} else if lno > lineNumber {
			after = append(after, line)
		} else {
			match = line
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, nil, "", err
	}

	return before, after, match, nil
}
