package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/bazel-contrib/bcr-frontend/pkg/paramsfile"
)

const toolName = "releasecompiler"

type Config struct {
	OutputFile                string
	IndexHtmlFile             string
	RegistryFile              string
	ModuleRegistrySymbolsFile string
	BazelFlagDbFile           string
	PrerenderedPagesTar       string
	AssetFiles                []string
	ModulesSrcFiles           stringSliceFlag
	ExcludeFromHash           map[string]bool // basenames to exclude from hashing
}

// stringSliceFlag is a custom flag type for repeatable flags
type stringSliceFlag []string

func (s *stringSliceFlag) String() string { return strings.Join(*s, ",") }
func (s *stringSliceFlag) Set(value string) error {
	*s = append(*s, value)
	return nil
}

type HashedAsset struct {
	OriginalPath string
	OriginalName string
	HashedName   string
	Content      []byte
}

func main() {
	log.SetPrefix(toolName + ": ")
	log.SetOutput(os.Stderr)
	log.SetFlags(0) // don't print timestamps

	if err := run(os.Args[1:]); err != nil {
		log.Fatal(err)
	}
}

func run(args []string) error {
	parsedArgs, err := paramsfile.ReadArgsParamsFile(args)
	if err != nil {
		return fmt.Errorf("failed to read params file: %v", err)
	}

	cfg, err := parseFlags(parsedArgs)
	if err != nil {
		return fmt.Errorf("failed to parse args: %v", err)
	}

	if cfg.OutputFile == "" {
		return fmt.Errorf("output_file is required")
	}
	if cfg.IndexHtmlFile == "" {
		return fmt.Errorf("index_html_file is required")
	}

	// Read and process assets
	assets, err := processAssets(cfg.AssetFiles, cfg.ExcludeFromHash)
	if err != nil {
		return fmt.Errorf("failed to process assets: %v", err)
	}

	registryAssets, err := processRegistryFile(cfg.RegistryFile)
	if err != nil {
		return fmt.Errorf("failed to process registry file: %v", err)
	}
	for _, asset := range registryAssets {
		assets = append(assets, asset)
		log.Printf("Processed registry file: %s -> %s", asset.OriginalName, asset.HashedName)
	}

	symbolsAssets, err := processModuleRegistrySymbolsFile(cfg.ModuleRegistrySymbolsFile)
	if err != nil {
		return fmt.Errorf("failed to process symbols file: %v", err)
	}
	for _, asset := range symbolsAssets {
		assets = append(assets, asset)
		log.Printf("Processed symbols file: %s -> %s", asset.OriginalName, asset.HashedName)
	}

	flagDbAssets, err := processBazelFlagDbFile(cfg.BazelFlagDbFile)
	if err != nil {
		return fmt.Errorf("failed to process bazel flag db file: %v", err)
	}
	for _, asset := range flagDbAssets {
		assets = append(assets, asset)
		log.Printf("Processed bazel flag db file: %s -> %s", asset.OriginalName, asset.HashedName)
	}

	// Read and update index.html
	indexContent, err := updateIndexHtml(cfg.IndexHtmlFile, assets)
	if err != nil {
		return fmt.Errorf("failed to update index.html: %v", err)
	}

	// Create tarball
	tarball, err := createTarball(indexContent, assets, cfg.ModulesSrcFiles, cfg.PrerenderedPagesTar)
	if err != nil {
		return fmt.Errorf("failed to create tarball: %v", err)
	}

	// Write output
	if err := os.WriteFile(cfg.OutputFile, tarball, 0644); err != nil {
		return fmt.Errorf("failed to write output file: %v", err)
	}

	log.Printf("Successfully created %s with %d assets", cfg.OutputFile, len(assets))
	return nil
}

