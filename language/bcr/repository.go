package bcr

import (
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

type repositoryID string

// trackRepositories adds repositories from metadata to the extension's repository set
// If a repository is already in the set (e.g., from cache), it is not overwritten
func (ext *bcrExtension) trackRepositories(repos []string) {
	for _, repo := range repos {
		if md, ok := parseRepositoryMetadataFromRepositoryString(repo); ok {
			canonicalName := formatRepositoryID(md)
			// Only add if not already present (preserve cached metadata with
			// Languages, etc.)
			if _, exists := ext.repositoriesMetadataByID[canonicalName]; !exists {
				ext.repositoriesMetadataByID[canonicalName] = md
			}
		}
	}
}

// parseRepositoryMetadataFromRepositoryString parses a repository string and returns a RepositoryMetadata proto
// Supports formats like:
//   - "github:owner/repo"
//   - "gitlab:owner/repo"
//   - "https://github.com/owner/repo"
//   - "https://gitlab.com/owner/repo"
func parseRepositoryMetadataFromRepositoryString(repoStr string) (*bzpb.RepositoryMetadata, bool) {
	md := &bzpb.RepositoryMetadata{}

	// Try GitHub formats
	if after, found := strings.CutPrefix(repoStr, "github:"); found {
		md.Type = bzpb.RepositoryType_GITHUB
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "https://github.com/"); found {
		md.Type = bzpb.RepositoryType_GITHUB
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "http://github.com/"); found {
		md.Type = bzpb.RepositoryType_GITHUB
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "gitlab:"); found {
		// Future support for GitLab
		md.Type = bzpb.RepositoryType_GITLAB
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "https://gitlab.com/"); found {
		md.Type = bzpb.RepositoryType_GITLAB
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "http://gitlab.com/"); found {
		md.Type = bzpb.RepositoryType_GITLAB
		repoStr = after
	} else {
		// Unknown format
		return nil, false
	}

	// Parse owner/repo from the remaining string
	parts := strings.SplitN(repoStr, "/", 2)
	if len(parts) < 2 {
		return nil, false
	}

	md.Organization = parts[0]
	md.Name = parts[1]

	// Clean up the name (remove trailing slashes, .git suffix, query params, etc.)
	md.Name = strings.TrimSuffix(md.Name, "/")
	md.Name = strings.TrimSuffix(md.Name, ".git")
	if idx := strings.IndexAny(md.Name, "?#"); idx >= 0 {
		md.Name = md.Name[:idx]
	}

	return md, true
}

// normalizeRepositoryID returns a canonical form of a repository string e.g.,
// "github:org/repo"
func normalizeRepositoryID(repoStr string) repositoryID {
	md, ok := parseRepositoryMetadataFromRepositoryString(repoStr)
	if !ok {
		return repositoryID(repoStr)
	}
	return formatRepositoryID(md)
}

// formatRepositoryID prints a canonical form of a repository string
// e.g., "github:org/repo"
func formatRepositoryID(md *bzpb.RepositoryMetadata) repositoryID {
	switch md.Type {
	case bzpb.RepositoryType_GITHUB:
		return repositoryID(fmt.Sprintf("github:%s/%s", md.Organization, md.Name))
	case bzpb.RepositoryType_GITLAB:
		return repositoryID(fmt.Sprintf("gitlab:%s/%s", md.Organization, md.Name))
	default:
		return repositoryID(fmt.Sprintf("%s/%s", md.Organization, md.Name))
	}
}

// makeRepositoryMetadataRuleName creates a Bazel rule name from repository metadata
func makeRepositoryMetadataRuleName(md *bzpb.RepositoryMetadata) string {
	switch md.Type {
	case bzpb.RepositoryType_GITHUB:
		return fmt.Sprintf("com_github_%s_%s", md.Organization, md.Name)
	case bzpb.RepositoryType_GITLAB:
		return fmt.Sprintf("com_gitlab_%s_%s", md.Organization, md.Name)
	default:
		return fmt.Sprintf("%s_%s", md.Organization, md.Name)
	}
}

// makeRepositoryMetadataRules creates repository_metadata rules from the
// tracked repositories
func makeRepositoryMetadataRules(repositories map[repositoryID]*bzpb.RepositoryMetadata) (rules []*rule.Rule) {
	keys := slices.Sorted(maps.Keys(repositories))
	for _, k := range keys {
		md := repositories[k]
		rules = append(rules, makeRepositoryMetadataRule(md))
	}
	return
}
