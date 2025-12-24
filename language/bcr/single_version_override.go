package bcr

import (
	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

// singleVersionOverrideLoadInfo returns load info for the single_version_override rule
func singleVersionOverrideLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:single_version_override.bzl",
		Symbols: []string{"single_version_override"},
	}
}

// singleVersionOverrideKinds returns kind info for the single_version_override rule
func singleVersionOverrideKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"single_version_override": {
			MatchAny: true,
		},
	}
}

// makeSingleVersionOverrideRule creates a single_version_override rule from proto data
func makeSingleVersionOverrideRule(moduleName string, override *bzpb.SingleVersionOverride) *rule.Rule {
	r := rule.NewRule("single_version_override", moduleName+"_override")
	r.SetAttr("module_name", moduleName)
	if override.PatchStrip != 0 {
		r.SetAttr("patch_strip", int(override.PatchStrip))
	}
	if len(override.Patches) > 0 {
		r.SetAttr("patches", override.Patches)
	}
	if override.Version != "" {
		r.SetAttr("version", override.Version)
	}
	r.SetAttr("visibility", []string{"//visibility:public"})
	return r
}

// singleVersionOverrideImports returns import specs for indexing single_version_override rules
func singleVersionOverrideImports(r *rule.Rule) []resolve.ImportSpec {
	moduleName := r.AttrString("module_name")
	if moduleName == "" {
		return nil
	}
	return []resolve.ImportSpec{{
		Lang: "bcr_override",
		Imp:  moduleName,
	}}
}
