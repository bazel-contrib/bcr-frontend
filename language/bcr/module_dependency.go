package bcr

import (
	"fmt"
	"log"

	"github.com/bazelbuild/bazel-gazelle/label"
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// moduleDependencyLoadInfo returns load info for the module_dependency rule
func moduleDependencyLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:module_dependency.bzl",
		Symbols: []string{"module_dependency"},
	}
}

// moduleDependencyKinds returns kind info for the module_dependency rule
func moduleDependencyKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"module_dependency": {
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

	for i, dep := range deps {
		name := dep.Name
		if name == "" {
			name = fmt.Sprintf("dep_%d", i)
		}

		r := rule.NewRule("module_dependency", name)
		r.SetAttr("dep_name", dep.Name)
		if dep.Version != "" {
			r.SetAttr("version", dep.Version)
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
func makeOverrideRule(moduleName string, override interface{}) *rule.Rule {
	switch o := override.(type) {
	case *bzpb.ModuleDependency_GitOverride:
		return makeGitOverrideRule(moduleName, o.GitOverride)
	case *bzpb.ModuleDependency_ArchiveOverride:
		return makeArchiveOverrideRule(moduleName, o.ArchiveOverride)
	case *bzpb.ModuleDependency_SingleVersionOverride:
		return makeSingleVersionOverrideRule(moduleName, o.SingleVersionOverride)
	case *bzpb.ModuleDependency_LocalPathOverride:
		return makeLocalPathOverrideRule(moduleName, o.LocalPathOverride)
	default:
		return nil
	}
}

// resolveModuleDependencyRule resolves the module and cycle attributes for a module_dependency rule
func resolveModuleDependencyRule(cfg *Config, r *rule.Rule, ix *resolve.RuleIndex, from label.Label, moduleToCycle map[string]string) {
	// Get the dependency name and version to construct the import spec
	depName := r.AttrString("dep_name")
	version := r.AttrString("version")

	if depName == "" || version == "" {
		log.Printf("module_dependency %s missing dep_name or version", from)
		return
	}

	// Construct the import spec: "module_name@version"
	moduleVersion := fmt.Sprintf("%s@%s", depName, version)
	importSpec := resolve.ImportSpec{
		Lang: bcrLangName,
		Imp:  moduleVersion,
	}

	// Find the module_version rule that provides this import
	results := ix.FindRulesByImport(importSpec, bcrLangName)

	if len(results) == 0 {
		log.Printf("%s: No module_version found for %s", from, moduleVersion)
		return
	}

	// Use the first result (should only be one)
	result := results[0]

	// Check if this module is part of a cycle
	if cycleName, inCycle := moduleToCycle[moduleVersion]; inCycle {
		// Set the cycle attr to point to the cycle rule
		cycleLabel := fmt.Sprintf("//%s:%s", cfg.modulesRoot, cycleName)
		r.SetAttr("cycle", cycleLabel)
	} else {
		// Set the module attr to point to the found module_version rule
		r.SetAttr("module", result.Label.String())
	}
}
