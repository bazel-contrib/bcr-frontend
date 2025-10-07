package bcr

import (
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/sourcejson"
)

func readSourceJson(filename string) (*bzpb.Source, error) {
	return sourcejson.ReadFile(filename)
}

func makeModuleSourceRule(source *bzpb.Source, sourceJsonFile string) *rule.Rule {
	r := rule.NewRule("module_source", "source")
	if source.Url != "" {
		r.SetAttr("url", source.Url)
	}
	if source.Integrity != "" {
		r.SetAttr("integrity", source.Integrity)
	}
	if source.StripPrefix != "" {
		r.SetAttr("strip_prefix", source.StripPrefix)
	}
	if source.PatchStrip != 0 {
		r.SetAttr("patch_strip", int(source.PatchStrip))
	}
	if len(source.Patches) > 0 {
		r.SetAttr("patches", source.Patches)
	}
	if sourceJsonFile != "" {
		r.SetAttr("source_json", sourceJsonFile)
	}
	return r
}

func moduleSourceLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:module_source.bzl",
		Symbols: []string{"module_source"},
	}
}

func moduleSourceKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"module_source": {
			MatchAny:     true,
			ResolveAttrs: map[string]bool{},
		},
	}
}
