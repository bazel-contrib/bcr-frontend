package bcr

import (
	"context"
	"fmt"
	"log"
	"os"
	"path"
	"path/filepath"
	"time"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/gh"
	"github.com/stackb/centrl/pkg/protoutil"
)

const (
	bazelOrg       = "bazelbuild"
	bazelRepo      = "bazel"
	bazelToolsName = "bazel_tools"
)

// fetchBazelRepositoryMetadata fetches Bazel release data from GitHub and creates
// pseudo BCR modules under modules/bazel/{VERSION}
func (ext *bcrExtension) fetchBazelRepositoryMetadata(todo []*bzpb.RepositoryMetadata) {

	// Create repository metadata for bazel module
	bazelRepoID := repositoryID(fmt.Sprintf("github:%s/%s", bazelOrg, bazelRepo))
	if _, exists := ext.repositoriesMetadataByID[bazelRepoID]; !exists {
		ext.repositoriesMetadataByID[bazelRepoID] = &bzpb.RepositoryMetadata{
			Type:          bzpb.RepositoryType_GITHUB,
			Organization:  bazelOrg,
			Name:          bazelRepo,
			CanonicalName: fmt.Sprintf("github:%s/%s", bazelOrg, bazelRepo),
		}
		log.Printf("Created repository metadata for %s", bazelRepoID)
	}

	// Check if we already have cached releases
	if false && len(ext.bazelReleasesByVersion) > 0 {
		log.Printf("Using %d cached Bazel releases", len(ext.bazelReleasesByVersion))
		releases := make([]*bzpb.BazelRelease, 0, len(ext.bazelReleasesByVersion))
		for _, release := range ext.bazelReleasesByVersion {
			releases = append(releases, release)
		}
		ext.createBazelModulesFromReleases(releases)
		return
	}

	if ext.githubToken == "" {
		log.Printf("No GitHub token available, skipping Bazel repository metadata...")
		return
	}

	log.Printf("Fetching Bazel release metadata from GitHub...")

	ctx := context.Background()

	// Fetch all releases from GitHub using GraphQL
	releases, err := ext.fetchBazelReleasesGraphQL(ctx)
	if err != nil {
		log.Printf("error: failed to fetch Bazel releases: %v", err)
		return
	}

	log.Printf("Found %d Bazel releases", len(releases))
	ext.fetchedBazelReleases = true

	// Store in cache
	for _, release := range releases {
		ext.bazelReleasesByVersion[release.Version] = release
	}

	// Fetch top contributors using GraphQL
	maintainers, err := ext.fetchBazelContributorsGraphQL(ctx)
	if err != nil {
		log.Printf("warning: failed to fetch Bazel contributors: %v", err)
		// Continue anyway with empty maintainers list
		maintainers = []string{}
	}

	// Write metadata.json at module level (once for all versions)
	bazelModuleDir := filepath.Join(ext.repoRoot, ext.modulesRoot, bazelToolsName)
	log.Printf("Writing Bazel metadata.json to %s", filepath.Join(bazelModuleDir, "metadata.json"))
	if err := ext.writeBazelMetadataFile(bazelModuleDir, releases, maintainers); err != nil {
		log.Printf("error: failed to write bazel metadata.json: %v", err)
		// Continue with version creation anyway
	} else {
		log.Printf("Successfully wrote Bazel metadata.json with %d versions and %d maintainers", len(releases), len(maintainers))
	}

	ext.createBazelModulesFromReleases(releases)
}

// createBazelModulesFromReleases creates pseudo BCR modules for each release
func (ext *bcrExtension) createBazelModulesFromReleases(releases []*bzpb.BazelRelease) {
	successCount := 0
	for _, release := range releases {
		if err := ext.createBazelModuleVersion(release); err != nil {
			log.Printf("error: failed to create Bazel module for version %s: %v", release.Version, err)
			continue
		}

		// Populate moduleCommits map
		ext.populateBazelModuleCommit(release)

		successCount++
	}

	log.Printf("Successfully created %d Bazel pseudo-modules (out of %d releases)", successCount, len(releases))
}

// fetchBazelReleasesGraphQL fetches all Bazel releases from GitHub using GraphQL with pagination
func (ext *bcrExtension) fetchBazelReleasesGraphQL(ctx context.Context) ([]*bzpb.BazelRelease, error) {
	var allReleases []*bzpb.BazelRelease
	var afterCursor string
	hasNextPage := true

	for hasNextPage {
		// Build GraphQL query with pagination
		afterClause := ""
		if afterCursor != "" {
			afterClause = fmt.Sprintf(`, after: "%s"`, afterCursor)
		}

		query := fmt.Sprintf(`query {
  repository(owner: "%s", name: "%s") {
    releases(first: 100%s, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        tagName
        createdAt
        isDraft
        isPrerelease
        tagCommit {
          oid
          committedDate
          message
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`, bazelOrg, bazelRepo, afterClause)

		response, err := gh.ExecuteRawGraphQL(ctx, ext.githubToken, query)
		if err != nil {
			return nil, fmt.Errorf("failed to execute GraphQL query: %w", err)
		}

		releases, pageInfo, err := parseBazelReleasesResponse(response)
		if err != nil {
			return nil, err
		}

		allReleases = append(allReleases, releases...)

		// Check if there are more pages
		hasNextPage = pageInfo.HasNextPage
		afterCursor = pageInfo.EndCursor

		if hasNextPage {
			log.Printf("Fetched %d releases so far, fetching next page...", len(allReleases))
		}
	}

	return allReleases, nil
}

