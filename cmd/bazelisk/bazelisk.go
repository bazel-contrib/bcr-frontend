// Command bazelisk wraps github.com/bazelbuild/bazelisk's resolution + download
// logic so the bazel_version rule can invoke a hermetic, project-controlled
// bazel binary instead of relying on a host-installed bazelisk.
//
// Compared to upstream bazelisk it adds one feature: an optional
// "--output <path>" flag (must come first) that redirects the wrapped bazel
// process's stdout to <path>. Stdin and stderr always pass through untouched.
//
// The version is selected via the standard USE_BAZEL_VERSION env var (or any
// other mechanism upstream bazelisk recognizes).
package main

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/bazelbuild/bazelisk/core"
	"github.com/bazelbuild/bazelisk/repositories"
)

// unknownCommandPattern is bazel's error string when a subcommand doesn't
// exist (e.g. "vendor" in 6.x, "mod" before 7.x). The bazel_help build path
// queries every version with the same command list, so older releases hit
// this. We treat it as "no help for this combo" and emit empty output.
const unknownCommandPattern = "is not a known command"

func main() {
	args := os.Args[1:]
	allowUnknownCommand := false

	// Optional leading "--allow-unknown-command": treat "is not a known command"
	// stderr from bazel as success-with-empty-output (only meaningful in a
	// help-extraction mode that writes to a file).
	if len(args) >= 1 && args[0] == "--allow-unknown-command" {
		allowUnknownCommand = true
		args = args[1:]
	}

	// Bazelisk derives its cache directory from $HOME (via os.UserCacheDir).
	// Bazel's sandboxed actions don't always pass $HOME through, so default
	// BAZELISK_HOME explicitly to a stable, world-writable location when both
	// are missing. This keeps downloaded bazel binaries cached across builds.
	if os.Getenv("BAZELISK_HOME") == "" && os.Getenv("HOME") == "" {
		fallback := filepath.Join(os.TempDir(), fmt.Sprintf("bazelisk-cache-%d", os.Getuid()))
		if err := os.MkdirAll(fallback, 0o755); err != nil {
			log.Fatalf("bazelisk: could not create fallback cache %s: %v", fallback, err)
		}
		os.Setenv("BAZELISK_HOME", fallback)
	}

	// Multi-help mode: run `bazel help <cmd> --long` sequentially for each
	// "cmd=path" pair after the flag. Sequential reuse of the same bazel
	// server avoids the output-base lock contention that hits when many
	// `bazel help` invocations run in parallel against the same version.
	//
	// Usage: bazelisk [--allow-unknown-command] --multi-help cmd1=path1 cmd2=path2 ...
	if len(args) >= 1 && args[0] == "--multi-help" {
		// Each inner bazel needs its own output_user_root, otherwise
		// parallel actions for different versions all fight for the same
		// global lock under /var/tmp/_bazel_<user>. Key by version so the
		// same version reuses its server across builds (faster reruns).
		version := os.Getenv("USE_BAZEL_VERSION")
		if version == "" {
			version = "default"
		}
		outputUserRoot := filepath.Join(
			os.TempDir(),
			fmt.Sprintf("bcr-bazel-help-%s-%d", version, os.Getuid()),
		)
		if err := os.MkdirAll(outputUserRoot, 0o755); err != nil {
			log.Fatalf("bazelisk: could not create output_user_root %s: %v", outputUserRoot, err)
		}
		os.Exit(runMultiHelp(args[1:], allowUnknownCommand, outputUserRoot))
	}

	// Single-shot help mode: optional "--output <path>" redirects the bazel
	// process's stdout to <path>; remaining args go straight to bazelisk.
	var outputFile *os.File
	if len(args) >= 2 && args[0] == "--output" {
		f, err := os.Create(args[1])
		if err != nil {
			log.Fatalf("bazelisk: --output: %v", err)
		}
		outputFile = f
		defer f.Close()
		os.Stdout = f
		args = args[2:]
	}

	code, _, err := runBazelisk(args)
	if err != nil {
		log.Fatalf("bazelisk: %v", err)
	}

	if code != 0 && allowUnknownCommand {
		// We don't have stderr capture in single-shot mode (it streams
		// through to the terminal), so we can't pattern-match here. Trust
		// that callers using --allow-unknown-command + --output expect an
		// empty file on this kind of failure.
		_ = outputFile
	}

	os.Exit(code)
}

// runMultiHelp executes `bazel help <cmd> --long` once per "cmd=path" pair,
// reusing the same bazel server. The outputUserRoot startup flag is prepended
// to every call so parallel bazelisk invocations across different versions
// don't collide on the global $HOME-derived output_user_root lock. Returns
// the exit code (0 if every command succeeded, or if --allow-unknown-command
// swallowed the failures).
func runMultiHelp(pairs []string, allowUnknownCommand bool, outputUserRoot string) int {
	if len(pairs) == 0 {
		log.Fatalf("bazelisk: --multi-help requires at least one cmd=path argument")
	}

	for _, pair := range pairs {
		idx := strings.Index(pair, "=")
		if idx <= 0 {
			log.Fatalf("bazelisk: invalid --multi-help arg %q (expected cmd=path)", pair)
		}
		cmd := pair[:idx]
		outPath := pair[idx+1:]

		out, err := os.Create(outPath)
		if err != nil {
			log.Fatalf("bazelisk: create %s: %v", outPath, err)
		}

		// Each command needs its own captured stdout; swap os.Stdout
		// around the call.
		originalStdout := os.Stdout
		os.Stdout = out

		bazelArgs := []string{
			"--output_user_root=" + outputUserRoot,
			"help",
			cmd,
			"--long",
		}
		code, stderr, runErr := runBazelisk(bazelArgs)

		os.Stdout = originalStdout
		_ = out.Close()

		if runErr != nil {
			log.Fatalf("bazelisk: %v", runErr)
		}
		if code != 0 {
			if allowUnknownCommand && strings.Contains(stderr, unknownCommandPattern) {
				// Truncate the partial output and continue.
				if err := os.Truncate(outPath, 0); err != nil {
					log.Fatalf("bazelisk: truncate %s: %v", outPath, err)
				}
				continue
			}
			return code
		}
	}
	return 0
}

// runBazelisk invokes core.RunBazelisk with stderr teed through a buffer, so
// callers can pattern-match the stderr after the call.
func runBazelisk(args []string) (int, string, error) {
	var stderrBuf bytes.Buffer
	stopTee, err := teeStderr(&stderrBuf)
	if err != nil {
		return 0, "", fmt.Errorf("could not capture stderr: %w", err)
	}

	gcs := &repositories.GCSRepo{}
	gitHub := repositories.CreateGitHubRepo(os.Getenv("BAZELISK_GITHUB_TOKEN"))
	repos := core.CreateRepositories(gcs, gitHub, gcs, gcs, false)

	code, runErr := core.RunBazelisk(args, repos)
	stopTee()
	return code, stderrBuf.String(), runErr
}

// teeStderr replaces os.Stderr with a pipe that copies into both the original
// stderr and the provided buffer. The returned stop function closes the pipe
// and waits for the copier to drain.
func teeStderr(buf *bytes.Buffer) (func(), error) {
	original := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	os.Stderr = w
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = io.Copy(io.MultiWriter(original, buf), r)
	}()
	return func() {
		_ = w.Close()
		<-done
		os.Stderr = original
	}, nil
}
