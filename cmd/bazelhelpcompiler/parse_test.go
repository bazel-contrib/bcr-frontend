package main

import (
	"strings"
	"testing"
)

func TestParseHelp(t *testing.T) {
	resp := parseHelp(strings.NewReader(`
[bazel release 0.25.0]
Usage: bazel build <options> <targets>

Builds the specified targets, using the options.

See 'bazel help target-syntax' for details and examples on how to
specify targets to build.

Options that appear before the command and are parsed by the client:
	--distdir (a path; may be used multiple times)
	Additional places to search for archives before accessing the network to
	download them.
		Tags: bazel_internal_configuration
	--[no]experimental_repository_cache_hardlinks (a boolean; default: "false")
	If set, the repository cache will hardlink the file in case of a cache hit,
	rather than copying. This is inteded to save disk space.
		Tags: bazel_internal_configuration
	--experimental_scale_timeouts (a double; default: "1.0")
	Scale all timeouts in Starlark repository rules by this factor. In this
	way, external repositories can be made working on machines that are slower
	than the rule author expected, without changing the source code
		Tags: bazel_internal_configuration, experimental
	--repository_cache (a path; default: see description)
	Specifies the cache location of the downloaded values obtained during the
	fetching of external repositories. An empty string as argument requests the
	cache to be disabled.
		Tags: bazel_internal_configuration

Options that control build execution:
	--experimental_docker_image (a string; default: "")
	Specify a Docker image name (e.g. "ubuntu:latest") that should be used to
	execute a sandboxed action when using the docker strategy and the action
	itself doesn't already have a container-image attribute in its
	remote_execution_properties in the platform description. The value of this
	flag is passed verbatim to 'docker run', so it supports the same syntax and
	mechanisms as Docker itself.
		Tags: execution
	`))

	if len(resp.Category) != 2 {
		t.Errorf("Expected 2 categories, got %d", len(resp.Category))
	}

	c0 := resp.Category[0]

	if len(c0.Option) != 4 {
		t.Errorf("Expected 4 flags in first category, got %d", len(c0.Option))
	}

	distdir := c0.Option[0]

	if distdir.Name != "distdir" {
		t.Errorf(`Expected flag "distdir", got %q (%+v)"`, distdir.Name, distdir)
	}

	if distdir.Type != "path" {
		t.Errorf(`Expected type "path", got %q (%+v)"`, distdir.Type, distdir)
	}

	if distdir.Default != "may be used multiple times" {
		t.Errorf(`Expected default "may be used multiple times", got %q (%+v)"`, distdir.Default, distdir)
	}

	est := c0.Option[2]

	if est.Name != "experimental_scale_timeouts" {
		t.Errorf(`Expected flag "experimental_scale_timeouts", got %q (%+v)"`, est.Name, est)
	}

	if est.Type != "double" {
		t.Errorf(`Expected type "double", got %q (%+v)"`, est.Type, est)
	}

	if est.Default != "1.0" {
		t.Errorf(`Expected default "1.0", got %q (%+v)"`, est.Default, est)
	}

}
