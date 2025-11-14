package bcr

import (
	"fmt"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// repositoryInfo holds parsed repository information
type repositoryInfo struct {
	Type         bzpb.RepositoryType
	Organization string
	Name         string
	Original     string // the original string (e.g., "github:org/repo")
}

// parseRepository parses a repository string and returns normalized info
// Supports formats like:
//   - "github:owner/repo"
//   - "gitlab:owner/repo"
//   - "https://github.com/owner/repo"
//   - "https://gitlab.com/owner/repo"
func parseRepository(repoStr string) (repositoryInfo, bool) {
	var info repositoryInfo
	info.Original = repoStr

	// Try GitHub formats
	if after, found := strings.CutPrefix(repoStr, "github:"); found {
		info.Type = bzpb.RepositoryType_GITHUB
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "https://github.com/"); found {
		info.Type = bzpb.RepositoryType_GITHUB
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "http://github.com/"); found {
		info.Type = bzpb.RepositoryType_GITHUB
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "gitlab:"); found {
		// Future support for GitLab
		info.Type = bzpb.RepositoryType_REPOSITORY_TYPE_UNKNOWN
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "https://gitlab.com/"); found {
		info.Type = bzpb.RepositoryType_REPOSITORY_TYPE_UNKNOWN
		repoStr = after
	} else if after, found := strings.CutPrefix(repoStr, "http://gitlab.com/"); found {
		info.Type = bzpb.RepositoryType_REPOSITORY_TYPE_UNKNOWN
		repoStr = after
	} else {
		// Unknown format
		return info, false
	}

	// Parse owner/repo from the remaining string
	parts := strings.SplitN(repoStr, "/", 2)
	if len(parts) < 2 {
		return info, false
	}

	info.Organization = parts[0]
	info.Name = parts[1]

	// Clean up the name (remove .git suffix, query params, etc.)
	info.Name = strings.TrimSuffix(info.Name, ".git")
	if idx := strings.IndexAny(info.Name, "?#"); idx >= 0 {
		info.Name = info.Name[:idx]
	}

	return info, true
}

// normalizeRepository returns a canonical form of a repository string
// e.g., "github:org/repo"
func normalizeRepository(repoStr string) string {
	info, ok := parseRepository(repoStr)
	if !ok {
		return repoStr
	}

	switch info.Type {
	case bzpb.RepositoryType_GITHUB:
		return fmt.Sprintf("github:%s/%s", info.Organization, info.Name)
	default:
		return fmt.Sprintf("%s/%s", info.Organization, info.Name)
	}
}

// makeRepositoryName creates a Bazel rule name from repository info
func makeRepositoryName(info repositoryInfo) string {
	switch info.Type {
	case bzpb.RepositoryType_GITHUB:
		return fmt.Sprintf("com_github_%s_%s", info.Organization, info.Name)
	default:
		return fmt.Sprintf("%s_%s", info.Organization, info.Name)
	}
}

// trackRepositories adds repositories from metadata to the extension's repository set
func (ext *bcrExtension) trackRepositories(repos []string) {
	for _, repo := range repos {
		normalized := normalizeRepository(repo)
		ext.repositories[normalized] = true
	}
}

// makeRepositoryMetadataRules creates repository_metadata rules from the tracked repositories
func makeRepositoryMetadataRules(repositories map[string]bool) []*rule.Rule {
	var rules []*rule.Rule

	for repoStr := range repositories {
		info, ok := parseRepository(repoStr)
		if !ok {
			continue
		}

		// Create a minimal RepositoryMetadata proto
		md := &bzpb.RepositoryMetadata{
			Type:         info.Type,
			Organization: info.Organization,
			Name:         info.Name,
		}

		// Generate rule name
		ruleName := makeRepositoryName(info)

		// Create the rule
		r := makeRepositoryMetadataRule(ruleName, md)
		rules = append(rules, r)
	}

	return rules
}
