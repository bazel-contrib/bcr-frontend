package cf

import (
	"encoding/json"
	"testing"
)

func TestWorkerMetadataStructure(t *testing.T) {
	// Test assets-only worker metadata (no main_module)
	metadata := WorkerMetadata{
		CompatibilityDate: "2024-01-01",
		Assets: &AssetConfig{
			JWT: "test-jwt-token",
			Config: AssetRouterConfig{
				HTMLHandling:     "auto-trailing-slash",
				NotFoundHandling: "single-page-application",
			},
		},
	}

	// Marshal to JSON
	jsonData, err := json.Marshal(metadata)
	if err != nil {
		t.Fatalf("Failed to marshal metadata: %v", err)
	}

	// Verify structure
	var result map[string]interface{}
	if err := json.Unmarshal(jsonData, &result); err != nil {
		t.Fatalf("Failed to unmarshal JSON: %v", err)
	}

	// Verify compatibility_date is set
	if result["compatibility_date"] != "2024-01-01" {
		t.Errorf("compatibility_date = %v, want 2024-01-01", result["compatibility_date"])
	}

	// Verify main_module is not set (assets-only worker)
	if _, ok := result["main_module"]; ok {
		t.Errorf("main_module should not be set for assets-only worker")
	}

	// Verify assets structure
	assets, ok := result["assets"].(map[string]interface{})
	if !ok {
		t.Fatal("assets field is missing or wrong type")
	}

	if assets["jwt"] != "test-jwt-token" {
		t.Errorf("assets.jwt = %v, want test-jwt-token", assets["jwt"])
	}

	config, ok := assets["config"].(map[string]interface{})
	if !ok {
		t.Fatal("assets.config field is missing or wrong type")
	}

	if config["html_handling"] != "auto-trailing-slash" {
		t.Errorf("config.html_handling = %v, want auto-trailing-slash", config["html_handling"])
	}

	if config["not_found_handling"] != "single-page-application" {
		t.Errorf("config.not_found_handling = %v, want single-page-application", config["not_found_handling"])
	}
}

func TestWorkerMetadataWithScript(t *testing.T) {
	// Test worker metadata with script (has main_module)
	metadata := WorkerMetadata{
		MainModule:        "worker.js",
		CompatibilityDate: "2024-01-01",
		Assets: &AssetConfig{
			JWT: "test-jwt-token",
			Config: AssetRouterConfig{
				HTMLHandling:     "auto-trailing-slash",
				NotFoundHandling: "single-page-application",
			},
		},
	}

	// Marshal to JSON
	jsonData, err := json.Marshal(metadata)
	if err != nil {
		t.Fatalf("Failed to marshal metadata: %v", err)
	}

	// Verify structure
	var result map[string]interface{}
	if err := json.Unmarshal(jsonData, &result); err != nil {
		t.Fatalf("Failed to unmarshal JSON: %v", err)
	}

	// Verify main_module is set
	if result["main_module"] != "worker.js" {
		t.Errorf("main_module = %v, want worker.js", result["main_module"])
	}

	// Verify compatibility_date is set
	if result["compatibility_date"] != "2024-01-01" {
		t.Errorf("compatibility_date = %v, want 2024-01-01", result["compatibility_date"])
	}
}

func TestAssetRouterConfig(t *testing.T) {
	tests := []struct {
		name   string
		config AssetRouterConfig
		want   map[string]interface{}
	}{
		{
			name: "SPA configuration",
			config: AssetRouterConfig{
				HTMLHandling:     "auto-trailing-slash",
				NotFoundHandling: "single-page-application",
			},
			want: map[string]interface{}{
				"html_handling":      "auto-trailing-slash",
				"not_found_handling": "single-page-application",
			},
		},
		{
			name: "404 page configuration",
			config: AssetRouterConfig{
				HTMLHandling:     "force-trailing-slash",
				NotFoundHandling: "404-page",
			},
			want: map[string]interface{}{
				"html_handling":      "force-trailing-slash",
				"not_found_handling": "404-page",
			},
		},
		{
			name: "Empty configuration",
			config: AssetRouterConfig{},
			want: map[string]interface{}{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			jsonData, err := json.Marshal(tt.config)
			if err != nil {
				t.Fatalf("Failed to marshal config: %v", err)
			}

			var result map[string]interface{}
			if err := json.Unmarshal(jsonData, &result); err != nil {
				t.Fatalf("Failed to unmarshal JSON: %v", err)
			}

			// Check each expected field
			for key, expectedVal := range tt.want {
				if result[key] != expectedVal {
					t.Errorf("%s = %v, want %v", key, result[key], expectedVal)
				}
			}

			// Check no unexpected fields (except omitempty fields)
			for key := range result {
				if _, ok := tt.want[key]; !ok {
					// This is okay if it's an omitempty field, just verify it's not set
					if result[key] != "" && result[key] != false {
						t.Errorf("Unexpected field %s = %v", key, result[key])
					}
				}
			}
		})
	}
}

