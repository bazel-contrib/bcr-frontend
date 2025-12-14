package gh

import (
	"fmt"
	"regexp"
	"strings"
)

// URLType represents the type of GitHub source URL
type URLType int

const (
	URLTypeUnknown URLType = iota
	URLTypeTag            // archive/refs/tags/{tag}
	URLTypeCommitSHA      // archive/{sha}
	URLTypeRelease        // releases/download/{version}
)

// SourceURLInfo contains parsed information from a GitHub source URL
type SourceURLInfo struct {
	Organization string
	Repository   string
	Type         URLType
	Reference    string // tag name, commit SHA, or release version
}

var (
	// Matches: https://github.com/{org}/{repo}/archive/refs/tags/{tag}.{ext}
	tagArchivePattern = regexp.MustCompile(`^https://github\.com/([^/]+)/([^/]+)/archive/refs/tags/([^/]+)\.(tar\.gz|zip)$`)

	// Matches: https://github.com/{org}/{repo}/archive/{sha}.{ext}
	commitArchivePattern = regexp.MustCompile(`^https://github\.com/([^/]+)/([^/]+)/archive/([a-f0-9]{40})\.(tar\.gz|zip)$`)

	// Matches: https://github.com/{org}/{repo}/releases/download/{version}/{filename}
	releaseDownloadPattern = regexp.MustCompile(`^https://github\.com/([^/]+)/([^/]+)/releases/download/([^/]+)/[^/]+$`)
)

// ParseGitHubSourceURL parses a GitHub source URL and extracts organization, repository, and reference information
func ParseGitHubSourceURL(url string) (*SourceURLInfo, error) {
	// Try tag archive pattern
	if matches := tagArchivePattern.FindStringSubmatch(url); matches != nil {
		return &SourceURLInfo{
			Organization: matches[1],
			Repository:   matches[2],
			Type:         URLTypeTag,
			Reference:    strings.TrimSuffix(matches[3], ".tar.gz"), // Remove extension if present
		}, nil
	}

	// Try commit SHA archive pattern
	if matches := commitArchivePattern.FindStringSubmatch(url); matches != nil {
		return &SourceURLInfo{
			Organization: matches[1],
			Repository:   matches[2],
			Type:         URLTypeCommitSHA,
			Reference:    matches[3], // This is already a commit SHA
		}, nil
	}

	// Try release download pattern
	if matches := releaseDownloadPattern.FindStringSubmatch(url); matches != nil {
		return &SourceURLInfo{
			Organization: matches[1],
			Repository:   matches[2],
			Type:         URLTypeRelease,
			Reference:    matches[3],
		}, nil
	}

	return nil, fmt.Errorf("URL does not match any known GitHub source URL pattern: %s", url)
}

// IsGitHubURL checks if a URL is a GitHub URL
func IsGitHubURL(url string) bool {
	return strings.HasPrefix(url, "https://github.com/")
}

// String returns a string representation of the URLType
func (t URLType) String() string {
	switch t {
	case URLTypeTag:
		return "tag"
	case URLTypeCommitSHA:
		return "commit_sha"
	case URLTypeRelease:
		return "release"
	default:
		return "unknown"
	}
}
