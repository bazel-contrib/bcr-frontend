package gl

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// FetchRepositoryMetadataBatch fetches repository metadata using GitLab GraphQL API
// Fetches up to 100 repositories in a single GraphQL query
func FetchRepositoryMetadataBatch(ctx context.Context, token string, repos []*bzpb.RepositoryMetadata) error {
	if len(repos) == 0 {
		return nil
	}
	if len(repos) > 100 {
		return fmt.Errorf("maximum 100 repositories per batch, got %d", len(repos))
	}

	// Build the GraphQL query dynamically with aliases for all repos
	var queryBuilder bytes.Buffer
	queryBuilder.WriteString("query {\n")

	for i, repo := range repos {
		if repo.Type != bzpb.RepositoryType_GITLAB {
			continue
		}

		// GitLab uses full path format (org/name)
		fullPath := fmt.Sprintf("%s/%s", repo.Organization, repo.Name)

		queryBuilder.WriteString(fmt.Sprintf(`  repo%d: project(fullPath: "%s") {
    description
    starCount
    repository {
      rootRef
    }
    languages {
      name
      share
    }
  }
`, i, fullPath))
	}

	queryBuilder.WriteString("}\n")

	// Execute raw GraphQL query
	response, err := executeRawGraphQL(ctx, token, queryBuilder.String())
	if err != nil {
		return fmt.Errorf("failed to execute GraphQL query: %w", err)
	}

	// Parse response and populate protos
	return parseRepositoryMetadataResponse(response, repos)
}

// executeRawGraphQL executes a raw GraphQL query against GitLab's API
func executeRawGraphQL(ctx context.Context, token, query string) (map[string]any, error) {
	reqBody := map[string]string{
		"query": query,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", "https://gitlab.com/api/graphql", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GraphQL request failed with status %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Data   map[string]any `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	if len(result.Errors) > 0 {
		return nil, fmt.Errorf("GraphQL errors: %v", result.Errors)
	}

	return result.Data, nil
}

// parseRepositoryMetadataResponse parses the GraphQL response and populates repo protos
func parseRepositoryMetadataResponse(data map[string]any, repos []*bzpb.RepositoryMetadata) error {
	for i, repo := range repos {
		if repo.Type != bzpb.RepositoryType_GITLAB {
			continue
		}
		canonicalName := formatRepository(repo)
		repoKey := fmt.Sprintf("repo%d", i)
		repoData, ok := data[repoKey].(map[string]any)
		if !ok {
			log.Printf("WARN %s: graphql response repo not found: %s", canonicalName, repoKey)
			continue // Repo not found or error
		}

		// Initialize Languages map to indicate metadata was fetched (even if empty)
		repo.Languages = make(map[string]int32)

		// Parse description (nil is valid for repos without descriptions)
		if desc, ok := repoData["description"].(string); ok {
			repo.Description = desc
		} else if repoData["description"] != nil {
			log.Printf("WARN %s: graphql response description parse issue: %v", canonicalName, repoData["description"])
		}

		// Parse star count
		if stars, ok := repoData["starCount"].(float64); ok {
			repo.Stargazers = int32(stars)
		} else {
			log.Printf("WARN %s: graphql response starCount parse issue: %v", canonicalName, repoData["starCount"])
		}

		// Parse languages
		if languages, ok := repoData["languages"].([]any); ok {
			totalShare := float64(0)

			// First pass: calculate total share
			for _, lang := range languages {
				langMap, ok := lang.(map[string]any)
				if !ok {
					continue
				}
				if share, ok := langMap["share"].(float64); ok {
					totalShare += share
				}
			}

			// Second pass: normalize shares to approximate byte counts
			// We'll use an arbitrary scale factor to convert percentages to approximate bytes
			const scaleFactor = 10000 // Represents approximate lines of code

			for _, lang := range languages {
				langMap, ok := lang.(map[string]any)
				if !ok {
					continue
				}

				name, nameOk := langMap["name"].(string)
				share, shareOk := langMap["share"].(float64)

				if nameOk && shareOk {
					// Convert percentage share to approximate byte count
					bytes := int32(share * scaleFactor)
					repo.Languages[name] = bytes
				}
			}
		} else if repoData["languages"] != nil {
			log.Printf("WARN %s: graphql response languages parse issue: %v", canonicalName, repoData["languages"])
		}
	}

	return nil
}

// formatRepository prints a canonical form of a repository string
// e.g., "gitlab:org/repo"
func formatRepository(md *bzpb.RepositoryMetadata) string {
	switch md.Type {
	case bzpb.RepositoryType_GITLAB:
		return fmt.Sprintf("gitlab:%s/%s", md.Organization, md.Name)
	default:
		return fmt.Sprintf("%s/%s", md.Organization, md.Name)
	}
}