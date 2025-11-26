package bcr

import (
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// parseRepository parses a repository string and returns a RepositoryMetadata proto
// Supports formats like:
//   - "github:owner/repo"
//   - "gitlab:owner/repo"
//   - "https://github.com/owner/repo"
//   - "https://gitlab.com/owner/repo"
func parseRepository(repoStr string) (*bzpb.RepositoryMetadata, bool) {
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

// normalizeRepository returns a canonical form of a repository string
// e.g., "github:org/repo"
func normalizeRepository(repoStr string) string {
	md, ok := parseRepository(repoStr)
	if !ok {
		return repoStr
	}
	return formatRepository(md)
}

// formatRepository prints a canonical form of a repository string
// e.g., "github:org/repo"
func formatRepository(md *bzpb.RepositoryMetadata) string {
	switch md.Type {
	case bzpb.RepositoryType_GITHUB:
		return fmt.Sprintf("github:%s/%s", md.Organization, md.Name)
	case bzpb.RepositoryType_GITLAB:
		return fmt.Sprintf("gitlab:%s/%s", md.Organization, md.Name)
	default:
		return fmt.Sprintf("%s/%s", md.Organization, md.Name)
	}
}

// makeRepositoryName creates a Bazel rule name from repository metadata
func makeRepositoryName(md *bzpb.RepositoryMetadata) string {
	switch md.Type {
	case bzpb.RepositoryType_GITHUB:
		return fmt.Sprintf("com_github_%s_%s", md.Organization, md.Name)
	case bzpb.RepositoryType_GITLAB:
		return fmt.Sprintf("com_gitlab_%s_%s", md.Organization, md.Name)
	default:
		return fmt.Sprintf("%s_%s", md.Organization, md.Name)
	}
}

// trackRepositories adds repositories from metadata to the extension's repository set
func (ext *bcrExtension) trackRepositories(repos []string) {
	for _, repo := range repos {
		if md, ok := parseRepository(repo); ok {
			normalized := formatRepository(md)
			ext.repositories[normalized] = md
		}
	}
}

// makeRepositoryMetadataRules creates repository_metadata rules from the
// tracked repositories
func makeRepositoryMetadataRules(repositories map[string]*bzpb.RepositoryMetadata) []*rule.Rule {
	var rules []*rule.Rule

	keys := slices.Sorted(maps.Keys(repositories))

	for _, k := range keys {
		md := repositories[k]
		// Generate rule name
		ruleName := makeRepositoryName(md)
		// Create the rule
		r := makeRepositoryMetadataRule(ruleName, md)
		rules = append(rules, r)
	}

	return rules
}
