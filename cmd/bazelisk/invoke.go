package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/bazelbuild/bazelisk/core"
)

var invocationUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

var captureFiles = []struct{ kind, name string }{
	{"capture", "capture.json"},
	{"action-map", "action-map.pb"},
	{"execution-log", "execution.zst"},
	{"profile", "command.profile.gz"},
	{"bep", "events.pb"},
}

func invocationArgs(args []string) (startup, command []string, ok bool) {
	for i := 0; i < len(args); i++ {
		if args[i] == "invoke" {
			return args[:i], args[i+1:], true
		}
		flag := strings.SplitN(args[i], "=", 2)[0]
		if !strings.HasPrefix(flag, "--") {
			break
		}
		if flag == args[i] && slices.Contains([]string{
			"--bazelrc", "--output_base", "--install_base", "--output_user_root", "--host_jvm_args",
			"--host_javabase", "--server_javabase", "--max_idle_secs", "--connect_timeout_secs",
			"--command_port", "--io_nice_level", "--failure_detail_out", "--digest_function",
		}, flag) {
			i++
		}
	}
	return nil, nil, false
}

type invokeOptions struct {
	targets, build, query   []string
	toolDeps, executionOnly bool
	id                      string
}

// Expand the common native abbreviations. Value-taking long options use
// --flag=value so the query's target expression can be assembled unambiguously.
func expandInvokeOptions(args []string) ([]string, error) {
	expanded := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--":
			return append(expanded, args[i:]...), nil
		case "-c", "-j":
			name := "--compilation_mode="
			if args[i] == "-j" {
				name = "--jobs="
			}
			i++
			if i == len(args) || strings.HasPrefix(args[i], "-") {
				return nil, fmt.Errorf("%s requires a value", strings.TrimSuffix(name, "="))
			}
			expanded = append(expanded, name+args[i])
		case "-k":
			expanded = append(expanded, "--keep_going")
		case "-s":
			expanded = append(expanded, "--subcommands")
		default:
			expanded = append(expanded, args[i])
		}
	}
	return expanded, nil
}

func parseInvoke(args []string) (invokeOptions, error) {
	var options invokeOptions
	if len(args) == 0 || args[0] != "build" {
		return options, errors.New("usage: bazel invoke build [--execution-only] [--tool_deps] <targets> [--flag=value ...]")
	}
	expanded, err := expandInvokeOptions(args[1:])
	if err != nil {
		return options, err
	}
	targetsOnly := false
	for _, arg := range expanded {
		if arg == "--" && !targetsOnly {
			targetsOnly = true
			continue
		}
		flag, value, _ := strings.Cut(arg, "=")
		if !targetsOnly && strings.HasPrefix(flag, "--") {
			switch flag {
			case "--execution-only":
				options.executionOnly = true
				continue
			case "--tool_deps", "--notool_deps":
				if arg != flag {
					return options, errors.New("use --tool_deps or --notool_deps")
				}
				options.toolDeps = flag == "--tool_deps"
				continue
			case "--invocation_id":
				if !invocationUUID.MatchString(value) {
					return options, errors.New("--invocation_id needs a UUID")
				}
				options.id = value
			case "--execution_log_compact_file", "--execution_log_json_file", "--execution_log_binary_file",
				"--build_event_binary_file", "--profile", "--target_pattern_file":
				return options, fmt.Errorf("invoke manages capture paths and requires explicit targets (%s)", flag)
			case "--bes_backend", "--bes_results_url", "--build_metadata", "--build_event_json_file", "--build_event_text_file":
			default:
				options.query = append(options.query, arg)
			}
			options.build = append(options.build, arg)
		} else {
			if strings.ContainsAny(arg, "'\"\r\n") || strings.HasPrefix(arg, "-") {
				return options, fmt.Errorf("unsupported target %q; use positive target patterns and --flag=value", arg)
			}
			options.targets = append(options.targets, arg)
			options.build = append(options.build, arg)
		}
	}
	if len(options.targets) == 0 {
		return options, errors.New("invoke build requires at least one target")
	}
	return options, nil
}