func TestWorkerDeploymentStructure(t *testing.T) {
	// Test unmarshaling a WorkerDeployment response
	jsonResp := `{
		"id": "test-deployment-id",
		"script_name": "my-worker",
		"compatibility_date": "2024-01-01",
		"created_on": "2024-01-15T10:30:00Z",
		"modified_on": "2024-01-15T10:30:00Z",
		"tags": ["production", "v1"]
	}`

	var deployment WorkerDeployment
	if err := json.Unmarshal([]byte(jsonResp), &deployment); err != nil {
		t.Fatalf("Failed to unmarshal deployment: %v", err)
	}

	if deployment.ID != "test-deployment-id" {
		t.Errorf("ID = %s, want test-deployment-id", deployment.ID)
	}

	if deployment.ScriptName != "my-worker" {
		t.Errorf("ScriptName = %s, want my-worker", deployment.ScriptName)
	}

	if deployment.CompatibilityDate != "2024-01-01" {
		t.Errorf("CompatibilityDate = %s, want 2024-01-01", deployment.CompatibilityDate)
	}

	if len(deployment.Tags) != 2 {
		t.Errorf("Tags length = %d, want 2", len(deployment.Tags))
	}
}

func TestWorkerDeployOptions(t *testing.T) {
	// Test WorkerDeployOptions structure
	options := WorkerDeployOptions{
		CompatibilityDate:  "2024-01-01",
		CompatibilityFlags: []string{"nodejs_compat", "streams_enable_constructors"},
		AssetConfig: &AssetRouterConfig{
			HTMLHandling:     "auto-trailing-slash",
			NotFoundHandling: "single-page-application",
		},
	}

	if options.CompatibilityDate != "2024-01-01" {
		t.Errorf("CompatibilityDate = %s, want 2024-01-01", options.CompatibilityDate)
	}

	if len(options.CompatibilityFlags) != 2 {
		t.Errorf("CompatibilityFlags length = %d, want 2", len(options.CompatibilityFlags))
	}

	if options.AssetConfig == nil {
		t.Fatal("AssetConfig should not be nil")
	}

	if options.AssetConfig.HTMLHandling != "auto-trailing-slash" {
		t.Errorf("AssetConfig.HTMLHandling = %s, want auto-trailing-slash", options.AssetConfig.HTMLHandling)
	}
}

func TestAssetConfigJSONOmitEmpty(t *testing.T) {
	// Test that empty fields are omitted in JSON
	config := AssetConfig{
		JWT: "test-jwt",
		Config: AssetRouterConfig{
			// Only set one field
			HTMLHandling: "auto-trailing-slash",
		},
	}

	jsonData, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("Failed to marshal config: %v", err)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(jsonData, &result); err != nil {
		t.Fatalf("Failed to unmarshal JSON: %v", err)
	}

	// JWT should always be present
	if _, ok := result["jwt"]; !ok {
		t.Error("jwt field should be present")
	}

	// Config should be present
	configMap, ok := result["config"].(map[string]interface{})
	if !ok {
		t.Fatal("config field should be present and be an object")
	}

	// html_handling should be present
	if _, ok := configMap["html_handling"]; !ok {
		t.Error("html_handling should be present")
	}

	// not_found_handling should be omitted (empty)
	if val, ok := configMap["not_found_handling"]; ok && val != "" {
		t.Errorf("not_found_handling should be omitted or empty, got %v", val)
	}
}
