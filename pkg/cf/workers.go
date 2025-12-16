package cf

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
)

// WorkerDeployment represents a deployed Worker
type WorkerDeployment struct {
	ID                string   `json:"id"`
	ScriptName        string   `json:"script_name"`
	CompatibilityDate string   `json:"compatibility_date"`
	CreatedOn         string   `json:"created_on"`
	ModifiedOn        string   `json:"modified_on"`
	Tags              []string `json:"tags"`
}

// WorkerMetadata represents metadata for a Worker deployment
type WorkerMetadata struct {
	MainModule         string        `json:"main_module,omitempty"`
	CompatibilityDate  string        `json:"compatibility_date,omitempty"`
	CompatibilityFlags []string      `json:"compatibility_flags,omitempty"`
	Bindings           []interface{} `json:"bindings,omitempty"`
	Assets             *AssetConfig  `json:"assets,omitempty"`
}

// AssetConfig represents asset configuration in Worker metadata
type AssetConfig struct {
	JWT    string            `json:"jwt"`
	Config AssetRouterConfig `json:"config"`
}

// AssetRouterConfig represents routing configuration for assets
type AssetRouterConfig struct {
	HTMLHandling     string `json:"html_handling,omitempty"`
	NotFoundHandling string `json:"not_found_handling,omitempty"`
	RunWorkerFirst   bool   `json:"run_worker_first,omitempty"`
}

// WorkerDeployOptions contains options for deploying a Worker
type WorkerDeployOptions struct {
	CompatibilityDate  string
	CompatibilityFlags []string
	Bindings           []interface{}
	AssetConfig        *AssetRouterConfig
}

