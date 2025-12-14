package bcr

import (
	"fmt"

	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

const bazelVersionKind = "bazel_version"

// bazelVersionLoadInfo returns load info for the bazel_version rule
func bazelVersionLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:bazel_version.bzl",
		Symbols: []string{bazelVersionKind},
	}
}

// bazelVersionKinds returns kind info for the bazel_version rule
func bazelVersionKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		bazelVersionKind: {
			MatchAny: false,
		},
	}
}

// makeBazelVersionRule creates a bazel_version rule for a Bazel release
func makeBazelVersionRule(version string) *rule.Rule {
	r := rule.NewRule(bazelVersionKind, "bazel-"+version)
	r.SetAttr("version", version)
	r.SetAttr("visibility", []string{"//visibility:public"})
	return r
}

// bazelVersionImports returns import specs for indexing bazel_version rules
func bazelVersionImports(r *rule.Rule) []resolve.ImportSpec {
	version := r.AttrString("version")
	if version == "" {
		return nil
	}

	// Import path format: bazel/{VERSION}
	importPath := fmt.Sprintf("bazel/%s", version)

	return []resolve.ImportSpec{
		{
			Lang: bcrLangName,
			Imp:  importPath,
		},
		{
			Lang: bcrLangName,
			Imp:  bazelVersionKind,
		},
	}
}
