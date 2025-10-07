package bcr

import (
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// localPathOverrideLoadInfo returns load info for the local_path_override rule
func localPathOverrideLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:local_path_override.bzl",
		Symbols: []string{"local_path_override"},
	}
}

// localPathOverrideKinds returns kind info for the local_path_override rule
func localPathOverrideKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"local_path_override": {
			MatchAny: true,
		},
	}
}

// makeLocalPathOverrideRule creates a local_path_override rule from proto data
func makeLocalPathOverrideRule(moduleName string, override *bzpb.LocalPathOverride) *rule.Rule {
	r := rule.NewRule("local_path_override", moduleName+"_override")
	r.SetAttr("module_name", moduleName)
	if override.Path != "" {
		r.SetAttr("path", override.Path)
	}
	r.SetAttr("visibility", []string{"//visibility:public"})
	return r
}

// localPathOverrideImports returns import specs for indexing local_path_override rules
func localPathOverrideImports(r *rule.Rule) []resolve.ImportSpec {
	moduleName := r.AttrString("module_name")
	if moduleName == "" {
		return nil
	}
	return []resolve.ImportSpec{{
		Lang: "bcr_override",
		Imp:  moduleName,
	}}
}
