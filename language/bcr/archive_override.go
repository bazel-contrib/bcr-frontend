package bcr

import (
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/registry/v1"
)

const archiveOverrideKind = "archive_override"

// archiveOverrideLoadInfo returns load info for the archive_override rule
func archiveOverrideLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:archive_override.bzl",
		Symbols: []string{archiveOverrideKind},
	}
}

// archiveOverrideKinds returns kind info for the archive_override rule
func archiveOverrideKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		archiveOverrideKind: {
			MatchAny: true,
		},
	}
}

// makeArchiveOverrideRule creates an archive_override rule from proto data
func makeArchiveOverrideRule(moduleName string, override *bzpb.ArchiveOverride) *rule.Rule {
	r := rule.NewRule(archiveOverrideKind, moduleName+"_override")

	r.SetAttr("module_name", moduleName)
	if override.Integrity != "" {
		r.SetAttr("integrity", override.Integrity)
	}
	if override.PatchStrip != 0 {
		r.SetAttr("patch_strip", int(override.PatchStrip))
	}
	if len(override.Patches) > 0 {
		r.SetAttr("patches", override.Patches)
	}
	if override.StripPrefix != "" {
		r.SetAttr("strip_prefix", override.StripPrefix)
	}
	if len(override.Urls) > 0 {
		r.SetAttr("urls", override.Urls)
	}
	r.SetAttr("visibility", []string{"//visibility:public"})

	return r
}

// archiveOverrideImports returns import specs for indexing archive_override rules
func archiveOverrideImports(r *rule.Rule) []resolve.ImportSpec {
	moduleName := r.AttrString("module_name")
	if moduleName == "" {
		return nil
	}
	return []resolve.ImportSpec{{
		Lang: "bcr_override",
		Imp:  moduleName,
	}}
}
