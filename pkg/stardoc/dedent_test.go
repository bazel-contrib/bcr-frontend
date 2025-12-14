package stardoc

import (
	"fmt"
	"testing"
)

const errorMsg = "\nexpected %q\ngot %q"

type dedentTest struct {
	text, expect string
}

func TestDedentNoMargin(t *testing.T) {
	tests := []dedentTest{
		{
			// No lines indented
			text:   "Hello there.\nHow are you?\nOh good, I'm glad.",
			expect: "Hello there.\nHow are you?\nOh good, I'm glad.",
		},
		{
			// Similar with a blank line
			text:   "Hello there.\n\nBoo!",
			expect: "Hello there.\n\nBoo!",
		},
		{
			// First line not indented, second line indented - dedent second line
			text:   "Hello there.\n  This is indented.",
			expect: "Hello there.\nThis is indented.",
		},
		{
			// Again, add a blank line.
			text:   "Hello there.\n\n  Boo!\n",
			expect: "Hello there.\n\nBoo!\n",
		},
	}

	for _, test := range tests {
		result := Dedent(test.text)
		if test.expect != result {
			t.Errorf(errorMsg, test.expect, result)
		}
	}
}

func TestDedentEven(t *testing.T) {
	texts := []dedentTest{
		{
			// All lines indented by two spaces
			text:   "  Hello there.\n  How are ya?\n  Oh good.",
			expect: "Hello there.\nHow are ya?\nOh good.",
		},
		{
			// Same, with blank lines
			text:   "  Hello there.\n\n  How are ya?\n  Oh good.\n",
			expect: "Hello there.\n\nHow are ya?\nOh good.\n",
		},
		{
			// Now indent one of the blank lines
			text:   "  Hello there.\n  \n  How are ya?\n  Oh good.\n",
			expect: "Hello there.\n\nHow are ya?\nOh good.\n",
		},
	}

	for _, text := range texts {
		if text.expect != Dedent(text.text) {
			t.Errorf(errorMsg, text.expect, Dedent(text.text))
		}
	}
}

func TestDedentUneven(t *testing.T) {
	texts := []dedentTest{
		{
			// Lines indented unevenly
			text: `
			def foo():
				while 1:
					return foo
			`,
			expect: `
def foo():
	while 1:
		return foo
`,
		},
		{
			// Uneven indentation with a blank line
			text:   "  Foo\n    Bar\n\n   Baz\n",
			expect: "Foo\n  Bar\n\n Baz\n",
		},
		{
			// Uneven indentation with a whitespace-only line
			text:   "  Foo\n    Bar\n \n   Baz\n",
			expect: "Foo\n  Bar\n\n Baz\n",
		},
	}

	for _, text := range texts {
		if text.expect != Dedent(text.text) {
			t.Errorf(errorMsg, text.expect, Dedent(text.text))
		}
	}
}

// Dedent() should not mangle internal tabs.
func TestDedentPreserveInternalTabs(t *testing.T) {
	text := "  hello\tthere\n  how are\tyou?"
	expect := "hello\tthere\nhow are\tyou?"
	if expect != Dedent(text) {
		t.Errorf(errorMsg, expect, Dedent(text))
	}

	// Make sure that it preserves tabs when it's not making any changes at all
	if expect != Dedent(expect) {
		t.Errorf(errorMsg, expect, Dedent(expect))
	}
}

// Dedent() should not mangle tabs in the margin (i.e. tabs and spaces both
// count as margin, but are *not* considered equivalent).
func TestDedentPreserveMarginTabs(t *testing.T) {
	texts := []string{
		"  hello there\n\thow are you?",
		// Same effect even if we have 8 spaces
		"        hello there\n\thow are you?",
	}

	for _, text := range texts {
		d := Dedent(text)
		if text != d {
			t.Errorf(errorMsg, text, d)
		}
	}

	texts2 := []dedentTest{
		{
			// Dedent() only removes whitespace that can be uniformly removed!
			text:   "\thello there\n\thow are you?",
			expect: "hello there\nhow are you?",
		},
		{
			text:   "  \thello there\n  \thow are you?",
			expect: "hello there\nhow are you?",
		},
		{
			text:   "  \t  hello there\n  \t  how are you?",
			expect: "hello there\nhow are you?",
		},
		{
			text:   "  \thello there\n  \t  how are you?",
			expect: "hello there\n  how are you?",
		},
	}

	for _, text := range texts2 {
		if text.expect != Dedent(text.text) {
			t.Errorf(errorMsg, text.expect, Dedent(text.text))
		}
	}
}

