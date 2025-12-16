package cf

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/zeebo/blake3"
	"golang.org/x/sync/errgroup"
)

const (
	maxAssetSize      = 25 * 1024 * 1024 // 25 MB
	uploadConcurrency = 3
	maxUploadAttempts = 5
)

// AssetInfo represents metadata about an asset file
type AssetInfo struct {
	Hash string `json:"hash"`
	Size int64  `json:"size"`
}

// InitializeAssetsRequest is the request to initialize an asset upload session
type InitializeAssetsRequest struct {
	Manifest map[string]AssetInfo `json:"manifest"`
}

// InitializeAssetsResponse is the response from initializing an asset upload session
type InitializeAssetsResponse struct {
	JWT     string     `json:"jwt"`
	Buckets [][]string `json:"buckets"`
}

// AssetUploadResponse is the response from uploading an asset batch
type AssetUploadResponse struct {
	JWT string `json:"jwt"`
}

// BuildAssetManifest scans a directory and builds a manifest of all assets
func BuildAssetManifest(assetDir string) (map[string]AssetInfo, map[string][]byte, error) {
	manifest := make(map[string]AssetInfo)
	files := make(map[string][]byte)

	// Load ignore patterns if .assetsignore exists
	ignorePatterns, err := loadAssetsIgnore(assetDir)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to load .assetsignore: %w", err)
	}

	err = filepath.Walk(assetDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip directories
		if info.IsDir() {
			return nil
		}

		// Skip symbolic links
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}

		// Get relative path
		relPath, err := filepath.Rel(assetDir, path)
		if err != nil {
			return fmt.Errorf("failed to get relative path: %w", err)
		}

		// Normalize to forward slashes with leading /
		normalizedPath := "/" + filepath.ToSlash(relPath)

		// Check if path should be ignored
		if shouldIgnore(normalizedPath, ignorePatterns) {
			return nil
		}

		// Check file size
		if info.Size() > maxAssetSize {
			return fmt.Errorf("asset %s exceeds maximum size of 25MB", normalizedPath)
		}

		// Read file content
		content, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("failed to read file %s: %w", path, err)
		}

		// Calculate Blake3 hash
		hash, err := hashAssetFile(content, filepath.Ext(path))
		if err != nil {
			return fmt.Errorf("failed to hash file %s: %w", path, err)
		}

		manifest[normalizedPath] = AssetInfo{
			Hash: hash,
			Size: info.Size(),
		}
		files[normalizedPath] = content

		return nil
	})

	if err != nil {
		return nil, nil, err
	}

	return manifest, files, nil
}

// hashAssetFile calculates the Blake3 hash for an asset file Following
// wrangler's implementation: hash(base64(content) + extension)
func hashAssetFile(content []byte, ext string) (string, error) {
	// Base64 encode the content
	encoded := base64.StdEncoding.EncodeToString(content)

	// Create hasher
	hasher := blake3.New()

	// Write base64 content
	if _, err := hasher.Write([]byte(encoded)); err != nil {
		return "", err
	}

	// Write extension
	if _, err := hasher.Write([]byte(ext)); err != nil {
		return "", err
	}

	// Get hash and take first 32 characters
	hashBytes := hasher.Sum(nil)
	hashHex := hex.EncodeToString(hashBytes)

	if len(hashHex) > 32 {
		hashHex = hashHex[:32]
	}

	return hashHex, nil
}

// loadAssetsIgnore loads patterns from .assetsignore file
func loadAssetsIgnore(assetDir string) ([]string, error) {
	ignorePath := filepath.Join(assetDir, ".assetsignore")

	file, err := os.Open(ignorePath)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var patterns []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// Skip empty lines and comments
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		patterns = append(patterns, line)
	}

	return patterns, scanner.Err()
}

// shouldIgnore checks if a path matches any ignore patterns
// Simple implementation - can be enhanced with proper gitignore-style matching
func shouldIgnore(path string, patterns []string) bool {
	// Always ignore .assetsignore itself
	if strings.HasSuffix(path, ".assetsignore") {
		return true
	}

	for _, pattern := range patterns {
		// Simple wildcard matching for *.ext
		if strings.HasPrefix(pattern, "*.") {
			ext := pattern[1:]
			if strings.HasSuffix(path, ext) {
				return true
			}
		}
		// Directory matching
		if strings.HasPrefix(path, "/"+pattern) {
			return true
		}
		// Check if pattern matches filename
		if strings.HasSuffix(path, "/"+pattern) {
			return true
		}
	}
	return false
}

