package bcr

import (
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

const modulePresubmitKind = "module_presubmit"

func modulePresubmitLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:module_presubmit.bzl",
		Symbols: []string{modulePresubmitKind},
	}
}

func modulePresubmitKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		modulePresubmitKind: {
			MatchAny:     true,
			ResolveAttrs: map[string]bool{},
		},
	}
}

func makeModulePresubmitRule(_ *bzpb.Presubmit, presubmitYmlFile string) *rule.Rule {
	r := rule.NewRule(modulePresubmitKind, "presubmit")

	// TODO: Consider creating nested rules for BcrTestModule, Matrix, and Tasks
	// to properly represent the hierarchical structure

	if presubmitYmlFile != "" {
		r.SetAttr("presubmit_yml", presubmitYmlFile)
	}

	return r
}
