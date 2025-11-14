package bcr

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
	"github.com/bazelbuild/buildtools/build"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// repositoryMetadataLoadInfo returns load info for the repository_metadata rule
func repositoryMetadataLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:repository_metadata.bzl",
		Symbols: []string{"repository_metadata"},
	}
}

// repositoryMetadataKinds returns kind info for the repository_metadata rule
func repositoryMetadataKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"repository_metadata": {
			MatchAttrs: []string{"type", "organization", "repo_name"},
		},
	}
}

// repositoryMetadataImports returns import specs for indexing module_metadata rules
func repositoryMetadataImports(r *rule.Rule) []resolve.ImportSpec {
	return []resolve.ImportSpec{{
		Lang: bcrLangName,
		Imp:  fmt.Sprintf("%s:%s/%s", r.AttrString("type"), r.AttrString("organization"), r.AttrString("repo_name")),
	}}
}

// makeRepositoryMetadataRule creates a repository_metadata rule from protobuf metadata
func makeRepositoryMetadataRule(name string, md *bzpb.RepositoryMetadata) *rule.Rule {
	r := rule.NewRule("repository_metadata", name)

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
	}

	r.SetAttr("visibility", []string{"//visibility:public"})
	return r
}

// resolveRepositoryMetadataRule resolves the deps and overrides attributes for a module_metadata rule
// by looking up module_version rules for each version in the versions list
// and override rules for the module
func resolveRepositoryMetadataRule(r *rule.Rule, _ *resolve.RuleIndex) {
	// Increment the stargazers attribute
	if stargazers, ok := r.Attr("stargazers").(*build.LiteralExpr); ok {
		stars, err := strconv.ParseInt(string(stargazers.Token), 10, 32)
		if err == nil {
			r.SetAttr("stargazers", stars+1)
		}
	} else {
		r.SetAttr("stargazers", 1)
	}
}

func makeStringDict(in map[string]int32) map[string]string {
	if in == nil {
		return nil
	}
	dict := make(map[string]string)
	for k, v := range in {
		dict[k] = string(v)
	}
	return dict
}
