package bcr

import (
	"context"
	"log"
	"maps"
	"slices"
	"time"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/gh"
)

func (ext *bcrExtension) configureGithubClient() {
	if ext.githubToken != "" {
		ext.githubClient = gh.NewClient(ext.githubToken)
	} else {
		log.Printf("No github-token available.  GitHub API operations will be disabled.")
	}
}

func (ext *bcrExtension) reportGithubRateLimits() {
	if ext.githubClient == nil {
		return
	}

	ctx := context.Background()

	// Check API rate limits
	rateLimits, _, err := ext.githubClient.RateLimit.Get(ctx)
	if err != nil {
		log.Printf("warning: failed to get GitHub API rate limits: %v", err)
		return
	}

	core := rateLimits.GetCore()
	log.Printf("GitHub REST API rate limit: %d remaining of %d (resets at %v)",
		core.Remaining,
		core.Limit,
		core.Reset.Time)

	graphql := rateLimits.GetGraphQL()
	log.Printf("GitHub GraphQL API rate limit: %d remaining of %d (resets at %v)",
		graphql.Remaining,
		graphql.Limit,
		graphql.Reset.Time)
}

func (ext *bcrExtension) fetchGithubRepositoryMetadata(todo []*bzpb.RepositoryMetadata) {
	if len(todo) == 0 {
		log.Printf("No repositories need metadata fetching")
		return
	}

	if ext.githubClient == nil {
		log.Printf("No github client available, skipping retrieval of github metadata...")
		return
	}

	ext.reportGithubRateLimits()

	log.Printf("Need to fetch metadata for %d repositories", len(todo))

	// Process in batches of 100 (GitHub GraphQL max)
	batchSize := 100
	totalFetched := 0

	ctx := context.Background()

	for i := 0; i < len(todo); i += batchSize {
		end := min(i+batchSize, len(todo))

		batch := todo[i:end]
		log.Printf("Fetching metadata for batch %d-%d of %d repositories using GraphQL...", i+1, end, len(todo))

		// Retry with exponential backoff
		maxRetries := 3
		var err error
		for attempt := 0; attempt < maxRetries; attempt++ {
			if attempt > 0 {
				backoff := time.Duration(attempt) * time.Second
				log.Printf("Retrying batch %d-%d after %v (attempt %d/%d)...", i+1, end, backoff, attempt+1, maxRetries)
				time.Sleep(backoff)
			}

			err = gh.FetchRepositoryMetadataBatch(ctx, ext.githubToken, batch)
			if err == nil {
				break
			}

			log.Printf("warning: failed to fetch repository metadata batch (attempt %d/%d): %v", attempt+1, maxRetries, err)
		}

		if err != nil {
			log.Printf("error: failed to fetch repository metadata batch after %d attempts, skipping batch %d-%d", maxRetries, i+1, end)
			continue
		}

		// Log what we fetched
		batchFetched := 0
		for _, md := range batch {
			if md.Description != "" {
				batchFetched++
			}
		}
		totalFetched += batchFetched

		log.Printf("Successfully fetched metadata for %d repositories in this batch", batchFetched)
	}

	log.Printf("Successfully fetched metadata for %d of %d repositories total", totalFetched, len(todo))

	if totalFetched > 0 {
		ext.fetchedRepositoryMetadata = true
	}
}

func filterGithubRepositories(repositories map[repositoryID]*bzpb.RepositoryMetadata) []*bzpb.RepositoryMetadata {
	names := slices.Sorted(maps.Keys(repositories))

	todo := make([]*bzpb.RepositoryMetadata, 0)
	for _, name := range names {
		md := repositories[name]
		if md == nil || md.Type != bzpb.RepositoryType_GITHUB {
			continue
		}

		// Skip known bad repos that don't exist
		if md.Organization == "bazel-contrib" && md.Name == "rules_pex" {
			continue
		}

		// Skip repositories that already have metadata (from cache)
		// Check if Languages map is initialized, which indicates metadata was fetched
		if md.Languages != nil {
			continue
		}

		todo = append(todo, md)
	}
	return todo
}