// InitializeAssetUploadSession initializes an asset upload session
func (c *Client) InitializeAssetUploadSession(scriptName string, manifest map[string]AssetInfo) (*InitializeAssetsResponse, error) {
	path := fmt.Sprintf("/accounts/%s/workers/scripts/%s/assets-upload-session", c.accountID, scriptName)

	req := InitializeAssetsRequest{
		Manifest: manifest,
	}

	resp, err := c.doRequest("POST", path, req)
	if err != nil {
		return nil, err
	}

	var result InitializeAssetsResponse
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	return &result, nil
}

// UploadAssetBatch uploads a batch of assets using multipart form data
func (c *Client) UploadAssetBatch(jwt string, bucket []string, assetFiles map[string][]byte, manifest map[string]AssetInfo) (string, error) {
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	// For each hash in the bucket, find the corresponding file
	for _, hash := range bucket {
		// Find the file with this hash
		var filename string
		var content []byte
		for path, info := range manifest {
			if info.Hash == hash {
				filename = path
				content = assetFiles[path]
				break
			}
		}

		if filename == "" {
			return "", fmt.Errorf("hash %s not found in manifest", hash)
		}

		// Base64 encode the content
		encoded := base64.StdEncoding.EncodeToString(content)

		// Determine content type from original filename
		contentType := getContentType(filename)

		c.logf("Uploading asset: %s (hash: %s, content-type: %s)", filename, hash[:8], contentType)

		// Create form part with proper Content-Type header
		h := make(map[string][]string)
		h["Content-Disposition"] = []string{fmt.Sprintf(`form-data; name="%s"; filename="%s"`, hash, hash)}
		if contentType != "application/null" && contentType != "" {
			h["Content-Type"] = []string{contentType}
		}

		part, err := writer.CreatePart(h)
		if err != nil {
			return "", fmt.Errorf("failed to create form part for %s: %w", filename, err)
		}

		// Write base64 content
		if _, err := part.Write([]byte(encoded)); err != nil {
			return "", fmt.Errorf("failed to write file %s: %w", filename, err)
		}
	}

	if err := writer.Close(); err != nil {
		return "", fmt.Errorf("failed to close multipart writer: %w", err)
	}

	// Upload to Cloudflare
	url := fmt.Sprintf("%s/accounts/%s/workers/assets/upload?base64=true", apiBaseURL, c.accountID)

	req, err := http.NewRequest("POST", url, &buf)
	if err != nil {
		return "", fmt.Errorf("failed to create upload request: %w", err)
	}

	// Use JWT for authorization instead of API token
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to upload batch: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusAccepted {
		c.logf("Upload failed with status %d, response: %s", resp.StatusCode, string(respBody))
		return "", fmt.Errorf("upload failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	c.logf("Upload response (status %d): %s", resp.StatusCode, string(respBody))

	// Parse API response wrapper
	var apiResp APIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		c.logf("Could not unmarshal API response, keeping same JWT: %v", err)
		return jwt, nil
	}

	// Extract JWT from result
	var uploadResp AssetUploadResponse
	if err := json.Unmarshal(apiResp.Result, &uploadResp); err != nil {
		c.logf("Could not unmarshal upload response result, keeping same JWT: %v", err)
		return jwt, nil
	}

	// If JWT is empty in response, keep the current one
	if uploadResp.JWT == "" {
		c.logf("No JWT in upload response, keeping same JWT")
		return jwt, nil
	}

	return uploadResp.JWT, nil
}

// getContentType determines the MIME type for a file
func getContentType(filename string) string {
	contentType := mime.TypeByExtension(filepath.Ext(filename))

	if contentType == "" {
		return "application/octet-stream"
	}

	// Add charset for text files
	if strings.HasPrefix(contentType, "text/") && !strings.Contains(contentType, "charset") {
		contentType = contentType + "; charset=utf-8"
	}

	return contentType
}

// SyncAssets orchestrates the complete asset upload process
func (c *Client) SyncAssets(scriptName string, assetDir string) (string, error) {
	// Build manifest
	manifest, files, err := BuildAssetManifest(assetDir)
	if err != nil {
		return "", fmt.Errorf("failed to build asset manifest: %w", err)
	}

	if len(manifest) == 0 {
		return "", fmt.Errorf("no assets found in %s", assetDir)
	}

	c.logf("Found %d assets in manifest", len(manifest))
	for path, info := range manifest {
		c.logf("  %s (%d bytes)", path, info.Size)
	}

	// Initialize upload session
	initResp, err := c.InitializeAssetUploadSession(scriptName, manifest)
	if err != nil {
		return "", fmt.Errorf("failed to initialize asset upload session: %w", err)
	}

	// If no buckets, all files already exist
	totalFiles := 0
	for _, bucket := range initResp.Buckets {
		totalFiles += len(bucket)
	}

	if totalFiles == 0 {
		c.logf("All assets already exist on server, skipping upload")
		return initResp.JWT, nil
	}

	c.logf("Uploading %d new/modified assets in %d batches", totalFiles, len(initResp.Buckets))

	// Upload buckets - use the initial JWT for first upload
	// Each upload response returns a new JWT that must be used for the next upload
	// The last JWT returned is the completion JWT used for deployment
	uploadJWT := initResp.JWT
	completionJWT := initResp.JWT

	for i, bucket := range initResp.Buckets {
		c.logf("Uploading batch %d/%d (%d assets)", i+1, len(initResp.Buckets), len(bucket))

		// Upload with retries
		var uploadErr error
		var newJWT string
		for attempt := 0; attempt < maxUploadAttempts; attempt++ {
			if attempt > 0 {
				// Exponential backoff
				backoff := time.Duration(1<<uint(attempt)) * time.Second
				c.logf("Retry attempt %d after %v", attempt, backoff)
				time.Sleep(backoff)
			}

			newJWT, err = c.UploadAssetBatch(uploadJWT, bucket, files, manifest)
			if err != nil {
				uploadErr = err
				continue
			}

			uploadErr = nil
			break
		}

		if uploadErr != nil {
			return "", fmt.Errorf("failed to upload bucket %d/%d after %d attempts: %w",
				i+1, len(initResp.Buckets), maxUploadAttempts, uploadErr)
		}

		// Update completion JWT with the latest response
		completionJWT = newJWT
		c.logf("✓ Batch %d/%d uploaded successfully", i+1, len(initResp.Buckets))
	}

	// Return the completion JWT from the last upload for deployment
	c.logf("Asset sync complete")
	return completionJWT, nil
}

// SyncAssetsParallel uploads assets in parallel (more advanced implementation)
func (c *Client) SyncAssetsParallel(scriptName string, assetDir string) (string, error) {
	// Build manifest
	manifest, files, err := BuildAssetManifest(assetDir)
	if err != nil {
		return "", fmt.Errorf("failed to build asset manifest: %w", err)
	}

	if len(manifest) == 0 {
		return "", fmt.Errorf("no assets found in %s", assetDir)
	}

	// Initialize upload session
	initResp, err := c.InitializeAssetUploadSession(scriptName, manifest)
	if err != nil {
		return "", fmt.Errorf("failed to initialize asset upload session: %w", err)
	}

	// If no buckets, all files already exist
	totalFiles := 0
	for _, bucket := range initResp.Buckets {
		totalFiles += len(bucket)
	}

	if totalFiles == 0 {
		return initResp.JWT, nil
	}

	// Upload buckets in parallel
	type bucketResult struct {
		index int
		jwt   string
		err   error
	}

	results := make([]bucketResult, len(initResp.Buckets))
	currentJWT := initResp.JWT

	// Create error group with concurrency limit
	g := new(errgroup.Group)
	g.SetLimit(uploadConcurrency)

	for i, bucket := range initResp.Buckets {
		i := i
		bucket := bucket

		g.Go(func() error {
			var uploadErr error
			var newJWT string

			for attempt := 0; attempt < maxUploadAttempts; attempt++ {
				if attempt > 0 {
					backoff := time.Duration(1<<uint(attempt)) * time.Second
					time.Sleep(backoff)
				}

				newJWT, uploadErr = c.UploadAssetBatch(currentJWT, bucket, files, manifest)
				if uploadErr == nil {
					break
				}
			}

			results[i] = bucketResult{
				index: i,
				jwt:   newJWT,
				err:   uploadErr,
			}

			return uploadErr
		})
	}

	if err := g.Wait(); err != nil {
		return "", fmt.Errorf("failed to upload assets: %w", err)
	}

	// Get the last JWT (they should all be the same, but use the last one)
	lastJWT := currentJWT
	for _, result := range results {
		if result.jwt != "" {
			lastJWT = result.jwt
		}
	}

	return lastJWT, nil
}
