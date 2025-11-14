package gh

import (
	"context"
	"fmt"
	"sync"

	"github.com/google/go-github/v66/github"
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
		Burst:           1000,  // Allow large initial burst
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
