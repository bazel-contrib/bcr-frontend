package bcr

import (
	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

const multipleVersionOverrideKind = "multiple_version_override"

func multipleVersionOverrideLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:multiple_version_override.bzl",
		Symbols: []string{multipleVersionOverrideKind},
	}
}

func multipleVersionOverrideKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		multipleVersionOverrideKind: {
			MatchAny: true,
		},
	}
}

func makeMultipleVersionOverrideRule(moduleName string, override *bzpb.MultipleVersionOverride) *rule.Rule {
	r := rule.NewRule(multipleVersionOverrideKind, moduleName+"_override")
	r.SetAttr("module_name", moduleName)
	if len(override.Versions) > 0 {
		r.SetAttr("versions", override.Versions)
	}
	if override.Registry != "" {
		r.SetAttr("registry", override.Registry)
	}
	r.SetAttr("visibility", []string{"//visibility:public"})
	return r
}

func multipleVersionOverrideImports(r *rule.Rule) []resolve.ImportSpec {
	moduleName := r.AttrString("module_name")
	if moduleName == "" {
		return nil
	}
	return []resolve.ImportSpec{{
		Lang: "bcr_override",
		Imp:  moduleName,
	}}
}
