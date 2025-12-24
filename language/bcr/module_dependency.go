package bcr

import (
	"fmt"
	"log"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazelbuild/bazel-gazelle/label"
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

const moduleDependencyKind = "module_dependency"

// moduleDependencyLoadInfo returns load info for the module_dependency rule
func moduleDependencyLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:module_dependency.bzl",
		Symbols: []string{moduleDependencyKind},
	}
}

// moduleDependencyKinds returns kind info for the module_dependency rule
func moduleDependencyKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		moduleDependencyKind: {
			MatchAny: true,
			ResolveAttrs: map[string]bool{
				"module":   true,
				"cycle":    true,
				"override": true,
			},
		},
	}
}

// makeModuleDependencyRules creates module_dependency rules from MODULE.bazel bazel_dep entries
// Returns both dependency rules and override rules
func makeModuleDependencyRules(deps []*bzpb.ModuleDependency) ([]*rule.Rule, []*rule.Rule) {
	var depRules []*rule.Rule
	var overrideRules []*rule.Rule

	for _, dep := range deps {
		if dep.Name == "" {
			log.Panicf("dep.Name is mandatory: %+v", dep)
		}

		r := rule.NewRule(moduleDependencyKind, dep.Name)
		r.SetAttr("dep_name", dep.Name)
		if dep.Version != "" {
			r.SetAttr("version", dep.Version)
		}
		if dep.RepoName != "" {
			r.SetAttr("repo_name", dep.RepoName)
		}
		if dep.Dev {
			r.SetAttr("dev", dep.Dev)
		}

		// Create override rule if present
		if dep.Override != nil {
			overrideRule := makeOverrideRule(dep.Name, dep.Override)
			if overrideRule != nil {
				overrideRules = append(overrideRules, overrideRule)
				// Link the dependency to its override
				r.SetAttr("override", fmt.Sprintf(":%s", overrideRule.Name()))
			}
		}

		depRules = append(depRules, r)
	}
	return depRules, overrideRules
}

// makeOverrideRule creates an override rule based on the override type
func makeOverrideRule(moduleName string, override *bzpb.ModuleDependencyOverride) *rule.Rule {
	if override == nil {
		return nil
	}

	switch o := override.Override.(type) {
	case *bzpb.ModuleDependencyOverride_GitOverride:
		return makeGitOverrideRule(moduleName, o.GitOverride)
	case *bzpb.ModuleDependencyOverride_ArchiveOverride:
		return makeArchiveOverrideRule(moduleName, o.ArchiveOverride)
	case *bzpb.ModuleDependencyOverride_SingleVersionOverride:
		return makeSingleVersionOverrideRule(moduleName, o.SingleVersionOverride)
	case *bzpb.ModuleDependencyOverride_LocalPathOverride:
		return makeLocalPathOverrideRule(moduleName, o.LocalPathOverride)
	default:
		return nil
	}
}

// resolveModuleDependencyRule resolves the module and cycle attributes for a module_dependency rule
func resolveModuleDependencyRule(modulesRoot string, r *rule.Rule, ix *resolve.RuleIndex, from label.Label, moduleToCycle map[moduleID]string, unresolvedModules map[moduleID]bool) {
	// Get the dependency name and version to construct the import spec
	depName := r.AttrString("dep_name")
	version := r.AttrString("version")
	override := r.AttrString("override")

	if version == "" {
		if override == "" {
			log.Printf("%s: module_dependency '%s' missing version and override", from, depName)
		}
		return
	}

	// Construct the import spec: "module_name@version"
	id := newModuleID(depName, version).String()
	importSpec := resolve.ImportSpec{
		Lang: bcrLangName,
		Imp:  id,
	}

	// Find the module_version rule that provides this import
	results := ix.FindRulesByImport(importSpec, bcrLangName)

	if len(results) == 0 {
		if override == "" {
			log.Printf("%s: No module_version (or override) found for %s", from, id)
			r.SetAttr("unresolved", true)
			// Track this as unresolved so MVS can skip it
			if unresolvedModules != nil {
				unresolvedModules[moduleID(id)] = true
			}
		}
		return
	}

	// Use the first result (should only be one)
	result := results[0]

	// Check if this module is part of a cycle
	if generateModuleDependencyCycleRules {
		id := moduleID(id)
		if cycleName, inCycle := moduleToCycle[id]; inCycle {
			// Set the cycle attr to point to the cycle rule
			cycleLabel := fmt.Sprintf("//%s:%s", modulesRoot, cycleName)
			r.SetAttr("cycle", cycleLabel)
		} else {
			// Set the module attr to point to the found module_version rule
			r.SetAttr("module", result.Label.String())
		}
	}
}
