package main

import (
	"archive/tar"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestCreateTarballIncludesModuleVersionTree(t *testing.T) {
	dir := t.TempDir()
	tree := filepath.Join(dir, "tree")
	relativePath := filepath.Join("modules", "1.0.0", "moduleversion.pb.gz")
	record := filepath.Join(tree, relativePath)
	if err := os.MkdirAll(filepath.Dir(record), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(record, []byte("version details"), 0644); err != nil {
		t.Fatal(err)
	}
	linkedTree := filepath.Join(dir, "linked-tree")
	if err := os.Symlink(tree, linkedTree); err != nil {
		t.Fatal(err)
	}

	archive, err := createTarball(nil, nil, []string{linkedTree}, "")
	if err != nil {
		t.Fatal(err)
	}
	reader := tar.NewReader(bytes.NewReader(archive))
	for {
		entry, err := reader.Next()
		if err == io.EOF {
			t.Fatal("version details are missing from archive")
		}
		if err != nil {
			t.Fatal(err)
		}
		if entry.Name != "modules/"+filepath.ToSlash(relativePath) {
			continue
		}
		data, err := io.ReadAll(reader)
		if err != nil || string(data) != "version details" {
			t.Fatalf("read version record %q: %v", data, err)
		}
		return
	}
}
