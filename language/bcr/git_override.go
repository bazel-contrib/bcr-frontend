package bcr

import (
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

const gitOverrideKind = "git_override"

// gitOverrideLoadInfo returns load info for the git_override rule
func gitOverrideLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:git_override.bzl",
		Symbols: []string{gitOverrideKind},
	}
}

// gitOverrideKinds returns kind info for the git_override rule
func gitOverrideKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		gitOverrideKind: {
			MatchAny: true,
		},
	}
}

// makeGitOverrideRule creates a git_override rule from proto data
func makeGitOverrideRule(moduleName string, override *bzpb.GitOverride) *rule.Rule {
	r := rule.NewRule(gitOverrideKind, moduleName+"_override")
	r.SetAttr("module_name", moduleName)
	if override.Commit != "" {
		r.SetAttr("commit", override.Commit)
	}
	if override.Remote != "" {
		r.SetAttr("remote", override.Remote)
	}
	if override.Branch != "" {
		r.SetAttr("branch", override.Branch)
	}
	if override.PatchStrip != 0 {
		r.SetAttr("patch_strip", int(override.PatchStrip))
	}
	if len(override.Patches) > 0 {
		r.SetAttr("patches", override.Patches)
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
