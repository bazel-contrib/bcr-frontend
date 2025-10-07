package bcr

import (
	"fmt"

	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/protoutil"
)

func readSourceJson(filename string) (*bzpb.Source, error) {
	var src bzpb.Source
	if err := protoutil.ReadFile(filename, &src); err != nil {
		return nil, fmt.Errorf("reading source json: %v", err)
	}
	return &src, nil
}

func makeModuleSourceRule(source *bzpb.Source) *rule.Rule {
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
