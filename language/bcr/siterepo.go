package bcr

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// discoverExistingDocs shallow-clones the site repo and returns the set of
// module versions that already have documentation deployed. It uses a blobless
// clone with sparse checkout to avoid downloading file contents.
func discoverExistingDocs(siteRepoURL string) (map[moduleID]bool, error) {
	tmpDir, err := os.MkdirTemp("", "bcr-site-docs-*")
	if err != nil {
		return nil, fmt.Errorf("creating temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	// Shallow blobless clone with no checkout
	if err := runGit(tmpDir, "clone", "--depth=1", "--filter=blob:none", "--no-checkout", siteRepoURL, "."); err != nil {
		return nil, fmt.Errorf("cloning site repo: %w", err)
	}

	// Enable sparse checkout and limit to modules/ directory
	if err := runGit(tmpDir, "sparse-checkout", "set", "modules"); err != nil {
		return nil, fmt.Errorf("setting sparse checkout: %w", err)
	}

	if err := runGit(tmpDir, "checkout"); err != nil {
		return nil, fmt.Errorf("checking out sparse tree: %w", err)
	}

	// Walk modules/ directory to find existing documentationinfo.pb.gz files
	existing := make(map[moduleID]bool)
	modulesDir := filepath.Join(tmpDir, "modules")

	if _, err := os.Stat(modulesDir); os.IsNotExist(err) {
		log.Println("No modules/ directory found in site repo")
		return existing, nil
	}

	entries, err := os.ReadDir(modulesDir)
	if err != nil {
		return nil, fmt.Errorf("reading modules dir: %w", err)
	}

	for _, moduleEntry := range entries {
		if !moduleEntry.IsDir() {
			continue
		}
		name := moduleEntry.Name()
		versionEntries, err := os.ReadDir(filepath.Join(modulesDir, name))
		if err != nil {
			continue
		}
		for _, versionEntry := range versionEntries {
			if !versionEntry.IsDir() {
				continue
			}
			version := versionEntry.Name()
			docFile := filepath.Join(modulesDir, name, version, "documentationinfo.pb.gz")
			if _, err := os.Stat(docFile); err == nil {
				id := newModuleID(name, version)
				existing[id] = true
			}
		}
	}

	return existing, nil
}

// runGit executes a git command in the given directory.
func runGit(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return nil
}
