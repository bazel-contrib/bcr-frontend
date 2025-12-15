package gh

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/go-github/v66/github"
	"github.com/shurcooL/githubv4"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"golang.org/x/oauth2"
	"golang.org/x/sync/errgroup"
	"golang.org/x/time/rate"
)

// Repo identifies a GitHub repository
type Repo struct {
	Owner string
	Name  string
}

// RepoInfo contains repository metadata
type RepoInfo struct {
	Repo           Repo
	Description    string
	StargazerCount int
	Languages      map[string]int
	Error          error
}

// NewClient creates a new GitHub API client
// If token is empty, creates an unauthenticated client (lower rate limits)
func NewClient(token string) *github.Client {
	if token == "" {
		return github.NewClient(nil)
	}
	return github.NewClient(nil).WithAuthToken(token)
}

// FetchRepoInfo fetches repository description, stargazer count, and languages using the GitHub API
func FetchRepoInfo(ctx context.Context, client *github.Client, repo Repo) (*RepoInfo, error) {
	// Get repository info (includes description and stargazer count)
	repository, _, err := client.Repositories.Get(ctx, repo.Owner, repo.Name)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch repository: %w", err)
	}

	// Get languages
	languages, _, err := client.Repositories.ListLanguages(ctx, repo.Owner, repo.Name)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch languages: %w", err)
	}

	info := &RepoInfo{
		Repo:           repo,
		Description:    repository.GetDescription(),
		StargazerCount: repository.GetStargazersCount(),
		Languages:      languages,
	}

	return info, nil
}

// FetchRepoInfoBatchOptions configures batch fetching behavior
type FetchRepoInfoBatchOptions struct {
	// RequestsPerHour sets the rate limit. Default is 4500 (90% of GitHub's 5000/hour authenticated limit)
	RequestsPerHour float64
	// Burst sets the maximum burst size. Default is 100
	Burst int
}

// DefaultFetchOptions returns default options assuming an authenticated client
func DefaultFetchOptions() *FetchRepoInfoBatchOptions {
	return &FetchRepoInfoBatchOptions{
		RequestsPerHour: 4800, // 96% of GitHub's 5000/hour authenticated limit (留 buffer for safety)
		Burst:           1000, // Allow large initial burst
	}
}

// FetchRepoInfoBatch fetches repository info for multiple repos with rate limiting
// Uses default options assuming authenticated client (4800 requests/hour, burst 1000)
func FetchRepoInfoBatch(ctx context.Context, client *github.Client, repos []Repo) ([]*RepoInfo, error) {
	return FetchRepoInfoBatchWithOptions(ctx, client, repos, DefaultFetchOptions())
}

// FetchRepoInfoBatchWithOptions fetches repository info for multiple repos with custom rate limiting
func FetchRepoInfoBatchWithOptions(ctx context.Context, client *github.Client, repos []Repo, opts *FetchRepoInfoBatchOptions) ([]*RepoInfo, error) {
	if opts == nil {
		opts = DefaultFetchOptions()
	}

	results := make([]*RepoInfo, len(repos))
	var mu sync.Mutex

	limiter := rate.NewLimiter(rate.Limit(opts.RequestsPerHour/3600.0), opts.Burst)

	g, ctx := errgroup.WithContext(ctx)

	for i, repo := range repos {
		i, repo := i, repo // capture loop variables
		g.Go(func() error {
			if err := limiter.Wait(ctx); err != nil {
				return err
			}

			info, err := FetchRepoInfo(ctx, client, repo)
			if err != nil {
				// Store error in result instead of failing entire batch
				info = &RepoInfo{
					Repo:  repo,
					Error: err,
				}
			}

			mu.Lock()
			results[i] = info
			mu.Unlock()

			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}

	return results, nil
}

// CommitInfo contains commit metadata
type CommitInfo struct {
	SHA        string
	CommitDate time.Time
	Author     string
	Message    string
}

// FetchCommitInfo fetches commit details from GitHub
func FetchCommitInfo(ctx context.Context, client *github.Client, repo Repo, commitSHA string) (*CommitInfo, error) {
	commit, _, err := client.Repositories.GetCommit(ctx, repo.Owner, repo.Name, commitSHA, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch commit %s: %w", commitSHA, err)
	}

	info := &CommitInfo{
		SHA:        commit.GetSHA(),
		CommitDate: commit.GetCommit().GetCommitter().GetDate().Time,
		Author:     commit.GetCommit().GetAuthor().GetName(),
		Message:    commit.GetCommit().GetMessage(),
	}

	return info, nil
}

// NewGraphQLClient creates a new GitHub GraphQL API client
func NewGraphQLClient(token string) *githubv4.Client {
	if token == "" {
		return githubv4.NewClient(nil)
	}

	src := oauth2.StaticTokenSource(
		&oauth2.Token{AccessToken: token},
	)
	httpClient := oauth2.NewClient(context.Background(), src)
	return githubv4.NewClient(httpClient)
}

// FetchRepositoryMetadataBatch fetches repository metadata using GraphQL and populates the proto messages
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
		if repo.Type != bzpb.RepositoryType_GITHUB {
			continue
		}

		queryBuilder.WriteString(fmt.Sprintf(`  repo%d: repository(owner: "%s", name: "%s") {
    description
    stargazerCount
    languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
      edges {
        size
        node {
          name
        }
      }
    }
  }
`, i, repo.Organization, repo.Name))
	}

	queryBuilder.WriteString("}\n")

	// Execute raw GraphQL query
	response, err := ExecuteRawGraphQL(ctx, token, queryBuilder.String())
	if err != nil {
		return fmt.Errorf("failed to execute GraphQL query: %w", err)
	}

	// Parse response and populate protos
	return parseRepositoryMetadataResponse(response, repos)
}

