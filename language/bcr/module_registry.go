package bcr

import (
	"context"
	"fmt"
	"log"
	"path/filepath"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	gitpkg "github.com/bazel-contrib/bcr-frontend/pkg/git"
	"github.com/bazelbuild/bazel-gazelle/config"
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

const moduleRegistryKind = "module_registry"

func moduleRegistryLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:module_registry.bzl",
		Symbols: []string{moduleRegistryKind},
	}
}

func moduleRegistryKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		moduleRegistryKind: {
			MatchAny: true,
			ResolveAttrs: map[string]bool{
				"deps":           true,
				"cycles":         true,
				"bazel_versions": true,
			},
		},
	}
}

func makeModuleRegistryRule(name string, subdirs []string, registryURL string, cycleRules []*rule.Rule, cfg *config.Config) *rule.Rule {
	r := rule.NewRule(moduleRegistryKind, name)
	if len(cycleRules) > 0 {
		cycles := make([]string, len(cycleRules))
		for i, mr := range cycleRules {
			cycles[i] = fmt.Sprintf(":%s", mr.Name())
		}
		r.SetAttr("cycles", cycles)
	}

	r.SetPrivateAttr("subdirs", subdirs)
	r.SetAttr("visibility", []string{"//visibility:public"})

	// Fetch registry metadata from git submodule
	ctx := context.Background()
	submodulePath := filepath.Join(cfg.RepoRoot, "data", "bazel-central-registry")
	registry, err := getBazelCentralRegistryMetadata(ctx, submodulePath)
	if err != nil {
		log.Printf("warning: failed to fetch registry metadata: %v", err)
	} else {
		r.SetAttr("registry_url", registryURL)
		r.SetAttr("repository_url", registry.RepositoryUrl)
		r.SetAttr("commit", registry.CommitSha)
		r.SetAttr("commit_date", registry.CommitDate)
	}

	return r
}

// resolveModuleRegistryRule resolves the deps and bazel_versions attributes for
// a module_registry rule by looking up module_metadata and bazel_version rules
func resolveModuleRegistryRule(r *rule.Rule, ix *resolve.RuleIndex) {
	// Get the subdirs private attribute
	subdirsRaw := r.PrivateAttr("subdirs")
	if subdirsRaw == nil {
		log.Printf("module_registry %s has no subdirs private attr", r.Name())
		return
	}
	subdirs := subdirsRaw.([]string)
	if len(subdirs) == 0 {
		return
	}

	// Resolve each subdir (module name) to its module_metadata rule
	deps := make([]string, 0, len(subdirs))
	for _, moduleName := range subdirs {
		// Construct the import spec using the module name
		// module_metadata rules are indexed by their name "metadata"
		importSpec := resolve.ImportSpec{
			Lang: bcrLangName,
			Imp:  moduleName,
		}

		// Find all module_metadata rules with this import
		results := ix.FindRulesByImport(importSpec, bcrLangName)
		if len(results) == 0 {
			log.Printf("No module_metadata found for module %s", moduleName)
			continue
		}

		deps = append(deps, results[0].Label.String())
	}

	// Set the deps attr
	if len(deps) > 0 {
		r.SetAttr("deps", deps)
	}

	// Resolve bazel_version rules
	bazelVersionImportSpec := resolve.ImportSpec{
		Lang: bcrLangName,
		Imp:  bazelVersionKind,
	}

	results := ix.FindRulesByImport(bazelVersionImportSpec, bcrLangName)
	if len(results) > 0 {
		bazelVersions := make([]string, 0, len(results))
		for _, res := range results {
			bazelVersions = append(bazelVersions, res.Label.String())
		}
		r.SetAttr("bazel_versions", bazelVersions)
	}
}

func getBazelCentralRegistryMetadata(ctx context.Context, submodulePath string) (*bzpb.Registry, error) {
	// Get commit SHA and date using git package
	commitSHA, commitDate, err := gitpkg.GetRegistryCommit(ctx, submodulePath)
	if err != nil {
		return nil, err
	}

	// Get the remote URL using git package
	repositoryURL, err := gitpkg.GetRemoteURL(ctx, submodulePath)
	if err != nil {
		return nil, err
	}

	var registry bzpb.Registry
	registry.RepositoryUrl = repositoryURL
	registry.CommitSha = commitSHA
	registry.CommitDate = commitDate

	return &registry, nil
}
