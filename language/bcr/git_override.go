package bcr

import (
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// gitOverrideLoadInfo returns load info for the git_override rule
func gitOverrideLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:git_override.bzl",
		Symbols: []string{"git_override"},
	}
}

// gitOverrideKinds returns kind info for the git_override rule
func gitOverrideKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"git_override": {
			MatchAny: true,
		},
	}
}

// makeGitOverrideRule creates a git_override rule from proto data
func makeGitOverrideRule(moduleName string, override *bzpb.GitOverride) *rule.Rule {
	r := rule.NewRule("git_override", moduleName+"_override")
	r.SetAttr("module_name", moduleName)
	if override.Commit != "" {
		r.SetAttr("commit", override.Commit)
	}
	if override.PatchStrip != 0 {
		r.SetAttr("patch_strip", int(override.PatchStrip))
	}
	if len(override.Patches) > 0 {
		r.SetAttr("patches", override.Patches)
	}
	if override.Remote != "" {
		r.SetAttr("remote", override.Remote)
	}
	r.SetAttr("visibility", []string{"//visibility:public"})
	return r
}

// gitOverrideImports returns import specs for indexing git_override rules
func gitOverrideImports(r *rule.Rule) []resolve.ImportSpec {
	moduleName := r.AttrString("module_name")
	if moduleName == "" {
		return nil
	}
	return []resolve.ImportSpec{{
		Lang: "bcr_override",
		Imp:  moduleName,
	}}
}
