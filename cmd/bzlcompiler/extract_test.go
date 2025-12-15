package main

import (
	"testing"
)

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
