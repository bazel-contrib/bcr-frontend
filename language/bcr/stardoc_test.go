package bcr

import (
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

func TestMakeOverlayBzlRepository(t *testing.T) {
	const (
		moduleName    = "colordiff"
		moduleVersion = "1.0.22"
		registryRoot  = "data/bazel-central-registry"
	)
	lbl := makeBzlRepositoryModulesLabel(moduleName, moduleVersion)
	r := makeOverlayBzlRepository(lbl, moduleName, moduleVersion, registryRoot)

	if got, want := r.Kind(), starlarkRepositoryLocalKind; got != want {
		t.Errorf("kind = %q, want %q", got, want)
	}
	if got, want := r.Name(), "bzl.colordiff---1.0.22"; got != want {
		t.Errorf("name = %q, want %q", got, want)
	}
	if got, want := r.AttrString("path"), "data/bazel-central-registry/modules/colordiff/1.0.22/overlay"; got != want {
		t.Errorf("path = %q, want %q", got, want)
	}
	if got, want := r.AttrString("build_file_generation"), "preserve"; got != want {
		t.Errorf("build_file_generation = %q, want %q", got, want)
	}
	if got := r.AttrStrings("languages"); len(got) != 1 || got[0] != starlarkRepositoryLanguageName {
		t.Errorf("languages = %v, want [%q]", got, starlarkRepositoryLanguageName)
	}
	if got := r.AttrStrings("build_directives"); len(got) != 1 || got[0] != "gazelle:starlarkrepository_root" {
		t.Errorf("build_directives = %v, want [gazelle:starlarkrepository_root]", got)
	}
	// The local kind must NOT carry archive-only attrs.
	if got := r.AttrStrings("urls"); len(got) != 0 {
		t.Errorf("urls should be empty on local kind, got %v", got)
	}
	if got := r.AttrString("strip_prefix"); got != "" {
		t.Errorf("strip_prefix should be empty on local kind, got %q", got)
	}
}

func TestMakeBzlRepository(t *testing.T) {
	lbl := makeBzlRepositoryModulesLabel("pahole", "1.31")
	module := &bzpb.ModuleVersion{Name: "pahole", Version: "1.31"}
	source := &bzpb.ModuleSource{
		Url:         "https://git.kernel.org/pub/scm/devel/pahole/pahole.git/snapshot/pahole-1.31.tar.gz",
		StripPrefix: "pahole-1.31",
	}
	r := makeBzlRepository(lbl, module, source)

	if got, want := r.Kind(), starlarkRepositoryArchiveKind; got != want {
		t.Errorf("kind = %q, want %q", got, want)
	}
	if got := r.AttrStrings("urls"); len(got) != 1 || got[0] != source.Url {
		t.Errorf("urls = %v, want [%q]", got, source.Url)
	}
	if got, want := r.AttrString("type"), "tar.gz"; got != want {
		t.Errorf("type = %q, want %q", got, want)
	}
	if got, want := r.AttrString("strip_prefix"), "pahole-1.31"; got != want {
		t.Errorf("strip_prefix = %q, want %q", got, want)
	}
	if got, want := r.AttrString("build_file_generation"), "preserve"; got != want {
		t.Errorf("build_file_generation = %q, want %q", got, want)
	}
	// Archive kind must NOT carry the local-kind path attr.
	if got := r.AttrString("path"); got != "" {
		t.Errorf("path should be empty on archive kind, got %q", got)
	}
}

func TestIsStarlarkCandidate(t *testing.T) {
	const repoID = "github:bazelbuild/example"
	tests := []struct {
		name         string
		repositories []string
		repoMeta     map[repositoryID]*bzpb.RepositoryMetadata
		want         bool
	}{
		{
			name:         "some repo has Starlark",
			repositories: []string{"github:bazelbuild/example"},
			repoMeta: map[repositoryID]*bzpb.RepositoryMetadata{
				repoID: {Languages: map[string]int32{"Starlark": 1000}},
			},
			want: true,
		},
		{
			name:         "all repos lack metadata entirely",
			repositories: []string{"gitlab:arm/rules_tar"},
			repoMeta:     map[repositoryID]*bzpb.RepositoryMetadata{},
			want:         true,
		},
		{
			name:         "all repos have nil Languages",
			repositories: []string{"github:bazelbuild/example"},
			repoMeta: map[repositoryID]*bzpb.RepositoryMetadata{
				repoID: {Languages: nil},
			},
			want: true,
		},
		{
			name:         "all repos have empty Languages map",
			repositories: []string{"github:bazelbuild/example"},
			repoMeta: map[repositoryID]*bzpb.RepositoryMetadata{
				repoID: {Languages: map[string]int32{}},
			},
			want: true,
		},
		{
			name:         "populated Languages without Starlark is a negative signal",
			repositories: []string{"github:bazelbuild/example"},
			repoMeta: map[repositoryID]*bzpb.RepositoryMetadata{
				repoID: {Languages: map[string]int32{"C": 1000}},
			},
			want: false,
		},
		{
			name:         "mixed: one negative signal still rejects",
			repositories: []string{"github:bazelbuild/example", "gitlab:arm/rules_tar"},
			repoMeta: map[repositoryID]*bzpb.RepositoryMetadata{
				repoID: {Languages: map[string]int32{"C": 1000}},
				// gitlab repo has no metadata entry — by itself a non-signal,
				// but the github entry's populated non-Starlark map wins.
			},
			want: false,
		},
		{
			name:         "mixed: Starlark in any populated map still wins",
			repositories: []string{"github:bazelbuild/example", "gitlab:arm/rules_tar"},
			repoMeta: map[repositoryID]*bzpb.RepositoryMetadata{
				repoID: {Languages: map[string]int32{"Starlark": 500, "Go": 500}},
			},
			want: true,
		},
		{
			name:         "no repository entries",
			repositories: nil,
			repoMeta:     map[repositoryID]*bzpb.RepositoryMetadata{},
			want:         false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := rule.NewRule(moduleMetadataKind, "metadata")
			if tt.repositories != nil {
				r.SetAttr("repository", tt.repositories)
			}
			if got := isStarlarkCandidate(r, tt.repoMeta); got != tt.want {
				t.Errorf("isStarlarkCandidate = %v, want %v", got, tt.want)
			}
		})
	}
}
