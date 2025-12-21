package bcr

import (
	"context"
	"log"
	"maps"
	"slices"
	"sync"
	"time"

	"github.com/schollz/progressbar/v3"
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
			log.Printf("error: failed to fetch repository metadata batch after %d attempts, trying backup registry for batch %d-%d", maxRetries, i+1, end)

			// Try to populate from backup registry
			batchFetched := ext.populateFromBackupRegistry(batch)
			totalFetched += batchFetched

			if batchFetched > 0 {
				log.Printf("Successfully populated %d repositories from backup registry", batchFetched)
			}
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

// resolveSourceCommitSHAsForRankedModules resolves commit SHAs only for modules
// that have rank > 0 in the rankedModuleVersionMap (i.e., modules we're generating docs for)
func (ext *bcrExtension) resolveSourceCommitSHAsForRankedModules(rankedModules rankedModuleVersionMap) {
	if ext.githubClient == nil {
		log.Printf("No GitHub client available, skipping source commit SHA resolution")
		return
	}

	ctx := context.Background()

	// Collect source URLs from ranked modules only (rank > 0)
	type urlInfo struct {
		URL  string
		Org  string
		Repo string
		Type string
		Ref  string
	}

	urlToModuleID := make(map[string][]moduleID)
	var urlInfos []urlInfo
	totalRankedModules := 0
	processedModules := 0

	// Track how many commit SHAs we got from backup registry
	backupCommitSHAs := 0

	// Iterate through ranked modules
	for moduleName, versions := range rankedModules {
		for _, rv := range versions {
			totalRankedModules++

			// Only process modules with rank > 0 (those selected by MVS for doc generation)
			if rv.rank <= 0 || rv.source == nil {
				continue
			}

			processedModules++

			// Get the module version proto
			moduleVersion := rv.source.Proto()
			if moduleVersion == nil || moduleVersion.Source == nil {
				continue
			}

			// Skip if already has a commit SHA
			if moduleVersion.Source.CommitSha != "" {
				continue
			}

			// Try to get commit SHA from backup registry first
			id := toModuleID(moduleName, rv.version)
			if backupSource := ext.getBackupModuleSource(string(moduleName), string(rv.version)); backupSource != nil && backupSource.CommitSha != "" {
				if source, ok := ext.moduleSourceRules[id]; ok {
					updateModuleSourceRuleSourceCommitSha(source, backupSource.CommitSha)
					backupCommitSHAs++
					continue
				}
			}

			// Parse the GitHub URL
			parsed, err := gh.ParseGitHubSourceURL(moduleVersion.Source.Url)
			if err != nil {
				// Not a GitHub URL or doesn't match our patterns - skip silently
				continue
			}

			// Track which module ID uses this URL
			urlToModuleID[moduleVersion.Source.Url] = append(urlToModuleID[moduleVersion.Source.Url], id)

			// Add to our batch (deduplicate by URL - only add first occurrence)
			if len(urlToModuleID[moduleVersion.Source.Url]) == 1 {
				urlInfos = append(urlInfos, urlInfo{
					URL:  moduleVersion.Source.Url,
					Org:  parsed.Organization,
					Repo: parsed.Repository,
					Type: parsed.Type.String(),
					Ref:  parsed.Reference,
				})
			}
		}
	}

	log.Printf("Processing %d ranked modules (out of %d total modules)", processedModules, totalRankedModules)

	if backupCommitSHAs > 0 {
		log.Printf("Retrieved %d commit SHAs from backup registry", backupCommitSHAs)
	}

	if len(urlInfos) == 0 {
		log.Printf("No GitHub source URLs need commit SHA resolution for ranked modules")
		return
	}

	totalURLs := len(urlInfos)
	log.Printf("Resolving commit SHAs for %d unique GitHub source URLs from ranked modules...", totalURLs)

	// Create progress bar
	bar := progressbar.NewOptions(totalURLs,
		progressbar.OptionSetDescription("Resolving commit SHAs (ranked)"),
		progressbar.OptionShowCount(),
		progressbar.OptionSetWidth(40),
		progressbar.OptionSetTheme(progressbar.Theme{
			Saucer:        "=",
			SaucerHead:    ">",
			SaucerPadding: " ",
			BarStart:      "[",
			BarEnd:        "]",
		}),
	)

	// Convert to the format expected by BatchResolveSourceCommits
	batchInfos := make([]struct {
		URL  string
		Org  string
		Repo string
		Type string
		Ref  string
	}, len(urlInfos))
	for i, info := range urlInfos {
		batchInfos[i] = info
	}

	// Track progress
	successCount := 0
	errorCount := 0
	var mu sync.Mutex

	// Resolve all commit SHAs in batch with progress callback
	results, err := gh.BatchResolveSourceCommits(ctx, ext.githubClient, batchInfos, func(result *gh.SourceCommitInfo) {
		mu.Lock()
		defer mu.Unlock()

		bar.Add(1)

		if result.Error != nil {
			errorCount++
		} else if result.CommitSHA != "" {
			// Update all module IDs that use this URL
			moduleIDs := urlToModuleID[result.URL]
			for _, id := range moduleIDs {
				if source, ok := ext.moduleSourceRules[id]; ok {
					updateModuleSourceRuleSourceCommitSha(source, result.CommitSHA)
					successCount++
				}
			}
		}
	})
	if err != nil {
		log.Printf("error: failed to resolve source commit SHAs: %v", err)
		return
	}

	// Log any errors or warnings after completion
	for _, result := range results {
		if result.Error != nil {
			log.Printf("warning: failed to resolve commit SHA for %s: %v", result.URL, result.Error)
		} else if result.CommitSHA == "" {
			log.Printf("warning: empty commit SHA for %s", result.URL)
		}
	}

	totalResolved := backupCommitSHAs + successCount
	log.Printf("Commit SHA resolution complete for ranked modules: %d from backup registry, %d from GitHub API (%d errors), %d total resolved", backupCommitSHAs, successCount, errorCount, totalResolved)
}

// resolveSourceCommitSHAsForLatestVersions resolves commit SHAs for ALL latest
// versions, regardless of whether they have documentation or rank.
func (ext *bcrExtension) resolveSourceCommitSHAsForLatestVersions() {
	if ext.githubClient == nil {
		log.Printf("No GitHub client available, skipping source commit SHA resolution")
		return
	}

	ctx := context.Background()

	// Collect source URLs from all latest versions
	type urlInfo struct {
		URL  string
		Org  string
		Repo string
		Type string
		Ref  string
	}

	urlToModuleID := make(map[string][]moduleID)
	var urlInfos []urlInfo
	totalLatestVersions := 0
	processedVersions := 0

	// Track how many commit SHAs we got from backup registry
	backupCommitSHAs := 0

	// Iterate through all module versions
	for id, versionRule := range ext.moduleVersionRules {
		// Check if this is marked as the latest version
		isLatest := versionRule.Rule().PrivateAttr(isLatestVersionPrivateAttr)
		if isLatest == nil || !isLatest.(bool) {
			continue
		}

		totalLatestVersions++

		// Get the module source for this version
		sourceRule, exists := ext.moduleSourceRules[id]
		if !exists {
			continue
		}

		moduleSource := sourceRule.Proto()
		if moduleSource == nil {
			continue
		}

		processedVersions++

		// Skip if already has a commit SHA
		if moduleSource.CommitSha != "" {
			continue
		}

		// Try to get commit SHA from backup registry first
		if backupSource := ext.getBackupModuleSource(string(id.name()), string(id.version())); backupSource != nil && backupSource.CommitSha != "" {
			updateModuleSourceRuleSourceCommitSha(sourceRule, backupSource.CommitSha)
			backupCommitSHAs++
			continue
		}

		// Parse the GitHub URL
		parsed, err := gh.ParseGitHubSourceURL(moduleSource.Url)
		if err != nil {
			// Not a GitHub URL or doesn't match our patterns - skip silently
			continue
		}

		// Track which module ID uses this URL
		urlToModuleID[moduleSource.Url] = append(urlToModuleID[moduleSource.Url], id)

		// Add to our batch (deduplicate by URL - only add first occurrence)
		if len(urlToModuleID[moduleSource.Url]) == 1 {
			urlInfos = append(urlInfos, urlInfo{
				URL:  moduleSource.Url,
				Org:  parsed.Organization,
				Repo: parsed.Repository,
				Type: parsed.Type.String(),
				Ref:  parsed.Reference,
			})
		}
	}

	log.Printf("Processing %d latest versions with sources (out of %d total latest versions)", processedVersions, totalLatestVersions)

	if backupCommitSHAs > 0 {
		log.Printf("Retrieved %d commit SHAs from backup registry", backupCommitSHAs)
	}

	if len(urlInfos) == 0 {
		log.Printf("No GitHub source URLs need commit SHA resolution for latest versions")
		return
	}

	totalURLs := len(urlInfos)
	log.Printf("Resolving commit SHAs for %d unique GitHub source URLs from latest versions...", totalURLs)

	// Create progress bar
	bar := progressbar.NewOptions(totalURLs,
		progressbar.OptionSetDescription("Resolving commit SHAs"),
		progressbar.OptionShowCount(),
		progressbar.OptionSetWidth(40),
		progressbar.OptionSetTheme(progressbar.Theme{
			Saucer:        "=",
			SaucerHead:    ">",
			SaucerPadding: " ",
			BarStart:      "[",
			BarEnd:        "]",
		}),
	)

	// Convert to the format expected by BatchResolveSourceCommits
	batchInfos := make([]struct {
		URL  string
		Org  string
		Repo string
		Type string
		Ref  string
	}, len(urlInfos))
	for i, info := range urlInfos {
		batchInfos[i] = info
	}

	// Track progress
	successCount := 0
	errorCount := 0
	var mu sync.Mutex

	// Resolve all commit SHAs in batch with progress callback
	results, err := gh.BatchResolveSourceCommits(ctx, ext.githubClient, batchInfos, func(result *gh.SourceCommitInfo) {
		mu.Lock()
		defer mu.Unlock()

		bar.Add(1)

		if result.Error != nil {
			errorCount++
		} else if result.CommitSHA != "" {
			// Update all module IDs that use this URL
			moduleIDs := urlToModuleID[result.URL]
			for _, id := range moduleIDs {
				if source, ok := ext.moduleSourceRules[id]; ok {
					updateModuleSourceRuleSourceCommitSha(source, result.CommitSHA)
					successCount++
				}
			}
		}
	})
	if err != nil {
		log.Printf("error: failed to resolve source commit SHAs: %v", err)
		return
	}

	// Log any errors or warnings after completion
	for _, result := range results {
		if result.Error != nil {
			log.Printf("warning: failed to resolve commit SHA for %s: %v", result.URL, result.Error)
		} else if result.CommitSHA == "" {
			log.Printf("warning: empty commit SHA for %s", result.URL)
		}
	}

	totalResolved := backupCommitSHAs + successCount
	log.Printf("Commit SHA resolution complete for latest versions: %d from backup registry, %d from GitHub API (%d errors), %d total resolved", backupCommitSHAs, successCount, errorCount, totalResolved)
}
