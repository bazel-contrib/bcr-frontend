package bcr

import (
	"fmt"
	"log"

	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

const moduleMetadataKind = "module_metadata"

// moduleMetadataLoadInfo returns load info for the module_metadata rule
func moduleMetadataLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:module_metadata.bzl",
		Symbols: []string{moduleMetadataKind},
	}
}

// moduleMetadataKinds returns kind info for the module_metadata rule
func moduleMetadataKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		moduleMetadataKind: {
			MatchAny: true,
			ResolveAttrs: map[string]bool{
				"maintainers":         true,
				"deps":                true,
				"repository_metadata": true,
			},
		},
	}
}

// makeModuleMetadataRule creates a module_metadata rule from protobuf metadata
// If ext is provided, it will track the repositories for later generation
func makeModuleMetadataRule(name string, md *bzpb.ModuleMetadata, maintainerRules []*rule.Rule, metadataJsonFile string, ext *bcrExtension) *rule.Rule {
	r := rule.NewRule(moduleMetadataKind, name)

	if md.Homepage != "" {
		r.SetAttr("homepage", md.Homepage)
	}
	if len(maintainerRules) > 0 {
		maintainers := make([]string, len(maintainerRules))
		for i, mr := range maintainerRules {
			maintainers[i] = fmt.Sprintf(":%s", mr.Name())
		}
		r.SetAttr("maintainers", maintainers)
	}
	if len(md.Repository) > 0 {
		r.SetAttr("repository", md.Repository)
		// Track repositories if extension is provided
		if ext != nil {
			ext.trackRepositories(md.Repository)
		}
	}
	if len(md.Versions) > 0 {
		r.SetAttr("versions", md.Versions)
	}
	if len(md.YankedVersions) > 0 {
		r.SetAttr("yanked_versions", md.YankedVersions)
	}
	if md.Deprecated != "" {
		r.SetAttr("deprecated", md.Deprecated)
	}
	if metadataJsonFile != "" {
		r.SetAttr("metadata_json", metadataJsonFile)
	}
	r.SetAttr("build_bazel", ":BUILD.bazel")
	r.SetAttr("visibility", []string{"//visibility:public"})

	return r
}

// moduleMetadataImports returns import specs for indexing module_metadata rules
func moduleMetadataImports(r *rule.Rule) []resolve.ImportSpec {
	return []resolve.ImportSpec{{
		Lang: bcrLangName,
		Imp:  r.Name(),
	}}
}

// resolveModuleMetadataRule resolves the deps and overrides attributes for a module_metadata rule
// by looking up module_version rules for each version in the versions list
// and override rules for the module
func resolveModuleMetadataRule(r *rule.Rule, ix *resolve.RuleIndex) {
	// Get the versions attribute
	versions := r.AttrStrings("versions")
	moduleName := r.Name()

	// Resolve each version to its module_version rule
	if len(versions) > 0 {
		deps := make([]string, 0, len(versions))
		for _, version := range versions {
			// Construct the import spec: "module_name@version"
			importSpec := resolve.ImportSpec{
				Lang: bcrLangName,
				Imp:  newModuleID(moduleName, version).String(),
			}

			// Find the module_version rule that provides this import
			results := ix.FindRulesByImport(importSpec, bcrLangName)

			if len(results) == 0 {
				log.Printf("resolveModuleMetadataRule: No module_version found for %s@%s in module_metadata", moduleName, version)
				continue
			}

			// Use the first result (should only be one)
			result := results[0]
			deps = append(deps, result.Label.String())
		}

		// Set the deps attr
		if len(deps) > 0 {
			r.SetAttr("deps", deps)
		}
	}

	for _, repo := range r.AttrStrings("repository") {
		canonicalName := normalizeRepositoryID(repo)
		importSpec := resolve.ImportSpec{
			Lang: bcrLangName,
			Imp:  string(canonicalName),
		}

		// Find the module_version rule that provides this import
		results := ix.FindRulesByImport(importSpec, bcrLangName)

		if len(results) == 0 {
			log.Printf("resolveModuleMetadataRule: No repository_metadata found for %s", canonicalName)
			continue
		}

		// Use the first result (should only be one)
		result := results[0]
		r.SetAttr("repository_metadata", result.Label.String())

		// use the first found repository_metadata
		break
	}
}