// Test the specific use case from go_binary docstring
// When the first line has no indentation but other lines do, dedent the other lines
func TestDedentGoBinaryDocstring(t *testing.T) {
	// Case 1: First line not indented, other lines indented - should dedent other lines
	text := `Forces a binary to be cross-compiled for a specific operating system. It's
            usually better to control this on the command line with ` + "`--platforms`" + `.

            This disables cgo by default, since a cross-compiling C/C++ toolchain is
            rarely available. To force cgo, set ` + "`pure`" + ` = ` + "`off`" + `.

            See [Cross compilation] for more information.`

	expect := `Forces a binary to be cross-compiled for a specific operating system. It's
usually better to control this on the command line with ` + "`--platforms`" + `.

This disables cgo by default, since a cross-compiling C/C++ toolchain is
rarely available. To force cgo, set ` + "`pure`" + ` = ` + "`off`" + `.

See [Cross compilation] for more information.`

	result := Dedent(text)
	if expect != result {
		t.Errorf(errorMsg, expect, result)
	}

	// Case 2: All lines indented (this is what we want to test)
	text2 := `            Forces a binary to be cross-compiled for a specific operating system. It's
            usually better to control this on the command line with ` + "`--platforms`" + `.

            This disables cgo by default, since a cross-compiling C/C++ toolchain is
            rarely available. To force cgo, set ` + "`pure`" + ` = ` + "`off`" + `.

            See [Cross compilation] for more information.`

	expect2 := `Forces a binary to be cross-compiled for a specific operating system. It's
usually better to control this on the command line with ` + "`--platforms`" + `.

This disables cgo by default, since a cross-compiling C/C++ toolchain is
rarely available. To force cgo, set ` + "`pure`" + ` = ` + "`off`" + `.

See [Cross compilation] for more information.`

	result2 := Dedent(text2)
	if expect2 != result2 {
		t.Errorf(errorMsg, expect2, result2)
	}
}

// Test a complex multi-paragraph docstring from go_test (rundir attribute)
func TestDedentMultiParagraphDocstring(t *testing.T) {
	text := `A directory to cd to before the test is run.
            This should be a path relative to the root directory of the
            repository in which the test is defined, which can be the main or an
            external repository.

            The default behaviour is to change to the relative path
            corresponding to the test's package, which replicates the normal
            behaviour of ` + "`go test`" + ` so it is easy to write compatible tests.

            Setting it to ` + "`.`" + ` makes the test behave the normal way for a bazel
            test, except that the working directory is always that of the test's
            repository, which is not necessarily the main repository.

            Note: If runfile symlinks are disabled (such as on Windows by
            default), the test will run in the working directory set by Bazel,
            which is the subdirectory of the runfiles directory corresponding to
            the main repository.`

	expect := `A directory to cd to before the test is run.
This should be a path relative to the root directory of the
repository in which the test is defined, which can be the main or an
external repository.

The default behaviour is to change to the relative path
corresponding to the test's package, which replicates the normal
behaviour of ` + "`go test`" + ` so it is easy to write compatible tests.

Setting it to ` + "`.`" + ` makes the test behave the normal way for a bazel
test, except that the working directory is always that of the test's
repository, which is not necessarily the main repository.

Note: If runfile symlinks are disabled (such as on Windows by
default), the test will run in the working directory set by Bazel,
which is the subdirectory of the runfiles directory corresponding to
the main repository.`

	result := Dedent(text)
	if expect != result {
		t.Errorf(errorMsg, expect, result)
	}

	// Now test with all lines indented
	text2 := `            A directory to cd to before the test is run.
            This should be a path relative to the root directory of the
            repository in which the test is defined, which can be the main or an
            external repository.

            The default behaviour is to change to the relative path
            corresponding to the test's package, which replicates the normal
            behaviour of ` + "`go test`" + ` so it is easy to write compatible tests.

            Setting it to ` + "`.`" + ` makes the test behave the normal way for a bazel
            test, except that the working directory is always that of the test's
            repository, which is not necessarily the main repository.

            Note: If runfile symlinks are disabled (such as on Windows by
            default), the test will run in the working directory set by Bazel,
            which is the subdirectory of the runfiles directory corresponding to
            the main repository.`

	expect2 := `A directory to cd to before the test is run.
This should be a path relative to the root directory of the
repository in which the test is defined, which can be the main or an
external repository.

The default behaviour is to change to the relative path
corresponding to the test's package, which replicates the normal
behaviour of ` + "`go test`" + ` so it is easy to write compatible tests.

Setting it to ` + "`.`" + ` makes the test behave the normal way for a bazel
test, except that the working directory is always that of the test's
repository, which is not necessarily the main repository.

Note: If runfile symlinks are disabled (such as on Windows by
default), the test will run in the working directory set by Bazel,
which is the subdirectory of the runfiles directory corresponding to
the main repository.`

	result2 := Dedent(text2)
	if expect2 != result2 {
		t.Errorf(errorMsg, expect2, result2)
	}
}

