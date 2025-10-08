package bcr

import (
	"fmt"

	"github.com/bazelbuild/bazel-gazelle/config"
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// moduleVersionLoadInfo returns load info for the module_version rule
func moduleVersionLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:module_version.bzl",
		Symbols: []string{"module_version"},
	}
}

// moduleVersionKinds returns kind info for the module_version rule
func moduleVersionKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"module_version": {
			MatchAny: true,
			ResolveAttrs: map[string]bool{
				"deps":         true,
				"source":       true,
				"attestations": true,
			},
		},
	}
}

// makeModuleVersionRule creates a module_version rule from parsed MODULE.bazel data
func makeModuleVersionRule(module *bzpb.ModuleVersion, version string, depRules []*rule.Rule, sourceRule *rule.Rule, attestationsRule *rule.Rule, presubmitRule *rule.Rule, moduleBazelFile string) *rule.Rule {
	r := rule.NewRule("module_version", version)
	if module.Name != "" {
		r.SetAttr("module_name", module.Name)
	}
	if version != "" {
		r.SetAttr("version", version)
	}
	if module.CompatibilityLevel != 0 {
		r.SetAttr("compatibility_level", int(module.CompatibilityLevel))
	}
	if len(module.BazelCompatibility) > 0 {
		r.SetAttr("bazel_compatibility", module.BazelCompatibility)
	}
	if module.RepoName != "" {
		r.SetAttr("repo_name", module.RepoName)
	}
	if len(depRules) > 0 {
		deps := make([]string, len(depRules))
		for i, dr := range depRules {
			deps[i] = fmt.Sprintf(":%s", dr.Name())
		}
		r.SetAttr("deps", deps)
	}
	if sourceRule != nil {
		r.SetAttr("source", fmt.Sprintf(":%s", sourceRule.Name()))
	}
	if attestationsRule != nil {
		r.SetAttr("attestations", fmt.Sprintf(":%s", attestationsRule.Name()))
	}
	if presubmitRule != nil {
		r.SetAttr("presubmit", fmt.Sprintf(":%s", presubmitRule.Name()))
	}
	if moduleBazelFile != "" {
		r.SetAttr("module_bazel", moduleBazelFile)
	}
	r.SetAttr("visibility", []string{"//visibility:public"})

	// Set GazelleImports private attr with the import spec
	// The import spec for a module version is "module_name@version"
	if module.Name != "" && version != "" {
		importSpec := fmt.Sprintf("%s@%s", module.Name, version)
		r.SetPrivateAttr(config.GazelleImportsKey, []string{importSpec})
	}

	return r
}

// moduleVersionImports returns import specs for indexing module_version rules
func moduleVersionImports(r *rule.Rule) []resolve.ImportSpec {
	// Get the module name and version to construct the import spec
	moduleName := r.AttrString("module_name")
	version := r.AttrString("version")

	if moduleName == "" || version == "" {
		return nil
	}

	// Construct and return the import spec: "module_name@version"
	importSpec := resolve.ImportSpec{
		Lang: bcrLangName,
		Imp:  fmt.Sprintf("%s@%s", moduleName, version),
	}

	return []resolve.ImportSpec{importSpec}
}