func processRegistryFile(registryPath string) ([]HashedAsset, error) {
	// Read the registry file
	content, err := os.ReadFile(registryPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read registry file: %v", err)
	}

	// Gzip the content
	var gzipBuf bytes.Buffer
	gzipWriter := gzip.NewWriter(&gzipBuf)
	if _, err := gzipWriter.Write(content); err != nil {
		return nil, fmt.Errorf("failed to gzip content: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		return nil, fmt.Errorf("failed to close gzip writer: %v", err)
	}
	gzipContent := gzipBuf.Bytes()

	b64Content, err := base64GzipEncode(content)
	if err != nil {
		return nil, fmt.Errorf("b64gz encoding: %v", err)
	}

	// Create JS file content
	jsContent := fmt.Appendf(nil, "const REGISTRY_DATA = \"%s\";\n", b64Content)

	// Generate filename: registry.pb.gz.b64.js
	jsOriginalName := "registry.pb.gz.b64.js"
	jsHashedName := hashFilename(jsOriginalName, jsContent)

	// Also include the raw gzipped registry.pb.gz (no hashing - keep predictable name)
	gzOriginalName := "registry.pb.gz"

	return []HashedAsset{
		{
			OriginalPath: registryPath,
			OriginalName: jsOriginalName,
			HashedName:   jsHashedName,
			Content:      jsContent,
		},
		{
			OriginalPath: registryPath,
			OriginalName: gzOriginalName,
			HashedName:   gzOriginalName, // No hashing - keep original name
			Content:      gzipContent,
		},
	}, nil
}

func processModuleRegistrySymbolsFile(documentationRegistryPath string) ([]HashedAsset, error) {
	if documentationRegistryPath == "" {
		panic("symbols file path is required")
	}

	// Read the symbols file
	content, err := os.ReadFile(documentationRegistryPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read doc registry file: %v", err)
	}

	// Gzip the content
	var gzipBuf bytes.Buffer
	gzipWriter := gzip.NewWriter(&gzipBuf)
	if _, err := gzipWriter.Write(content); err != nil {
		return nil, fmt.Errorf("failed to gzip content: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		return nil, fmt.Errorf("failed to close gzip writer: %v", err)
	}
	gzipContent := gzipBuf.Bytes()

	// Hash the gzip filename so the URL changes on every content-changing
	// deploy. The frontend discovers the hashed name via a {symbols.pb.gz}
	// placeholder in index.html.
	gzOriginalName := "symbols.pb.gz"
	gzHashedName := hashFilename(gzOriginalName, gzipContent)

	return []HashedAsset{
		{
			OriginalPath: documentationRegistryPath,
			OriginalName: gzOriginalName,
			HashedName:   gzHashedName,
			Content:      gzipContent,
		},
	}, nil
}

// processBazelFlagDbFile gzips the BazelFlagDb proto and emits it as a
// content-hashed bazelflagdb.<hash>.pb.gz at the tarball root. The frontend
// fetches it lazily on first navigation to /bazel/flags via a meta-tag URL.
// An empty path is treated as "skip" so the flag is optional during partial
// builds.
func processBazelFlagDbFile(flagDbPath string) ([]HashedAsset, error) {
	if flagDbPath == "" {
		return nil, nil
	}
	content, err := os.ReadFile(flagDbPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read flag db file: %v", err)
	}

	var gzipBuf bytes.Buffer
	gzipWriter := gzip.NewWriter(&gzipBuf)
	if _, err := gzipWriter.Write(content); err != nil {
		return nil, fmt.Errorf("failed to gzip content: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		return nil, fmt.Errorf("failed to close gzip writer: %v", err)
	}
	gzipContent := gzipBuf.Bytes()

	gzOriginalName := "bazelflagdb.pb.gz"
	gzHashedName := hashFilename(gzOriginalName, gzipContent)
	return []HashedAsset{
		{
			OriginalPath: flagDbPath,
			OriginalName: gzOriginalName,
			HashedName:   gzHashedName,
			Content:      gzipContent,
		},
	}, nil
}

func base64GzipEncode(data []byte) (string, error) {
	var gzipBuf bytes.Buffer
	gzipWriter := gzip.NewWriter(&gzipBuf)
	if _, err := gzipWriter.Write(data); err != nil {
		return "", fmt.Errorf("failed to gzip content: %v", err)
	}
	if err := gzipWriter.Close(); err != nil {
		return "", fmt.Errorf("failed to close gzip writer: %v", err)
	}
	return base64.StdEncoding.EncodeToString(gzipBuf.Bytes()), nil
}

func processAssets(assetFiles []string, excludeFromHash map[string]bool) ([]HashedAsset, error) {
	var assets []HashedAsset

	for _, path := range assetFiles {
		content, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("failed to read %s: %v", path, err)
		}

		originalName := filepath.Base(path)
		hashedName := originalName

		// Check if this file should be excluded from hashing
		if !excludeFromHash[originalName] {
			hashedName = hashFilename(originalName, content)
		}

		assets = append(assets, HashedAsset{
			OriginalPath: path,
			OriginalName: originalName,
			HashedName:   hashedName,
			Content:      content,
		})

		if hashedName != originalName {
			log.Printf("Hashed %s -> %s", originalName, hashedName)
		} else if excludeFromHash[originalName] {
			log.Printf("Excluded %s from hashing", originalName)
		}
	}

	return assets, nil
}

func hashFilename(filename string, content []byte) string {
	// Calculate SHA256 hash
	hash := sha256.Sum256(content)
	hashStr := hex.EncodeToString(hash[:])[:8] // Use first 8 chars

	// Find the first dot to split the base name from extensions
	// e.g., "registry.pb.gz.b64.js" -> "registry" + ".pb.gz.b64.js"
	firstDot := strings.Index(filename, ".")
	if firstDot == -1 {
		// No extension, just append hash
		return fmt.Sprintf("%s.%s", filename, hashStr)
	}

	baseName := filename[:firstDot]
	extensions := filename[firstDot:]

	return fmt.Sprintf("%s.%s%s", baseName, hashStr, extensions)
}

func updateIndexHtml(indexPath string, assets []HashedAsset) ([]byte, error) {
	content, err := os.ReadFile(indexPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read index.html: %v", err)
	}

	htmlStr := string(content)

	// Replace placeholders like {filename} with hashed versions
	// This ensures we don't accidentally replace substrings
	for _, asset := range assets {
		placeholder := fmt.Sprintf("{%s}", asset.OriginalName)
		if strings.Contains(htmlStr, placeholder) {
			htmlStr = strings.ReplaceAll(htmlStr, placeholder, asset.HashedName)
			log.Printf("Replaced {%s} with %s in index.html", asset.OriginalName, asset.HashedName)
		}
	}

	return []byte(htmlStr), nil
}

func createTarball(indexContent []byte, assets []HashedAsset, modulesSrcFiles []string, prerenderedPagesTar string) ([]byte, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)

	// Add index.html
	if err := addFileToTar(tw, "index.html", indexContent); err != nil {
		return nil, fmt.Errorf("failed to add index.html: %v", err)
	}

	// Add all assets with their hashed names
	for _, asset := range assets {
		if err := addFileToTar(tw, asset.HashedName, asset.Content); err != nil {
			return nil, fmt.Errorf("failed to add %s: %v", asset.HashedName, err)
		}
	}

	// Add modules_src files preserving path relative to "modules/"
	for _, path := range modulesSrcFiles {
		const marker = "modules/"
		idx := strings.LastIndex(path, marker)
		if idx == -1 {
			return nil, fmt.Errorf("modules_src file %q does not contain %q in its path", path, marker)
		}
		tarName := path[idx:] // e.g. "modules/rules_pkg/1.2.0/documentationinfo.json.gz"

		content, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("failed to read modules_src %s: %v", path, err)
		}
		if err := addFileToTar(tw, tarName, content); err != nil {
			return nil, fmt.Errorf("failed to add %s: %v", tarName, err)
		}
	}

	// Merge entries from a prerendered-pages tarball, if provided. Entries
	// are added at their existing paths (e.g. modules/rules_buf/index.html)
	// without rewriting; the prerender ran against the unprerendered tarball
	// which already had hashed asset names stamped, so references inside
	// these HTML files match the assets shipped here.
	if prerenderedPagesTar != "" {
		count, err := mergePrerenderedPages(tw, prerenderedPagesTar)
		if err != nil {
			return nil, fmt.Errorf("failed to merge prerendered_pages_tar: %v", err)
		}
		log.Printf("Merged %d prerendered page(s) from %s", count, prerenderedPagesTar)
	}

	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("failed to close tar writer: %v", err)
	}

	return buf.Bytes(), nil
}