func makeInvocationID() string {
	var id [16]byte
	rand.Read(id[:])
	id[6] = id[6]&15 | 64
	id[8] = id[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}

func invocationSpool() (string, error) {
	if dir := os.Getenv("BCR_INVOKE_SPOOL"); dir != "" {
		return filepath.Abs(dir)
	}
	dir, err := os.UserCacheDir()
	return filepath.Join(dir, "bcr-invoke"), err
}

func runInvoke(startup, args []string) (int, error) {
	if len(args) == 1 && args[0] == "help" {
		fmt.Fprintln(os.Stdout, "bazel invoke build [--execution-only] [--tool_deps] <targets> [--flag=value ...]\nbazel invoke upload <invocation UUID>")
		return 0, nil
	}
	spool, err := invocationSpool()
	if err != nil {
		return 1, err
	}
	if len(args) == 2 && args[0] == "upload" {
		if !invocationUUID.MatchString(args[1]) {
			return 2, errors.New("upload requires an invocation UUID")
		}
		return finishCapture(filepath.Join(spool, args[1]), args[1], nil)
	}
	options, err := parseInvoke(args)
	if err != nil {
		return 2, err
	}
	bazel := os.Getenv("BAZEL_REAL")
	if bazel == "" {
		installation, err := core.GetBazelInstallation(bazelRepositories(), core.MakeDefaultConfig())
		if err != nil {
			return 1, err
		}
		bazel = installation.Path
	}
	if options.id == "" {
		options.id = makeInvocationID()
	}
	dir := filepath.Join(spool, options.id)
	if err := os.MkdirAll(spool, 0700); err != nil {
		return 1, err
	}
	if err := os.Mkdir(dir, 0700); err != nil {
		return 1, err
	}
	fmt.Fprintf(os.Stderr, "invoke: %s\n", options.id)

	mapState := "disabled"
	if !options.executionOnly {
		mapState = "captured"
		quoted := make([]string, 0, len(options.targets))
		for _, target := range options.targets {
			quoted = append(quoted, "'"+target+"'")
		}
		query := append(slices.Clone(startup), "aquery")
		query = append(query, options.query...)
		query = append(query, "--output=proto", "--noinclude_commandline", "--bes_backend=",
			"--build_event_binary_file=", "--build_event_json_file=", "--build_event_text_file=",
			"--execution_log_compact_file=", "--execution_log_binary_file=", "--execution_log_json_file=")
		if options.toolDeps {
			query = append(query, "--tool_deps")
		} else {
			query = append(query, "--notool_deps")
		}
		query = append(query, "deps(set("+strings.Join(quoted, " ")+"))")
		path := filepath.Join(dir, "action-map.pb")
		f, err := os.Create(path)
		if err == nil {
			err = invokeCommand(bazel, query, f)
			err = errors.Join(err, f.Close())
		}
		if err != nil {
			mapState = "unavailable"
			_ = os.Remove(path)
			fmt.Fprintf(os.Stderr, "invoke: action map unavailable: %v\n", err)
			var exit *exec.ExitError
			if errors.As(err, &exit) && (exit.ExitCode() == 8 || exit.ExitCode() == -1) {
				_ = os.Remove(dir)
				return 8, nil
			}
		}
	}

	manifest, err := json.Marshal(struct {
		Targets   []string `json:"targets"`
		ToolDeps  bool     `json:"toolDeps"`
		ActionMap string   `json:"actionMap"`
	}{options.targets, options.toolDeps, mapState})
	if err != nil {
		return 1, err
	}
	if err := os.WriteFile(filepath.Join(dir, "capture.json"), manifest, 0600); err != nil {
		return 1, err
	}

	// Overlap the initial uploads with the build. The retry pass skips successful
	// writes and can resend a file after a lost HTTP response.
	initial := make(chan map[string]bool, 1)
	go func() {
		uploaded, _ := uploadCapture(dir, options.id, nil, 2)
		initial <- uploaded
	}()

	build := append(slices.Clone(startup), "build")
	if endpoint := os.Getenv("BCR_INVOKE_BES"); endpoint != "" {
		build = append(build, "--bes_backend="+endpoint)
	}
	if results := os.Getenv("BCR_INVOKE_RESULTS_URL"); results != "" {
		build = append(build, "--bes_results_url="+strings.TrimRight(results, "/")+"/")
	}
	build = append(build, options.build...)
	build = append(build, "--invocation_id="+options.id, "--experimental_remote_cache_eviction_retries=0",
		"--execution_log_compact_file="+filepath.Join(dir, "execution.zst"),
		"--execution_log_binary_file=", "--execution_log_json_file=", "--generate_json_trace_profile",
		"--profile="+filepath.Join(dir, "command.profile.gz"), "--build_event_publish_all_actions",
		"--build_event_binary_file="+filepath.Join(dir, "events.pb"))
	buildErr := invokeCommand(bazel, build, os.Stdout)
	if _, err := finishCapture(dir, options.id, <-initial); err != nil {
		fmt.Fprintf(os.Stderr, "invoke: %v\nCapture retained at %s; retry with bazel invoke upload %s\n", err, dir, options.id)
	}
	var exit *exec.ExitError
	if errors.As(buildErr, &exit) {
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal()), nil
		}
		return exit.ExitCode(), nil
	}
	if buildErr != nil {
		return 1, buildErr
	}
	return 0, nil
}

