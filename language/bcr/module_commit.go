package bcr

import (
	"context"
	"log"
	"path/filepath"

	"github.com/bazelbuild/bazel-gazelle/config"
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	gitpkg "github.com/stackb/centrl/pkg/git"
)

// moduleCommitLoadInfo returns load info for the module_commit rule
func moduleCommitLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:module_commit.bzl",
		Symbols: []string{"module_commit"},
	}
}

// moduleCommitKinds returns kind info for the module_commit rule
func moduleCommitKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"module_commit": {
			MatchAny: false,
		},
	}
}

// makeModuleVersionCommitRule creates a module_commit rule with git commit metadata
// modulePath should be relative to the workspace root (e.g., "data/bazel-central-registry/modules/apple_support/1.22.0")
// submoduleRoot should be the path to the submodule root relative to workspace (e.g., "data/bazel-central-registry")
// commitsCache is the preloaded cache of module commits (can be nil for fallback)
func makeModuleVersionCommitRule(cfg *config.Config, registryRoot, rel string, commitsCache map[moduleKey]*bzpb.ModuleCommit) (*rule.Rule, error) {
	// Strip submodule prefix from modulePath to get path relative to submodule
	// e.g., "data/bazel-central-registry/modules/apple_support/1.22.0" -> "modules/apple_support/1.22.0"
	relPath, err := filepath.Rel(registryRoot, rel)
	if err != nil {
		return nil, err
	}

	// Get the MODULE.bazel file path relative to submodule
	moduleFile := filepath.Join(relPath, "MODULE.bazel")

	var commit *bzpb.ModuleCommit

	// Try to get from cache first
	if commitsCache != nil {
		if cached, ok := commitsCache[moduleKey(moduleFile)]; ok {
			commit = cached
		}
	}

	// Fallback to individual git call if not in cache
	if commit == nil {
		ctx := context.Background()
		submodulePath := filepath.Join(cfg.RepoRoot, registryRoot)
		commit, err = gitpkg.GetFileCreationCommit(ctx, submodulePath, moduleFile)
		if err != nil {
			return nil, err
		}
	}

	r := rule.NewRule("module_commit", "commit")
	r.SetAttr("sha1", commit.Sha1)
	r.SetAttr("date", commit.Date)
	r.SetAttr("message", commit.Message)

	// Store the proto representation in private attr
	r.SetPrivateAttr("commit", commit)

	return r, nil
}

func (ext *bcrExtension) readModuleCommits(c *config.Config) {
	// Preload all module commits in one git call for performance
	ctx := context.Background()
	submodulePath := filepath.Join(c.RepoRoot, ext.registryRoot)
	log.Printf("Preloading module commits from %s...", submodulePath)
	commits, err := gitpkg.GetAllModuleCommits(ctx, submodulePath, "modules/*/*/MODULE.bazel")
	if err != nil {
		log.Printf("warning: failed to preload module commits: %v", err)
		ext.moduleCommitsByModuleName = make(map[moduleKey]*bzpb.ModuleCommit)
	} else {
		// Convert map[string]*bzpb.ModuleCommit to map[moduleKey]*bzpb.ModuleCommit
		ext.moduleCommitsByModuleName = make(map[moduleKey]*bzpb.ModuleCommit, len(commits))
		for key, commit := range commits {
			ext.moduleCommitsByModuleName[moduleKey(key)] = commit
		}
		log.Printf("Preloaded %d module commits", len(commits))
	}
}
