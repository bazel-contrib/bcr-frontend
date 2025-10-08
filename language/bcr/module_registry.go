package bcr

import (
	"log"

	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

func moduleRegistryLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:module_registry.bzl",
		Symbols: []string{"module_registry"},
	}
}

func moduleRegistryKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"module_registry": {
			MatchAny:     true,
			ResolveAttrs: map[string]bool{"deps": true},
		},
	}
}

func makeModuleRegistryRule(name string, subdirs []string) *rule.Rule {
	r := rule.NewRule("module_registry", name)
	r.SetPrivateAttr("subdirs", subdirs)
	r.SetAttr("visibility", []string{"//visibility:public"})
	return r
}

// resolveModuleRegistryRule resolves the deps attribute for a module_registry rule
// by looking up module_metadata rules for each subdir (module name)
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
		}

		deps = append(deps, results[0].Label.String())
	}

	// Set the deps attr
	if len(deps) > 0 {
		r.SetAttr("deps", deps)
	}
}
