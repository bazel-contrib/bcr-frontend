package bcr

import (
	"net/http"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/netutil"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

const (
	moduleSourceKind         = "module_source"
	moduleVersionPrivateAttr = "_module_version"
)

func moduleSourceLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:module_source.bzl",
		Symbols: []string{moduleSourceKind},
	}
}

func moduleSourceKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		moduleSourceKind: {
			MatchAny:     true,
			ResolveAttrs: map[string]bool{"docs_url": true},
		},
	}
}

func makeModuleSourceRule(module *bzpb.ModuleVersion, source *bzpb.ModuleSource, sourceJsonFile string) *rule.Rule {
	r := rule.NewRule(moduleSourceKind, "source")

	r.SetPrivateAttr(moduleVersionPrivateAttr, module)

	if source.Url != "" {
		r.SetAttr("url", source.Url)
	}
	if source.DocsUrl != "" {
		r.SetAttr("docs_url", source.DocsUrl)
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
	if source.CommitSha != "" {
		r.SetAttr("commit_sha", source.CommitSha)
	}

	return r
}

func updateModuleSourceRuleDocsUrlStatus(r *rule.Rule, status netutil.URLStatus) {
	if status.Code != 0 {
		r.SetAttr("docs_url_status_code", status.Code)
	}
	if status.Code != http.StatusOK && status.Message != "" {
		r.SetAttr("docs_url_status_message", status.Message)
	}
}

func updateModuleSourceRuleUrlStatus(r *rule.Rule, status netutil.URLStatus) {
	if status.Code != 0 {
		r.SetAttr("url_status_code", status.Code)
	}
	if status.Code != http.StatusOK && status.Message != "" {
		r.SetAttr("url_status_message", status.Message)
	}
}

func updateModuleSourceRuleSourceCommitSha(source *protoRule[*bzpb.ModuleSource], commitSHA string) {
	source.Rule().SetAttr("commit_sha", commitSHA)
	source.Proto().CommitSha = commitSHA
}
