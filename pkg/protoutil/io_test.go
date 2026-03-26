package protoutil

import (
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"

	registrypb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"google.golang.org/protobuf/proto"
)

func newTestMessage() *registrypb.ModuleMetadata {
	return &registrypb.ModuleMetadata{
		Homepage:   "https://example.com",
		Maintainers: []*registrypb.Maintainer{
			{Name: "Alice", Email: "alice@example.com"},
		},
	}
}

func TestReadWriteFile_Proto(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.pb")

	want := newTestMessage()
	if err := WriteFile(path, want); err != nil {
		t.Fatal(err)
	}

	got := &registrypb.ModuleMetadata{}
	if err := ReadFile(path, got); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(want, got) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestReadWriteFile_JSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")

	want := newTestMessage()
	if err := WriteFile(path, want); err != nil {
		t.Fatal(err)
	}

	got := &registrypb.ModuleMetadata{}
	if err := ReadFile(path, got); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(want, got) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestReadWriteFile_Textproto(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.textproto")

	want := newTestMessage()
	if err := WriteFile(path, want); err != nil {
		t.Fatal(err)
	}

	got := &registrypb.ModuleMetadata{}
	if err := ReadFile(path, got); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(want, got) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestReadWriteFile_ProtoGz(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.pb.gz")

	want := newTestMessage()
	if err := WriteFile(path, want); err != nil {
		t.Fatal(err)
	}

	// Verify the file is actually gzipped
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) < 2 || raw[0] != 0x1f || raw[1] != 0x8b {
		t.Fatal("written file does not have gzip magic bytes")
	}

	got := &registrypb.ModuleMetadata{}
	if err := ReadFile(path, got); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(want, got) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestReadWriteFile_JSONGz(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json.gz")

	want := newTestMessage()
	if err := WriteFile(path, want); err != nil {
		t.Fatal(err)
	}

	// Verify inner content is JSON by decompressing manually
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	gr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(gr); err != nil {
		t.Fatal(err)
	}
	gr.Close()
	if buf.Bytes()[0] != '{' {
		t.Fatalf("decompressed content doesn't look like JSON: %q", buf.String()[:20])
	}

	got := &registrypb.ModuleMetadata{}
	if err := ReadFile(path, got); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(want, got) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestReadFile_NotFound(t *testing.T) {
	err := ReadFile("/nonexistent/path/test.pb", &registrypb.ModuleMetadata{})
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestWriteFile_BadPath(t *testing.T) {
	err := WriteFile("/nonexistent/dir/test.pb", newTestMessage())
	if err == nil {
		t.Fatal("expected error for bad path")
	}
}

func TestWritePrettyJSONFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")

	if err := WritePrettyJSONFile(path, newTestMessage()); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Pretty JSON should have newlines and indentation
	if !bytes.Contains(data, []byte("\n")) {
		t.Error("expected multiline JSON output")
	}
	if !bytes.Contains(data, []byte("  ")) {
		t.Error("expected indented JSON output")
	}

	got := &registrypb.ModuleMetadata{}
	if err := ReadFile(path, got); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(newTestMessage(), got) {
		t.Errorf("got %v, want %v", got, newTestMessage())
	}
}

func TestWritePrettyTextFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.textproto")

	if err := WritePrettyTextFile(path, newTestMessage()); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte("\n")) {
		t.Error("expected multiline text output")
	}

	got := &registrypb.ModuleMetadata{}
	if err := ReadFile(path, got); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(newTestMessage(), got) {
		t.Errorf("got %v, want %v", got, newTestMessage())
	}
}
