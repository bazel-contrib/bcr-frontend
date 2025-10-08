package bcr

import (
	"log"
	"sort"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

// buildModuleToCycleMap creates a mapping from module@version to cycle rule name
func buildModuleToCycleMap(cycles [][]string) map[string]string {
	moduleToCycle := make(map[string]string)

	for _, cycle := range cycles {
		if len(cycle) == 0 {
			continue
		}

		// Sort cycle members for deterministic naming
		sorted := make([]string, len(cycle))
		copy(sorted, cycle)
		sort.Strings(sorted)

		// Generate cycle rule name: replace @ with - and join with +
		nameSegments := make([]string, len(sorted))
		for i, moduleVersion := range sorted {
			nameSegments[i] = strings.ReplaceAll(moduleVersion, "@", "-")
		}
		cycleName := strings.Join(nameSegments, "+")

		// Map each module version in the cycle to the cycle name
		for _, moduleVersion := range cycle {
			moduleToCycle[moduleVersion] = cycleName
		}
	}

	return moduleToCycle
}

// makeModuleDependencyCycleRules generates module_dependency_cycle rules for detected cycles
func makeModuleDependencyCycleRules(cycles [][]string) []*rule.Rule {
	var rules []*rule.Rule

	for _, cycle := range cycles {
		if len(cycle) == 0 {
			continue
		}

		// Sort cycle members for deterministic naming
		sorted := make([]string, len(cycle))
		copy(sorted, cycle)
		sort.Strings(sorted)

		// Generate rule name: replace @ with - and join with +
		nameSegments := make([]string, len(sorted))
		for i, moduleVersion := range sorted {
			nameSegments[i] = strings.ReplaceAll(moduleVersion, "@", "-")
		}
		ruleName := strings.Join(nameSegments, "+")

		r := rule.NewRule("module_dependency_cycle", ruleName)

		// Set cycle_modules attr with original module@version strings
		r.SetAttr("cycle_modules", sorted)

		r.SetAttr("visibility", []string{"//visibility:public"})

		rules = append(rules, r)
	}

	return rules
}

// resolveModuleDependencyCycleRule resolves the deps attribute for a module_dependency_cycle rule
func resolveModuleDependencyCycleRule(r *rule.Rule, ix *resolve.RuleIndex) {
	// Get the cycle_modules attribute
	cycleModules := r.AttrStrings("cycle_modules")
	if len(cycleModules) == 0 {
		log.Printf("module_dependency_cycle %s has no cycle_modules", r.Name())
		return
	}

	// Resolve each module@version to its module_version rule
	deps := make([]string, 0, len(cycleModules))
	for _, moduleVersion := range cycleModules {
		// Construct the import spec: "module_name@version"
		importSpec := resolve.ImportSpec{
			Lang: bcrLangName,
			Imp:  moduleVersion,
		}

		// Find the module_version rule that provides this import
		results := ix.FindRulesByImport(importSpec, bcrLangName)

		if len(results) == 0 {
			log.Printf("resolveModuleDependencyCycleRule: No module_version found for %s in cycle %s", moduleVersion, r.Name())
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

func moduleDependencyCycleLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:module_dependency_cycle.bzl",
		Symbols: []string{"module_dependency_cycle"},
	}
}

func moduleDependencyCycleKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"module_dependency_cycle": {
			MatchAny:     true,
			ResolveAttrs: map[string]bool{"deps": true},
		},
	}
}
