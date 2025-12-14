package main

import (
	"log"
	"os"
	"path/filepath"
	"testing"

	slpb "github.com/stackb/centrl/build/stack/starlark/v1beta1"
)

func TestRewriteFile(t *testing.T) {
	tests := []struct {
		name          string
		bzlFile       *bzlFile
		moduleDeps    moduleDepsMap
		fileContent   string
		expectedLoads map[string]string // original -> expected
		wantErr       bool
		expectedLabel *slpb.Label
	}{
		{
			name: "simple load from same repo",
			bzlFile: &bzlFile{
				RepoName: "rules_go",
				Path:     "external/rules_go~0.50.1/go/private/rules.bzl",
			},
			moduleDeps: moduleDepsMap{
				"rules_go": {},
			},
			fileContent: `load("//go:def.bzl", "go_library")

def my_rule():
    pass
`,
			expectedLoads: map[string]string{
				"//go:def.bzl": "@rules_go//go:def.bzl",
			},
			expectedLabel: &slpb.Label{
				Repo: "rules_go",
				Pkg:  "go/private",
				Name: "rules.bzl",
			},
		},
		{
			name: "load from dependency",
			bzlFile: &bzlFile{
				RepoName: "rules_proto",
				Path:     "external/rules_proto~0.1.0/proto/defs.bzl",
			},
			moduleDeps: moduleDepsMap{
				"rules_proto": {
					{Name: "bazel_skylib", RepoName: "bazel_skylib~1.0.0"},
				},
			},
			fileContent: `load("@bazel_skylib//lib:paths.bzl", "paths")

def my_rule():
    pass
`,
			expectedLoads: map[string]string{
				"@bazel_skylib//lib:paths.bzl": "@bazel_skylib//lib:paths.bzl",
			},
			expectedLabel: &slpb.Label{
				Repo: "rules_proto",
				Pkg:  "proto",
				Name: "defs.bzl",
			},
		},
		{
			name: "relative load in same package",
			bzlFile: &bzlFile{
				RepoName: "my_repo",
				Path:     "external/my_repo~1.0.0/pkg/foo.bzl",
			},
			moduleDeps: moduleDepsMap{
				"my_repo": {},
			},
			fileContent: `load(":bar.bzl", "bar_func")

def foo():
    pass
`,
			expectedLoads: map[string]string{
				":bar.bzl": "@my_repo//pkg:bar.bzl",
			},
			expectedLabel: &slpb.Label{
				Repo: "my_repo",
				Pkg:  "pkg",
				Name: "foo.bzl",
			},
		},
		{
			name: "bazel_tools load",
			bzlFile: &bzlFile{
				RepoName: "my_repo",
				Path:     "external/my_repo~1.0.0/defs.bzl",
			},
			moduleDeps: moduleDepsMap{
				"my_repo": {},
			},
			fileContent: `load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

def my_rule():
    pass
`,
			expectedLoads: map[string]string{
				"@bazel_tools//tools/build_defs/repo:http.bzl": "@bazel_tools//tools/build_defs/repo:http.bzl",
			},
			expectedLabel: &slpb.Label{
				Repo: "my_repo",
				Pkg:  "",
				Name: "defs.bzl",
			},
		},
		{
			name: "multiple loads with dependency resolution",
			bzlFile: &bzlFile{
				RepoName: "rules_proto",
				Path:     "external/rules_proto~0.1.0/proto/defs.bzl",
			},
			moduleDeps: moduleDepsMap{
				"rules_proto": {
					{Name: "bazel_skylib", RepoName: "bazel_skylib~1.0.0"},
					{Name: "rules_cc", RepoName: "rules_cc~0.1.0"},
				},
			},
			fileContent: `load("@bazel_skylib//lib:paths.bzl", "paths")
load("@rules_cc//cc:defs.bzl", "cc_library")
load(":private.bzl", "helper")

def my_rule():
    pass
`,
			expectedLoads: map[string]string{
				"@bazel_skylib//lib:paths.bzl": "@bazel_skylib//lib:paths.bzl",
				"@rules_cc//cc:defs.bzl":       "@rules_cc//cc:defs.bzl",
				":private.bzl":                 "@rules_proto//proto:private.bzl",
			},
			expectedLabel: &slpb.Label{
				Repo: "rules_proto",
				Pkg:  "proto",
				Name: "defs.bzl",
			},
		},
		{
			name: "dependency referenced by repo name instead of module name",
			bzlFile: &bzlFile{
				RepoName: "rules_proto",
				Path:     "external/rules_proto~0.1.0/proto/defs.bzl",
			},
			moduleDeps: moduleDepsMap{
				"rules_proto": {
					{Name: "bazel_skylib", RepoName: "bazel_skylib~1.0.0"},
				},
			},
			fileContent: `load("@bazel_skylib~1.0.0//lib:paths.bzl", "paths")

def my_rule():
    pass
`,
			expectedLoads: map[string]string{
				"@bazel_skylib~1.0.0//lib:paths.bzl": "@bazel_skylib//lib:paths.bzl",
			},
			expectedLabel: &slpb.Label{
				Repo: "rules_proto",
				Pkg:  "proto",
				Name: "defs.bzl",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create temp directory for test
			tmpDir := t.TempDir()

			// Setup config
			cfg := &config{
				Cwd:        tmpDir,
				Logger:     log.New(os.Stderr, "test: ", 0),
				moduleDeps: tt.moduleDeps,
			}

			// Write source file
			srcPath := filepath.Join(tmpDir, tt.bzlFile.Path)
			if err := writeFile(srcPath, []byte(tt.fileContent), os.ModePerm); err != nil {
				t.Fatalf("failed to write test file: %v", err)
			}

			// Run rewriteFile
			err := rewriteBzlFile(cfg, tt.bzlFile)
			if (err != nil) != tt.wantErr {
				t.Errorf("rewriteFile() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if tt.wantErr {
				return
			}

			// Check label was set correctly
			if tt.expectedLabel != nil {
				if tt.bzlFile.Label == nil {
					t.Errorf("expected label to be set, got nil")
				} else {
					if tt.bzlFile.Label.Repo != tt.expectedLabel.Repo {
						t.Errorf("label.Repo = %q, want %q", tt.bzlFile.Label.Repo, tt.expectedLabel.Repo)
					}
					if tt.bzlFile.Label.Pkg != tt.expectedLabel.Pkg {
						t.Errorf("label.Pkg = %q, want %q", tt.bzlFile.Label.Pkg, tt.expectedLabel.Pkg)
					}
					if tt.bzlFile.Label.Name != tt.expectedLabel.Name {
						t.Errorf("label.Name = %q, want %q", tt.bzlFile.Label.Name, tt.expectedLabel.Name)
					}
				}
			}

			// Read rewritten file
			dstPath := filepath.Join(tmpDir, workDir, tt.bzlFile.Path)
			rewrittenContent, err := os.ReadFile(dstPath)
			if err != nil {
				t.Fatalf("failed to read rewritten file: %v", err)
			}

			// Parse and check loads
			_, loads, _, err := readBzlFile(cfg, dstPath)
			if err != nil {
				t.Fatalf("failed to parse rewritten file: %v", err)
			}

			// Build map of actual loads
			actualLoads := make(map[string]string)
			for _, load := range loads {
				actualLoads[load.Module.Value] = load.Module.Value
			}

			// For debugging
			t.Logf("Rewritten content:\n%s", string(rewrittenContent))
			t.Logf("Actual loads: %v", actualLoads)

			// Check each expected load was rewritten correctly
			for original, expected := range tt.expectedLoads {
				found := false
				for _, load := range loads {
					if load.Module.Value == expected {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("expected load %q to be rewritten to %q, but not found in output. Got loads: %v", original, expected, actualLoads)
				}
			}
		})
	}
}

func TestCleanErrorMessage(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		cwd      string
		expected string
	}{
		{
			name:     "removes absolute path prefix",
			err:      errorf("Unable to parse /private/var/tmp/_bazel_pcj/4d50590a9155e202dda3b0ac2e024c3f/execroot/_main/work/external/rules_go/file.bzl:5:5"),
			cwd:      "/private/var/tmp/_bazel_pcj/4d50590a9155e202dda3b0ac2e024c3f/execroot/_main",
			expected: "Unable to parse external/rules_go/file.bzl:5:5",
		},
		{
			name:     "handles multiple occurrences",
			err:      errorf("Error at /tmp/execroot/work/file.bzl and /tmp/execroot/work/other.bzl"),
			cwd:      "/tmp/execroot",
			expected: "Error at file.bzl and other.bzl",
		},
		{
			name:     "nil error returns nil",
			err:      nil,
			cwd:      "/tmp/test",
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := cleanErrorMessage(tt.err, tt.cwd)
			if tt.err == nil {
				if result != nil {
					t.Errorf("expected nil, got %v", result)
				}
				return
			}
			if result.Error() != tt.expected {
				t.Errorf("cleanErrorMessage() = %q, want %q", result.Error(), tt.expected)
			}
		})
	}
}

func errorf(format string, args ...interface{}) error {
	if len(args) == 0 {
		return &testError{msg: format}
	}
	return &testError{msg: format}
}

type testError struct {
	msg string
}

func (e *testError) Error() string {
	return e.msg
}