// populateRepoMetadata populates a RepositoryMetadata proto from GraphQL response
func populateRepoMetadata(repo *bzpb.RepositoryMetadata, fields interface{}) {
	type LanguageEdge struct {
		Size githubv4.Int
		Node struct {
			Name githubv4.String
		}
	}

	type RepositoryFields struct {
		Description    githubv4.String
		StargazerCount githubv4.Int
		Languages      struct {
			Edges []LanguageEdge
		}
	}

	rf, ok := fields.(RepositoryFields)
	if !ok {
		return
	}

	repo.Description = string(rf.Description)
	repo.Stargazers = int32(rf.StargazerCount)

	// Convert languages
	if len(rf.Languages.Edges) > 0 {
		repo.Languages = make(map[string]int32)
		for _, edge := range rf.Languages.Edges {
			repo.Languages[string(edge.Node.Name)] = int32(edge.Size)
		}
	}
}

// ExecuteRawGraphQL executes a raw GraphQL query against GitHub's API
func ExecuteRawGraphQL(ctx context.Context, token, query string) (map[string]any, error) {
	reqBody := map[string]string{
		"query": query,
	}

	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", "https://api.github.com/graphql", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
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
		if repo.Type != bzpb.RepositoryType_GITHUB {
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

		// Parse stargazer count
		if stars, ok := repoData["stargazerCount"].(float64); ok {
			repo.Stargazers = int32(stars)
		} else {
			log.Printf("WARN %s: graphql response stargazerCount parse issue: %v", canonicalName, repoData["stargazerCount"])
		}

		// Parse languages
		if languages, ok := repoData["languages"].(map[string]any); ok {
			if edges, ok := languages["edges"].([]any); ok {
				for _, edge := range edges {
					edgeMap, ok := edge.(map[string]any)
					if !ok {
						continue
					}

					size, sizeOk := edgeMap["size"].(float64)
					if !sizeOk {
						log.Printf("WARN %s: graphql response edge size parse issue: %v/%v", canonicalName, edgeMap["size"])
						continue
					}
					node, nodeOk := edgeMap["node"].(map[string]any)
					if !nodeOk {
						log.Printf("WARN %s: graphql response node parse issue: %v/%v", canonicalName, edgeMap["node"])
						continue
					}
					name, nameOk := node["name"].(string)
					if !nameOk {
						log.Printf("WARN %s: graphql response node name parse issue: %v", canonicalName, node["name"])
						continue
					}

					repo.Languages[name] = int32(size)
				}
			} else {
				log.Printf("WARN %s: graphql response edges parse issue: %v", canonicalName, repoData["edges"])
			}
		} else {
			log.Printf("WARN %s: graphql response languages parse issue: %v", canonicalName, repoData["languages"])
		}
	}

	return nil
}

// formatRepository prints a canonical form of a repository string
// e.g., "github:org/repo"
func formatRepository(md *bzpb.RepositoryMetadata) string {
	switch md.Type {
	case bzpb.RepositoryType_GITHUB:
		return fmt.Sprintf("github:%s/%s", md.Organization, md.Name)
	default:
		return fmt.Sprintf("%s/%s", md.Organization, md.Name)
	}
}

// GetTagCommitSHA resolves a git tag to its commit SHA using the GitHub API
func GetTagCommitSHA(ctx context.Context, client *github.Client, repo Repo, tag string) (string, error) {
	ref, _, err := client.Git.GetRef(ctx, repo.Owner, repo.Name, "tags/"+tag)
	if err != nil {
		return "", fmt.Errorf("failed to get tag %s: %w", tag, err)
	}

	// The ref might point to a tag object or directly to a commit
	if ref.Object.GetType() == "tag" {
		// It's an annotated tag, need to dereference it
		tag, _, err := client.Git.GetTag(ctx, repo.Owner, repo.Name, ref.Object.GetSHA())
		if err != nil {
			return "", fmt.Errorf("failed to dereference tag: %w", err)
		}
		return tag.Object.GetSHA(), nil
	}

	// It's a lightweight tag pointing directly to a commit
	return ref.Object.GetSHA(), nil
}