// DeployWorkerWithAssets deploys a Worker script with assets
func (c *Client) DeployWorkerWithAssets(scriptName, scriptPath, assetDir string, options WorkerDeployOptions) (*WorkerDeployment, error) {
	// Sync assets first
	assetsJWT, err := c.SyncAssets(scriptName, assetDir)
	if err != nil {
		return nil, fmt.Errorf("failed to sync assets: %w", err)
	}

	// Read Worker script
	scriptContent, err := os.ReadFile(scriptPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read worker script: %w", err)
	}

	// Build metadata
	scriptFilename := filepath.Base(scriptPath)
	metadata := WorkerMetadata{
		MainModule:         scriptFilename,
		CompatibilityDate:  options.CompatibilityDate,
		CompatibilityFlags: options.CompatibilityFlags,
		Bindings:           options.Bindings,
	}

	// Add ASSETS binding if we have assets
	if assetsJWT != "" {
		assetsBinding := map[string]interface{}{
			"type": "assets",
			"name": "ASSETS",
		}

		// Add binding to list
		if metadata.Bindings == nil {
			metadata.Bindings = []interface{}{}
		}
		metadata.Bindings = append(metadata.Bindings, assetsBinding)

		// Set asset configuration
		assetConfig := options.AssetConfig
		if assetConfig == nil {
			assetConfig = &AssetRouterConfig{
				HTMLHandling:     "auto-trailing-slash",
				NotFoundHandling: "single-page-application",
			}
		}
		metadata.Assets = &AssetConfig{
			JWT:    assetsJWT,
			Config: *assetConfig,
		}
	}

	// Create multipart form
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	// Add metadata
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal metadata: %w", err)
	}

	if err := writer.WriteField("metadata", string(metadataJSON)); err != nil {
		return nil, fmt.Errorf("failed to write metadata field: %w", err)
	}

	c.logf("Deploying Worker with metadata: %s", string(metadataJSON))

	// Add Worker script as a module
	// Note: We need to use CreatePart to set the correct Content-Type header
	h := make(map[string][]string)
	h["Content-Disposition"] = []string{fmt.Sprintf(`form-data; name="%s"; filename="%s"`, scriptFilename, scriptFilename)}
	h["Content-Type"] = []string{"application/javascript+module"}

	scriptPart, err := writer.CreatePart(h)
	if err != nil {
		return nil, fmt.Errorf("failed to create script form part: %w", err)
	}

	if _, err := scriptPart.Write(scriptContent); err != nil {
		return nil, fmt.Errorf("failed to write script content: %w", err)
	}

	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("failed to close multipart writer: %w", err)
	}

	// Upload to Cloudflare
	url := fmt.Sprintf("%s/accounts/%s/workers/scripts/%s", apiBaseURL, c.accountID, scriptName)

	req, err := http.NewRequest("PUT", url, &buf)
	if err != nil {
		return nil, fmt.Errorf("failed to create deploy request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to deploy worker: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("deploy failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	var apiResp APIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	if !apiResp.Success {
		if len(apiResp.Errors) > 0 {
			return nil, apiResp.Errors[0]
		}
		return nil, fmt.Errorf("deploy failed without error details")
	}

	var deployment WorkerDeployment
	if err := json.Unmarshal(apiResp.Result, &deployment); err != nil {
		return nil, fmt.Errorf("failed to unmarshal deployment: %w", err)
	}

	return &deployment, nil
}

// DeployWorker deploys a Worker script without assets
func (c *Client) DeployWorker(scriptName, scriptPath string, options WorkerDeployOptions) (*WorkerDeployment, error) {
	// Read Worker script
	scriptContent, err := os.ReadFile(scriptPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read worker script: %w", err)
	}

	// Build metadata
	metadata := WorkerMetadata{
		MainModule:         filepath.Base(scriptPath),
		CompatibilityDate:  options.CompatibilityDate,
		CompatibilityFlags: options.CompatibilityFlags,
		Bindings:           options.Bindings,
	}

	// Create multipart form
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	// Add metadata
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal metadata: %w", err)
	}

	if err := writer.WriteField("metadata", string(metadataJSON)); err != nil {
		return nil, fmt.Errorf("failed to write metadata field: %w", err)
	}

	// Add Worker script
	scriptPart, err := writer.CreateFormFile(filepath.Base(scriptPath), filepath.Base(scriptPath))
	if err != nil {
		return nil, fmt.Errorf("failed to create script form file: %w", err)
	}

	if _, err := scriptPart.Write(scriptContent); err != nil {
		return nil, fmt.Errorf("failed to write script content: %w", err)
	}

	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("failed to close multipart writer: %w", err)
	}

	// Upload to Cloudflare
	url := fmt.Sprintf("%s/accounts/%s/workers/scripts/%s", apiBaseURL, c.accountID, scriptName)

	req, err := http.NewRequest("PUT", url, &buf)
	if err != nil {
		return nil, fmt.Errorf("failed to create deploy request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to deploy worker: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("deploy failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	var apiResp APIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	if !apiResp.Success {
		if len(apiResp.Errors) > 0 {
			return nil, apiResp.Errors[0]
		}
		return nil, fmt.Errorf("deploy failed without error details")
	}

	var deployment WorkerDeployment
	if err := json.Unmarshal(apiResp.Result, &deployment); err != nil {
		return nil, fmt.Errorf("failed to unmarshal deployment: %w", err)
	}

	return &deployment, nil
}

// GetWorker retrieves information about a Worker
func (c *Client) GetWorker(scriptName string) (*WorkerDeployment, error) {
	path := fmt.Sprintf("/accounts/%s/workers/scripts/%s", c.accountID, scriptName)

	resp, err := c.doRequest("GET", path, nil)
	if err != nil {
		return nil, err
	}

	var deployment WorkerDeployment
	if err := json.Unmarshal(resp.Result, &deployment); err != nil {
		return nil, fmt.Errorf("failed to unmarshal worker: %w", err)
	}

	return &deployment, nil
}

// ListWorkers lists all Workers in the account
func (c *Client) ListWorkers() ([]WorkerDeployment, error) {
	path := fmt.Sprintf("/accounts/%s/workers/scripts", c.accountID)

	resp, err := c.doRequest("GET", path, nil)
	if err != nil {
		return nil, err
	}

	var workers []WorkerDeployment
	if err := json.Unmarshal(resp.Result, &workers); err != nil {
		return nil, fmt.Errorf("failed to unmarshal workers: %w", err)
	}

	return workers, nil
}

// DeleteWorker deletes a Worker
func (c *Client) DeleteWorker(scriptName string) error {
	path := fmt.Sprintf("/accounts/%s/workers/scripts/%s", c.accountID, scriptName)

	_, err := c.doRequest("DELETE", path, nil)
	return err
}

// DeployAssetsOnly deploys assets without a custom worker script
// This creates an assets-only worker that serves static files with SPA support
func (c *Client) DeployAssetsOnly(scriptName, assetDir string, options WorkerDeployOptions) (*WorkerDeployment, error) {
	// Sync assets first
	assetsJWT, err := c.SyncAssets(scriptName, assetDir)
	if err != nil {
		return nil, fmt.Errorf("failed to sync assets: %w", err)
	}

	// Build metadata for assets-only deployment (no main_module)
	assetConfig := options.AssetConfig
	if assetConfig == nil {
		assetConfig = &AssetRouterConfig{
			HTMLHandling:     "auto-trailing-slash",
			NotFoundHandling: "single-page-application",
		}
	}

	metadata := WorkerMetadata{
		CompatibilityDate:  options.CompatibilityDate,
		CompatibilityFlags: options.CompatibilityFlags,
		Assets: &AssetConfig{
			JWT:    assetsJWT,
			Config: *assetConfig,
		},
	}

	// Create multipart form
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)

	// Add metadata
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal metadata: %w", err)
	}

	if err := writer.WriteField("metadata", string(metadataJSON)); err != nil {
		return nil, fmt.Errorf("failed to write metadata field: %w", err)
	}

	c.logf("Deploying assets-only worker with metadata: %s", string(metadataJSON))

	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("failed to close multipart writer: %w", err)
	}

	// Upload to Cloudflare
	url := fmt.Sprintf("%s/accounts/%s/workers/scripts/%s", apiBaseURL, c.accountID, scriptName)

	req, err := http.NewRequest("PUT", url, &buf)
	if err != nil {
		return nil, fmt.Errorf("failed to create deploy request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.apiToken)
	req.Header.Set("Content-Type", writer.FormDataContentType())

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to deploy worker: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("deploy failed with status %d: %s", resp.StatusCode, string(respBody))
	}

	var apiResp APIResponse
	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %w", err)
	}

	if !apiResp.Success {
		if len(apiResp.Errors) > 0 {
			return nil, apiResp.Errors[0]
		}
		return nil, fmt.Errorf("deploy failed without error details")
	}

	var deployment WorkerDeployment
	if err := json.Unmarshal(apiResp.Result, &deployment); err != nil {
		return nil, fmt.Errorf("failed to unmarshal deployment: %w", err)
	}

	return &deployment, nil
}