// mergePrerenderedPages reads the input tar at path and copies each regular
// file entry into tw at the same name. Returns the number of entries copied.
// Skips directory entries; preserves leading "./" stripping for consistency
// with the rest of this tool's tar entries.
func mergePrerenderedPages(tw *tar.Writer, path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("open %s: %v", path, err)
	}
	defer f.Close()

	tr := tar.NewReader(f)
	count := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return count, fmt.Errorf("read entry: %v", err)
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}
		content, err := io.ReadAll(tr)
		if err != nil {
			return count, fmt.Errorf("read content of %s: %v", hdr.Name, err)
		}
		name := strings.TrimPrefix(hdr.Name, "./")
		if name == "" {
			continue
		}
		if err := addFileToTar(tw, name, content); err != nil {
			return count, fmt.Errorf("add %s: %v", name, err)
		}
		count++
	}
	return count, nil
}

func addFileToTar(tw *tar.Writer, name string, content []byte) error {
	header := &tar.Header{
		Name: name,
		Mode: 0644,
		Size: int64(len(content)),
	}

	if err := tw.WriteHeader(header); err != nil {
		return err
	}

	if _, err := io.Copy(tw, bytes.NewReader(content)); err != nil {
		return err
	}

	return nil
}

func parseFlags(args []string) (cfg Config, err error) {
	var excludeFromHashStr string

	fs := flag.NewFlagSet(toolName, flag.ExitOnError)
	fs.StringVar(&cfg.OutputFile, "output_file", "", "the output file to write")
	fs.StringVar(&cfg.IndexHtmlFile, "index_html_file", "", "the index.html file to read")
	fs.StringVar(&cfg.RegistryFile, "registry_file", "", "the registry protobuf file to process (gzipped and base64 encoded)")
	fs.StringVar(&cfg.ModuleRegistrySymbolsFile, "module_registry_symbols_file", "", "the documentation registry protobuf file to process (gzipped and base64 encoded)")
	fs.StringVar(&cfg.BazelFlagDbFile, "bazel_flag_db_file", "", "the bazel flag database protobuf file (gzipped into the tarball as bazelflagdb.pb.gz)")
	fs.StringVar(&cfg.PrerenderedPagesTar, "prerendered_pages_tar", "", "optional tar of prerendered HTML files to merge into the output tarball verbatim (entries are added as-is)")
	fs.Var(&cfg.ModulesSrcFiles, "modules_src", "a file to include under modules/ in the tarball (repeatable)")
	fs.StringVar(&excludeFromHashStr, "exclude_from_hash", "", "comma-separated list of basenames to exclude from hashing (e.g., favicon.png,robots.txt)")
	fs.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: %s @PARAMS_FILE", toolName)
		fs.PrintDefaults()
	}

	if err = fs.Parse(args); err != nil {
		return
	}

	cfg.AssetFiles = fs.Args()
	// log.Println("assets:", cfg.AssetFiles)
	// Parse exclude list into map for fast lookup
	cfg.ExcludeFromHash = make(map[string]bool)
	if excludeFromHashStr != "" {
		for _, name := range strings.Split(excludeFromHashStr, ",") {
			trimmed := strings.TrimSpace(name)
			if trimmed != "" {
				cfg.ExcludeFromHash[trimmed] = true
			}
		}
	}

	return
}