// GetReleaseCommitSHA resolves a GitHub release to its target commit SHA
func GetReleaseCommitSHA(ctx context.Context, client *github.Client, repo Repo, version string) (string, error) {
	release, _, err := client.Repositories.GetReleaseByTag(ctx, repo.Owner, repo.Name, version)
	if err != nil {
		return "", fmt.Errorf("failed to get release %s: %w", version, err)
	}

	targetCommitish := release.GetTargetCommitish()
	if targetCommitish == "" {
		return "", fmt.Errorf("release %s has no target commitish", version)
	}

	// The target commitish might be a branch name (e.g., "main") or a tag name
	// We need to resolve it to an actual commit SHA

	// Try to get it as a branch first
	branch, _, err := client.Repositories.GetBranch(ctx, repo.Owner, repo.Name, targetCommitish, 0)
	if err == nil && branch != nil && branch.Commit != nil {
		return branch.Commit.GetSHA(), nil
	}

	// If not a branch, try as a tag reference
	ref, _, err := client.Git.GetRef(ctx, repo.Owner, repo.Name, "tags/"+targetCommitish)
	if err == nil && ref != nil && ref.Object != nil {
		// If it's an annotated tag, dereference it
		if ref.Object.GetType() == "tag" {
			tag, _, err := client.Git.GetTag(ctx, repo.Owner, repo.Name, ref.Object.GetSHA())
			if err == nil && tag != nil && tag.Object != nil {
				return tag.Object.GetSHA(), nil
			}
		}
		// Lightweight tag or direct commit reference
		return ref.Object.GetSHA(), nil
	}

	// If neither branch nor tag, it might already be a commit SHA
	if len(targetCommitish) == 40 {
		// Verify it's a valid commit
		commit, _, err := client.Repositories.GetCommit(ctx, repo.Owner, repo.Name, targetCommitish, nil)
		if err == nil && commit != nil {
			return commit.GetSHA(), nil
		}
	}

	return "", fmt.Errorf("could not resolve target commitish %q to a commit SHA", targetCommitish)
}

// SourceCommitInfo contains the result of resolving a source URL to a commit SHA
type SourceCommitInfo struct {
	URL       string
	CommitSHA string
	Error     error
}

// BatchResolveSourceCommits resolves multiple source URLs to commit SHAs with retry logic
// Returns a slice of SourceCommitInfo with results for each URL
// The optional onProgress callback is called after each URL is processed
func BatchResolveSourceCommits(ctx context.Context, client *github.Client, urlInfos []struct {
	URL  string
	Org  string
	Repo string
	Type string // "tag", "commit_sha", or "release"
	Ref  string
}, onProgress func(*SourceCommitInfo)) ([]*SourceCommitInfo, error) {
	results := make([]*SourceCommitInfo, len(urlInfos))
	var mu sync.Mutex

	limiter := rate.NewLimiter(rate.Limit(4800.0/3600.0), 1000)
	g, ctx := errgroup.WithContext(ctx)

	for i, info := range urlInfos {
		i, info := i, info // capture loop variables
		g.Go(func() error {
			if err := limiter.Wait(ctx); err != nil {
				return err
			}

			result := &SourceCommitInfo{URL: info.URL}

			switch info.Type {
			case "commit_sha":
				// URL already contains the commit SHA
				result.CommitSHA = info.Ref

			case "tag":
				sha, err := retryWithBackoff(ctx, 3, func() (string, error) {
					return GetTagCommitSHA(ctx, client, Repo{Owner: info.Org, Name: info.Repo}, info.Ref)
				})
				if err != nil {
					result.Error = err
				} else {
					result.CommitSHA = sha
				}

			case "release":
				sha, err := retryWithBackoff(ctx, 3, func() (string, error) {
					return GetReleaseCommitSHA(ctx, client, Repo{Owner: info.Org, Name: info.Repo}, info.Ref)
				})
				if err != nil {
					result.Error = err
				} else {
					result.CommitSHA = sha
				}

			default:
				result.Error = fmt.Errorf("unknown URL type: %s", info.Type)
			}

			mu.Lock()
			results[i] = result
			mu.Unlock()

			// Call progress callback if provided
			if onProgress != nil {
				onProgress(result)
			}

			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}

	return results, nil
}

// retryWithBackoff retries a function with exponential backoff
func retryWithBackoff(ctx context.Context, maxRetries int, fn func() (string, error)) (string, error) {
	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		result, err := fn()
		if err == nil {
			return result, nil
		}

		lastErr = err

		// Don't retry on context cancellation or certain GitHub errors
		if ctx.Err() != nil {
			return "", ctx.Err()
		}

		// Don't retry on 404 (not found) errors - these won't succeed on retry
		if isNotFoundError(err) {
			return "", err
		}

		// Don't retry on last attempt
		if attempt < maxRetries-1 {
			// Exponential backoff: 1s, 2s, 4s
			backoff := time.Duration(1<<uint(attempt)) * time.Second
			time.Sleep(backoff)
		}
	}

	return "", fmt.Errorf("failed after %d attempts: %w", maxRetries, lastErr)
}

// isNotFoundError checks if an error is a GitHub 404 not found error
func isNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	// Check for go-github error response
	if errResp, ok := err.(*github.ErrorResponse); ok {
		return errResp.Response.StatusCode == 404
	}
	return false
}
