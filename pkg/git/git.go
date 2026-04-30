package git

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strings"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
)

// pullRequestRegex matches pull request references in commit messages like "(#5514)"
var pullRequestRegex = regexp.MustCompile(`\(#(\d+)\)`)

// ParsePullRequestFromCommitMessage extracts the pull request number from a commit message.
// Example: "Add basic support for Boost 1.89.0 (#5514)" returns "5514"
func ParsePullRequestFromCommitMessage(message string) string {
	matches := pullRequestRegex.FindStringSubmatch(message)
	if len(matches) > 1 {
		return matches[1]
	}
	return ""
}

// GetFileCreationCommit returns the commit information for when a file was first added (created)
func GetFileCreationCommit(ctx context.Context, repoPath, filePath string) (*bzpb.ModuleCommit, error) {
	// Get first commit (creation) for the file
	// --follow: Follow file renames
	// --diff-filter=A: Only show commits where file was Added
	// Format: SHA|Date|AuthorEmail|Message (email before message since message can contain |)
	output, err := exec.CommandContext(ctx, "git", "-C", repoPath,
		"log", "--follow", "--format=%H|%cI|%aE|%s", "--diff-filter=A", "--", filePath).Output()
	if err != nil {
		return nil, fmt.Errorf("failed to get git commit info for %s: %w", filePath, err)
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) == 0 || lines[0] == "" {
		return nil, fmt.Errorf("no commit history found for %s", filePath)
	}

	// Get the first (oldest) commit - it's the last line
	firstCommit := lines[len(lines)-1]
	parts := strings.SplitN(firstCommit, "|", 4)
	if len(parts) != 4 {
		return nil, fmt.Errorf("unexpected git log output format: %s", firstCommit)
	}

	return &bzpb.ModuleCommit{
		Sha1:        parts[0],
		Date:        parts[1],
		Message:     parts[3],
		PullRequest: ParsePullRequestFromCommitMessage(parts[3]),
	}, nil
}

// GetRegistryCommit returns the current commit SHA and date for a repository
func GetRegistryCommit(ctx context.Context, repoPath string) (sha, date string, err error) {
	// Get commit SHA and date from git repository
	output, err := exec.CommandContext(ctx, "git", "-C", repoPath, "log", "-1", "--format=%H|%cI").Output()
	if err != nil {
		return "", "", fmt.Errorf("failed to get git commit info: %w", err)
	}

	parts := strings.Split(strings.TrimSpace(string(output)), "|")
	if len(parts) != 2 {
		return "", "", fmt.Errorf("unexpected git log output format: %s", output)
	}

	return parts[0], parts[1], nil
}

// GetRemoteURL returns the remote origin URL for a repository
func GetRemoteURL(ctx context.Context, repoPath string) (string, error) {
	output, err := exec.CommandContext(ctx, "git", "-C", repoPath, "config", "--get", "remote.origin.url").Output()
	if err != nil {
		return "", fmt.Errorf("failed to get git remote URL: %w", err)
	}

	remoteURL := strings.TrimSuffix(strings.TrimSpace(string(output)), ".git")
	return remoteURL, nil
}

// GetAllModuleCommits returns commit information for all MODULE.bazel files in one git call
// This is much faster than calling GetFileCreationCommit for each file individually
// Returns a map of file path -> commit info
func GetAllModuleCommits(ctx context.Context, repoPath, pattern string) (map[string]*bzpb.ModuleCommit, error) {
	// Use git log with --name-only to get all commits that touched MODULE.bazel files
	// Format: commit info line, blank line, file names
	// --diff-filter=A: Only commits where files were Added
	// --name-only: Show only file names
	output, err := exec.CommandContext(ctx, "git", "-C", repoPath,
		"log", "--all", "--diff-filter=A", "--name-only", "--format=%H|%cI|%aE|%s|FILE_MARKER", "--", pattern).Output()
	if err != nil {
		return nil, fmt.Errorf("failed to get git log: %w", err)
	}

	commits := make(map[string]*bzpb.ModuleCommit)
	lines := strings.Split(string(output), "\n")

	var currentCommit *bzpb.ModuleCommit
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// Check if this is a commit info line (contains FILE_MARKER)
		if strings.Contains(line, "FILE_MARKER") {
			parts := strings.SplitN(strings.Replace(line, "|FILE_MARKER", "", 1), "|", 4)
			if len(parts) == 4 {
				currentCommit = &bzpb.ModuleCommit{
					Sha1:        parts[0],
					Date:        parts[1],
					Message:     parts[3],
					PullRequest: ParsePullRequestFromCommitMessage(parts[3]),
				}
			}
		} else if currentCommit != nil {
			// This is a file name - only record if we haven't seen it yet (want first/oldest commit)
			if _, exists := commits[line]; !exists {
				commits[line] = currentCommit
			}
		}
	}

	return commits, nil
}