// pageInfo contains pagination information from GraphQL response
type pageInfo struct {
	HasNextPage bool
	EndCursor   string
}

// parseBazelReleasesResponse parses GraphQL response for Bazel releases and pagination info
func parseBazelReleasesResponse(data map[string]any) ([]*bzpb.BazelRelease, *pageInfo, error) {
	var releases []*bzpb.BazelRelease

	repo, ok := data["repository"].(map[string]any)
	if !ok {
		return nil, nil, fmt.Errorf("repository not found in response")
	}

	releasesData, ok := repo["releases"].(map[string]any)
	if !ok {
		return nil, nil, fmt.Errorf("releases not found in response")
	}

	nodes, ok := releasesData["nodes"].([]any)
	if !ok {
		return nil, nil, fmt.Errorf("nodes not found in releases")
	}

	for _, node := range nodes {
		nodeMap, ok := node.(map[string]any)
		if !ok {
			continue
		}

		// Skip drafts
		if isDraft, ok := nodeMap["isDraft"].(bool); ok && isDraft {
			continue
		}

		tagName, ok := nodeMap["tagName"].(string)
		if !ok || tagName == "" {
			continue
		}

		// Get commit information
		var commitSHA string
		var commitDate time.Time
		var commitMessage string
		if tagCommit, ok := nodeMap["tagCommit"].(map[string]any); ok {
			if oid, ok := tagCommit["oid"].(string); ok {
				commitSHA = oid
			}
			if dateStr, ok := tagCommit["committedDate"].(string); ok {
				if t, err := time.Parse(time.RFC3339, dateStr); err == nil {
					commitDate = t
				}
			}
			if msg, ok := tagCommit["message"].(string); ok {
				commitMessage = msg
			}
		}

		// Construct tarball URL
		tarballURL := fmt.Sprintf("https://github.com/%s/%s/archive/refs/tags/%s.tar.gz",
			bazelOrg, bazelRepo, tagName)

		releases = append(releases, &bzpb.BazelRelease{
			Version: tagName,
			Url:     tarballURL,
			Commit: &bzpb.ModuleCommit{
				Sha1:    commitSHA,
				Date:    commitDate.Format(time.RFC3339),
				Message: commitMessage,
			},
		})
	}

	// Parse pagination info
	pInfo := &pageInfo{}
	if pageInfoData, ok := releasesData["pageInfo"].(map[string]any); ok {
		if hasNext, ok := pageInfoData["hasNextPage"].(bool); ok {
			pInfo.HasNextPage = hasNext
		}
		if cursor, ok := pageInfoData["endCursor"].(string); ok {
			pInfo.EndCursor = cursor
		}
	}

	return releases, pInfo, nil
}

// fetchBazelContributorsGraphQL fetches top contributors using GraphQL
func (ext *bcrExtension) fetchBazelContributorsGraphQL(ctx context.Context) ([]string, error) {
	// Build GraphQL query to fetch contributors
	// Note: GitHub's GraphQL API doesn't have a direct "contributors" query like REST
	// We'll fetch recent commit authors instead
	query := fmt.Sprintf(`query {
  repository(owner: "%s", name: "%s") {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100) {
            nodes {
              author {
                user {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
}`, bazelOrg, bazelRepo)

	response, err := gh.ExecuteRawGraphQL(ctx, ext.githubToken, query)
	if err != nil {
		return nil, fmt.Errorf("failed to execute GraphQL query: %w", err)
	}

	return parseBazelContributorsResponse(response)
}

// parseBazelContributorsResponse parses GraphQL response for contributors
func parseBazelContributorsResponse(data map[string]any) ([]string, error) {
	var maintainers []string
	seen := make(map[string]bool)

	repo, ok := data["repository"].(map[string]any)
	if !ok {
		return maintainers, nil
	}

	defaultBranch, ok := repo["defaultBranchRef"].(map[string]any)
	if !ok {
		return maintainers, nil
	}

	target, ok := defaultBranch["target"].(map[string]any)
	if !ok {
		return maintainers, nil
	}

	history, ok := target["history"].(map[string]any)
	if !ok {
		return maintainers, nil
	}

	nodes, ok := history["nodes"].([]any)
	if !ok {
		return maintainers, nil
	}

	for _, node := range nodes {
		nodeMap, ok := node.(map[string]any)
		if !ok {
			continue
		}

		author, ok := nodeMap["author"].(map[string]any)
		if !ok {
			continue
		}

		user, ok := author["user"].(map[string]any)
		if !ok {
			continue
		}

		login, ok := user["login"].(string)
		if !ok || login == "" {
			continue
		}

		// Deduplicate
		if !seen[login] {
			seen[login] = true
			maintainers = append(maintainers, login)
		}

		// Limit to top 30
		if len(maintainers) >= 30 {
			break
		}
	}

	return maintainers, nil
}