func ExampleDedent() {
	s := `
		Lorem ipsum dolor sit amet,
		consectetur adipiscing elit.
		Curabitur justo tellus, facilisis nec efficitur dictum,
		fermentum vitae ligula. Sed eu convallis sapien.`
	fmt.Println(Dedent(s))
	fmt.Println("-------------")
	fmt.Println(s)
	// Output:
	//
	// Lorem ipsum dolor sit amet,
	// consectetur adipiscing elit.
	// Curabitur justo tellus, facilisis nec efficitur dictum,
	// fermentum vitae ligula. Sed eu convallis sapien.
	// -------------
	//
	//		Lorem ipsum dolor sit amet,
	//		consectetur adipiscing elit.
	//		Curabitur justo tellus, facilisis nec efficitur dictum,
	//		fermentum vitae ligula. Sed eu convallis sapien.
}

// Test case with first line unindented and varying indentation in continuation lines
func TestDedentRundirDocstring(t *testing.T) {
	text := `A directory to cd to before the test is run.
           This should be a path relative to the root directory of the
           repository in which the test is defined, which can be the main or an
           external repository.

           The default behaviour is to change to the relative path
           corresponding to the test's package, which replicates the normal
           behaviour of ` + "`go test`" + ` so it is easy to write compatible tests.

           Setting it to ` + "`.`" + ` makes the test behave the normal way for a bazel
           test, except that the working directory is always that of the test's
           repository, which is not necessarily the main repository.

           Note: If runfile symlinks are disabled (such as on Windows by
           default), the test will run in the working directory set by Bazel,
           which is the subdirectory of the runfiles directory corresponding to
           the main repository.`

	expect := `A directory to cd to before the test is run.
This should be a path relative to the root directory of the
repository in which the test is defined, which can be the main or an
external repository.

The default behaviour is to change to the relative path
corresponding to the test's package, which replicates the normal
behaviour of ` + "`go test`" + ` so it is easy to write compatible tests.

Setting it to ` + "`.`" + ` makes the test behave the normal way for a bazel
test, except that the working directory is always that of the test's
repository, which is not necessarily the main repository.

Note: If runfile symlinks are disabled (such as on Windows by
default), the test will run in the working directory set by Bazel,
which is the subdirectory of the runfiles directory corresponding to
the main repository.`

	result := Dedent(text)
	if expect != result {
		t.Errorf(errorMsg, expect, result)
	}
}

func BenchmarkDedent(b *testing.B) {
	for i := 0; i < b.N; i++ {
		Dedent(`Lorem ipsum dolor sit amet, consectetur adipiscing elit.
		Curabitur justo tellus, facilisis nec efficitur dictum,
		fermentum vitae ligula. Sed eu convallis sapien.`)
	}
}