func invokeCommand(bazel string, args []string, stdout io.Writer) error {
	cmd := exec.Command(bazel, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, stdout, os.Stderr
	// The terminal sends Ctrl-C to Bazel and the launcher. Let Bazel finish
	// writing its partial logs and keep the launcher alive to upload them.
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	defer signal.Stop(interrupt)
	return cmd.Run()
}

func finishCapture(dir, id string, uploaded map[string]bool) (int, error) {
	if _, err := uploadCapture(dir, id, uploaded, len(captureFiles)); err != nil {
		return 1, err
	}
	if err := os.RemoveAll(dir); err != nil {
		return 1, err
	}
	fmt.Fprintf(os.Stderr, "invoke: uploaded capture for %s\n", id)
	return 0, nil
}

func uploadCapture(dir, id string, uploaded map[string]bool, count int) (map[string]bool, error) {
	if uploaded == nil {
		uploaded = make(map[string]bool)
	}
	endpoint := os.Getenv("BCR_INVOKE_URL")
	if endpoint == "" {
		endpoint = "http://localhost:1974"
	}
	base, err := url.Parse(endpoint)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return uploaded, errors.New("BCR_INVOKE_URL must be an HTTP or HTTPS backend URL")
	}
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var failures error
	for _, file := range captureFiles[:count] {
		if uploaded[file.kind] {
			continue
		}
		err := uploadCaptureFile(ctx, client, base, id, file.kind, filepath.Join(dir, file.name))
		if errors.Is(err, os.ErrNotExist) {
			if file.kind == "capture" {
				failures = errors.Join(failures, fmt.Errorf("capture %s was not found", id))
			}
		} else if err != nil {
			failures = errors.Join(failures, fmt.Errorf("upload %s: %w", file.kind, err))
		} else {
			uploaded[file.kind] = true
		}
	}
	return uploaded, failures
}

func uploadCaptureFile(ctx context.Context, client *http.Client, base *url.URL, id, kind, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		return nil
	}
	endpoint := base.JoinPath("api", "invocations", id, "attachments", kind)
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint.String(), f)
	if err != nil {
		return err
	}
	request.ContentLength = info.Size()
	request.Header.Set("Content-Type", "application/octet-stream")
	if token := os.Getenv("BCR_INVOKE_TOKEN"); token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := client.Do(request)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		return fmt.Errorf("backend returned HTTP %d", res.StatusCode)
	}
	return nil
}