// createBazelModuleVersion creates a pseudo BCR module version for a Bazel release
func (ext *bcrExtension) createBazelModuleVersion(release *bzpb.BazelRelease) error {
	// Create directory: {repoRoot}/{modulesRoot}/bazel/{VERSION}
	moduleDir := filepath.Join(ext.repoRoot, ext.modulesRoot, bazelToolsName, release.Version)

	// log.Printf("Creating Bazel module version %s at %s", release.Version, moduleDir)

	if err := os.MkdirAll(moduleDir, 0755); err != nil {
		return fmt.Errorf("failed to create directory %s: %w", moduleDir, err)
	}

	// Write MODULE.bazel
	if err := ext.writeBazelModuleFile(moduleDir, release.Version); err != nil {
		return fmt.Errorf("failed to write MODULE.bazel: %w", err)
	}
	// log.Printf("  Wrote %s", filepath.Join(moduleDir, "MODULE.bazel"))

	// Write source.json
	if err := ext.writeBazelSourceFile(moduleDir, release); err != nil {
		return fmt.Errorf("failed to write source.json: %w", err)
	}
	// log.Printf("  Wrote %s", filepath.Join(moduleDir, "source.json"))

	return nil
}

// writeBazelModuleFile writes a fake MODULE.bazel file
func (ext *bcrExtension) writeBazelModuleFile(moduleDir, version string) error {
	modulePath := filepath.Join(moduleDir, "MODULE.bazel")

	content := fmt.Sprintf(`module(
    name = "%s",
    version = "%s",
)
`, bazelToolsName, version)

	if err := os.WriteFile(modulePath, []byte(content), 0644); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}

	return nil
}

// writeBazelSourceFile writes the source.json file using protobuf
func (ext *bcrExtension) writeBazelSourceFile(moduleDir string, release *bzpb.BazelRelease) error {
	sourcePath := filepath.Join(moduleDir, "source.json")

	// The strip_prefix should be {repo}-{version} (GitHub archive format)
	stripPrefix := fmt.Sprintf("%s-%s", bazelRepo, release.Version)

	source := &bzpb.ModuleSource{
		Url:         release.Url,
		StripPrefix: stripPrefix,
		// Note: We're not computing integrity hash here - that would require downloading the file
		// The BCR typically uses SHA256 integrity hashes in base64
		// For now, we'll omit it
	}

	// If we have a commit SHA, add it
	if release.Commit != nil && release.Commit.Sha1 != "" {
		source.CommitSha = release.Commit.Sha1
	}

	if err := protoutil.WriteFile(sourcePath, source); err != nil {
		return fmt.Errorf("failed to write source.json: %w", err)
	}

	return nil
}

// populateBazelModuleCommit populates the moduleCommits map with commit data for a Bazel release
func (ext *bcrExtension) populateBazelModuleCommit(release *bzpb.BazelRelease) {
	if release.Commit == nil {
		return
	}

	// Create the module rel path - format: modules/bazel/{VERSION}/MODULE.bazel
	key := moduleBazelRelPath(path.Join("modules", bazelToolsName, release.Version, "MODULE.bazel"))

	// Store in the moduleCommits map
	ext.moduleCommits[key] = release.Commit

	log.Printf("Populated commit data for bazel/%s: %s", release.Version, release.Commit.Sha1)
}

// writeBazelMetadataFile writes the metadata.json file at module level with all versions and maintainer information
func (ext *bcrExtension) writeBazelMetadataFile(moduleDir string, releases []*bzpb.BazelRelease, maintainers []string) error {
	// Ensure the module directory exists
	if err := os.MkdirAll(moduleDir, 0755); err != nil {
		return fmt.Errorf("failed to create module directory %s: %w", moduleDir, err)
	}

	metadataPath := filepath.Join(moduleDir, "metadata.json")

	// Convert maintainer logins to Maintainer protobufs
	maintainersList := make([]*bzpb.Maintainer, 0, len(maintainers))
	for _, login := range maintainers {
		maintainersList = append(maintainersList, &bzpb.Maintainer{
			Github: login,
		})
	}

	// Extract version strings from releases (reverse order - latest should be last)
	versions := make([]string, 0, len(releases))
	for i := len(releases) - 1; i >= 0; i-- {
		versions = append(versions, releases[i].Version)
	}

	metadata := &bzpb.ModuleMetadata{
		Maintainers: maintainersList,
		Homepage:    fmt.Sprintf("https://github.com/%s/%s", bazelOrg, bazelRepo),
		Repository:  []string{fmt.Sprintf("github:%s/%s", bazelOrg, bazelRepo)},
		Versions:    versions,
	}

	if err := protoutil.WriteFile(metadataPath, metadata); err != nil {
		return fmt.Errorf("failed to write metadata.json: %w", err)
	}

	return nil
}
