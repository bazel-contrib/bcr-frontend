package bcr

import (
	"strconv"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/registry/v1"
)

const repositoryMetadataKind = "repository_metadata"

// repositoryMetadataLoadInfo returns load info for the repository_metadata rule
func repositoryMetadataLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:repository_metadata.bzl",
		Symbols: []string{repositoryMetadataKind},
	}
}

// repositoryMetadataKinds returns kind info for the repository_metadata rule
func repositoryMetadataKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		repositoryMetadataKind: {
			MatchAttrs: []string{"canonical_name"},
			ResolveAttrs: map[string]bool{
				"description":      true,
				"stargazers":       true,
				"primary_language": true,
			},
		},
	}
}

// repositoryMetadataImports returns import specs for indexing module_metadata rules
func repositoryMetadataImports(r *rule.Rule) []resolve.ImportSpec {
	return []resolve.ImportSpec{{
		Lang: bcrLangName,
		Imp:  r.AttrString("canonical_name"),
	}}
}

// makeRepositoryMetadataRule creates a repository_metadata rule from protobuf metadata
func makeRepositoryMetadataRule(md *bzpb.RepositoryMetadata) *rule.Rule {
	ruleName := makeRepositoryMetadataRuleName(md)

	r := rule.NewRule(repositoryMetadataKind, ruleName)
	r.SetAttr("canonical_name", string(formatRepositoryID(md)))
	r.SetAttr("visibility", []string{"//visibility:public"})

	updateRepositoryMetadataRule(md, r)

	return r
}

// updateRepositoryMetadataRule updates a repository_metadata rule from protobuf metadata
func updateRepositoryMetadataRule(md *bzpb.RepositoryMetadata, r *rule.Rule) {
	if md.Type != bzpb.RepositoryType_REPOSITORY_TYPE_UNKNOWN {
		r.SetAttr("type", strings.ToLower(md.Type.String()))
	}
	if md.Organization != "" {
		r.SetAttr("organization", md.Organization)
	}
	if md.Name != "" {
		r.SetAttr("repo_name", md.Name)
	}
	if md.Description != "" {
		r.SetAttr("description", md.Description)
	}
	if md.Stargazers != 0 {
		r.SetAttr("stargazers", int(md.Stargazers))
	}
	if len(md.Languages) > 0 {
		r.SetAttr("languages", makeStringDict(md.Languages))
		primaryLanguage := computePrimaryLanguage(md.Languages)
		r.SetAttr("primary_language", primaryLanguage)
	}
}

// resolveRepositoryMetadataRule updates the rule with metadata attributes after
// data has been fetched for it.
func resolveRepositoryMetadataRule(r *rule.Rule, _ *resolve.RuleIndex, repositories map[repositoryID]*bzpb.RepositoryMetadata) {
	if md, ok := repositories[repositoryID(r.AttrString("canonical_name"))]; ok {
		updateRepositoryMetadataRule(md, r)
	}
}

// computePrimaryLanguage returns the language with the highest line count
func computePrimaryLanguage(languages map[string]int32) string {
	var maxLang string
	var maxCount int32

	for lang, count := range languages {
		if count > maxCount {
			maxCount = count
			maxLang = lang
		}
	}

	return maxLang
}

func makeStringDict(in map[string]int32) map[string]string {
	if in == nil {
		return nil
	}
	dict := make(map[string]string)
	for k, v := range in {
		dict[k] = strconv.Itoa(int(v))
	}
	return dict
}
