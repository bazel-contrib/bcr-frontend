package bcr

import (
	"github.com/bazelbuild/bazel-gazelle/config"
	"github.com/bazelbuild/bazel-gazelle/label"
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/sourcejson"
)

func moduleSourceLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:module_source.bzl",
		Symbols: []string{"module_source"},
	}
}

func moduleSourceKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"module_source": {
			MatchAny:     true,
			ResolveAttrs: map[string]bool{"docs_url": true},
		},
	}
}
func readModuleSourceJson(filename string) (*bzpb.ModuleSource, error) {
	return sourcejson.ReadFile(filename)
}

func makeModuleSourceRule(module *bzpb.ModuleVersion, source *bzpb.ModuleSource, sourceJsonFile string, ext *bcrExtension) *rule.Rule {
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

	if source.DocsUrl != "" {
		r.SetAttr("docs_url", source.DocsUrl)
		docsLabel := ext.trackDocsUrl(source.DocsUrl)
		if docsLabel != label.NoLabel {
			r.SetAttr("docs", []string{docsLabel.String()})
		}
	}

	bundleLabel := ext.trackDocsBundle(module, source)
	r.SetAttr("docs_bundle", bundleLabel.String())

	return r
}

func resolveModuleSourceRule(r *rule.Rule, c *config.Config, from label.Label) {
}
