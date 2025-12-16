package cf

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHashAssetFile(t *testing.T) {
	tests := []struct {
		name    string
		content []byte
		ext     string
		wantErr bool
	}{
		{
			name:    "simple text file",
			content: []byte("hello world"),
			ext:     ".txt",
			wantErr: false,
		},
		{
			name:    "html file",
			content: []byte("<html><body>test</body></html>"),
			ext:     ".html",
			wantErr: false,
		},
		{
			name:    "empty file",
			content: []byte(""),
			ext:     ".js",
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hash, err := hashAssetFile(tt.content, tt.ext)
			if (err != nil) != tt.wantErr {
				t.Errorf("hashAssetFile() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr {
				if len(hash) != 32 {
					t.Errorf("hashAssetFile() hash length = %d, want 32", len(hash))
				}
				// Verify hash is consistent
				hash2, _ := hashAssetFile(tt.content, tt.ext)
				if hash != hash2 {
					t.Errorf("hashAssetFile() not consistent: %s != %s", hash, hash2)
				}
			}
		})
	}
}

func TestBuildAssetManifest(t *testing.T) {
	// Create temporary directory with test assets
	tmpDir := t.TempDir()

	// Create test files
	testFiles := map[string]string{
		"index.html":      "<html><body>test</body></html>",
		"styles/app.css":  "body { margin: 0; }",
		"scripts/app.js":  "console.log('test');",
		".assetsignore":   "*.log\ntemp/",
		"debug.log":       "should be ignored",
	}

	for path, content := range testFiles {
		fullPath := filepath.Join(tmpDir, path)
		dir := filepath.Dir(fullPath)
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("Failed to create directory: %v", err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
			t.Fatalf("Failed to write test file: %v", err)
		}
	}

	// Build manifest
	manifest, files, err := BuildAssetManifest(tmpDir)
	if err != nil {
		t.Fatalf("BuildAssetManifest() error = %v", err)
	}

	// Check that expected files are in manifest
	expectedFiles := []string{
		"/index.html",
		"/styles/app.css",
		"/scripts/app.js",
	}

	for _, expectedFile := range expectedFiles {
		if _, ok := manifest[expectedFile]; !ok {
			t.Errorf("Expected file %s not found in manifest", expectedFile)
		}
		if _, ok := files[expectedFile]; !ok {
			t.Errorf("Expected file %s not found in files map", expectedFile)
		}
	}

	// Check that ignored files are not in manifest
	if _, ok := manifest["/debug.log"]; ok {
		t.Errorf("Ignored file /debug.log should not be in manifest")
	}

	if _, ok := manifest["/.assetsignore"]; ok {
		t.Errorf(".assetsignore should not be in manifest")
	}

	// Verify hash format
	for path, info := range manifest {
		if len(info.Hash) != 32 {
			t.Errorf("File %s has invalid hash length: %d", path, len(info.Hash))
		}
		if info.Size <= 0 {
			t.Errorf("File %s has invalid size: %d", path, info.Size)
		}
	}
}

func TestShouldIgnore(t *testing.T) {
	patterns := []string{"*.log", "temp", "node_modules"}

	tests := []struct {
		name     string
		path     string
		patterns []string
		want     bool
	}{
		{
			name:     "should ignore log file",
			path:     "/debug.log",
			patterns: patterns,
			want:     true,
		},
		{
			name:     "should ignore temp directory",
			path:     "/temp/file.txt",
			patterns: patterns,
			want:     true,
		},
		{
			name:     "should not ignore regular file",
			path:     "/index.html",
			patterns: patterns,
			want:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldIgnore(tt.path, tt.patterns); got != tt.want {
				t.Errorf("shouldIgnore() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGetContentType(t *testing.T) {
	tests := []struct {
		filename string
		want     string
	}{
		{
			filename: "index.html",
			want:     "text/html; charset=utf-8",
		},
		{
			filename: "app.js",
			want:     "text/javascript; charset=utf-8",
		},
		{
			filename: "styles.css",
			want:     "text/css; charset=utf-8",
		},
		{
			filename: "image.png",
			want:     "image/png",
		},
		{
			filename: "data.bin",
			want:     "application/octet-stream",
		},
		{
			filename: "/path/to/index.html",
			want:     "text/html; charset=utf-8",
		},
		{
			filename: "file.json",
			want:     "application/json",
		},
		{
			filename: "font.woff2",
			want:     "font/woff2",
		},
	}

	for _, tt := range tests {
		t.Run(tt.filename, func(t *testing.T) {
			got := getContentType(tt.filename)
			if got != tt.want {
				t.Errorf("getContentType() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHashAssetFileDeterministic(t *testing.T) {
	// Verify hashing is deterministic and different content produces different hashes
	content1 := []byte("content version 1")
	content2 := []byte("content version 2")

	hash1a, err := hashAssetFile(content1, ".html")
	if err != nil {
		t.Fatalf("hashAssetFile() error = %v", err)
	}

	hash1b, err := hashAssetFile(content1, ".html")
	if err != nil {
		t.Fatalf("hashAssetFile() error = %v", err)
	}

	hash2, err := hashAssetFile(content2, ".html")
	if err != nil {
		t.Fatalf("hashAssetFile() error = %v", err)
	}

	// Same content should produce same hash
	if hash1a != hash1b {
		t.Errorf("Hashing is not deterministic: %s != %s", hash1a, hash1b)
	}

	// Different content should produce different hash
	if hash1a == hash2 {
		t.Errorf("Different content produced same hash: %s", hash1a)
	}

	// Different extensions should produce different hashes for same content
	hashHTML, _ := hashAssetFile(content1, ".html")
	hashCSS, _ := hashAssetFile(content1, ".css")
	if hashHTML == hashCSS {
		t.Errorf("Different extensions produced same hash: %s", hashHTML)
	}
}

func TestAssetInfoStructure(t *testing.T) {
	// Verify AssetInfo structure is correct
	info := AssetInfo{
		Hash: "abc123def456",
		Size: 1024,
	}

	if info.Hash != "abc123def456" {
		t.Errorf("AssetInfo.Hash = %s, want abc123def456", info.Hash)
	}

	if info.Size != 1024 {
		t.Errorf("AssetInfo.Size = %d, want 1024", info.Size)
	}
}
