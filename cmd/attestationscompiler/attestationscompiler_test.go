package main

import (
	"path/filepath"
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

// TestRun_NoIntoto exercises the PR 2 path: --attestations_json_file alone,
// no --intoto_file flags. The output proto should mirror attestations.json
// 1:1 with empty Payload fields.
func TestRun_NoIntoto(t *testing.T) {
	out := filepath.Join(t.TempDir(), "compiled.pb")
	err := run([]string{
		"--attestations_json_file", "testdata/attestations.json",
		"--output_file", out,
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}

	got := &bzpb.Attestations{}
	if err := protoutil.ReadFile(out, got); err != nil {
		t.Fatalf("read output: %v", err)
	}

	wantFiles := map[string]bool{"source.json": true, "MODULE.bazel": true}
	for name := range got.Attestations {
		if !wantFiles[name] {
			t.Errorf("unexpected attestation entry %q", name)
		}
		delete(wantFiles, name)
	}
	for missing := range wantFiles {
		t.Errorf("missing attestation entry %q", missing)
	}

	for name, entry := range got.Attestations {
		if entry.Url == "" {
			t.Errorf("%s: empty Url", name)
		}
		if entry.Integrity == "" {
			t.Errorf("%s: empty Integrity", name)
		}
		if entry.Payload != nil {
			t.Errorf("%s: expected nil Payload without --intoto_file, got %+v", name, entry.Payload)
		}
	}
}

// TestRun_WithIntoto exercises the PR 3 path: a single --intoto_file flag
// attaches a parsed payload to one entry; the other entry stays payload-free.
func TestRun_WithIntoto(t *testing.T) {
	out := filepath.Join(t.TempDir(), "compiled.pb")
	err := run([]string{
		"--attestations_json_file", "testdata/attestations.json",
		"--intoto_file", "source.json=testdata/source.intoto.jsonl",
		"--output_file", out,
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}

	got := &bzpb.Attestations{}
	if err := protoutil.ReadFile(out, got); err != nil {
		t.Fatalf("read output: %v", err)
	}

	src, ok := got.Attestations["source.json"]
	if !ok {
		t.Fatal("missing source.json entry")
	}
	if src.Payload == nil {
		t.Fatal("source.json: expected non-nil Payload after --intoto_file")
	}
	if src.Payload.ParseError != "" {
		t.Errorf("source.json: ParseError = %q; want empty", src.Payload.ParseError)
	}
	if want := "source.json"; src.Payload.SubjectName != want {
		t.Errorf("SubjectName = %q; want %q", src.Payload.SubjectName, want)
	}
	if src.Payload.SourceCommitSha == "" {
		t.Errorf("SourceCommitSha empty; expected populated from SLSA v1 predicate")
	}
	if src.Payload.RekorLogIndex == 0 {
		t.Errorf("RekorLogIndex zero; expected populated from tlogEntries")
	}

	other := got.Attestations["MODULE.bazel"]
	if other == nil {
		t.Fatal("missing MODULE.bazel entry")
	}
	if other.Payload != nil {
		t.Errorf("MODULE.bazel: Payload = %+v; want nil (no --intoto_file passed)", other.Payload)
	}
}

func TestRun_UnknownIntotoFilename(t *testing.T) {
	out := filepath.Join(t.TempDir(), "compiled.pb")
	err := run([]string{
		"--attestations_json_file", "testdata/attestations.json",
		"--intoto_file", "does-not-exist.tar.gz=testdata/source.intoto.jsonl",
		"--output_file", out,
	})
	if err == nil {
		t.Fatal("expected error for --intoto_file referring to unknown filename")
	}
}

// TestRun_UnavailableEntry exercises the dead-URL-at-Gazelle-time path: pass
// --unavailable_entry=source.json and verify the resulting entry's Payload
// carries the canonical ParseError while other entries stay payload-free.
func TestRun_UnavailableEntry(t *testing.T) {
	out := filepath.Join(t.TempDir(), "compiled.pb")
	err := run([]string{
		"--attestations_json_file", "testdata/attestations.json",
		"--unavailable_entry", "source.json",
		"--output_file", out,
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	got := &bzpb.Attestations{}
	if err := protoutil.ReadFile(out, got); err != nil {
		t.Fatalf("read output: %v", err)
	}
	src, ok := got.Attestations["source.json"]
	if !ok {
		t.Fatal("missing source.json entry")
	}
	if src.Payload == nil {
		t.Fatal("source.json: expected non-nil Payload after --unavailable_entry")
	}
	if want := unavailableParseError; src.Payload.ParseError != want {
		t.Errorf("source.json: ParseError = %q; want %q", src.Payload.ParseError, want)
	}
	other := got.Attestations["MODULE.bazel"]
	if other == nil {
		t.Fatal("missing MODULE.bazel entry")
	}
	if other.Payload != nil {
		t.Errorf("MODULE.bazel: Payload = %+v; want nil (no flags passed for it)", other.Payload)
	}
}

func TestRun_UnknownUnavailableFilename(t *testing.T) {
	out := filepath.Join(t.TempDir(), "compiled.pb")
	err := run([]string{
		"--attestations_json_file", "testdata/attestations.json",
		"--unavailable_entry", "does-not-exist.tar.gz",
		"--output_file", out,
	})
	if err == nil {
		t.Fatal("expected error for --unavailable_entry referring to unknown filename")
	}
}
