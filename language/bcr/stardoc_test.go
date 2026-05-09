package bcr

import (
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazelbuild/bazel-gazelle/language"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

func TestParseGitHubRepoURL(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantOwner string
		wantRepo  string
	}{
		{
			name:      "https with .git",
			input:     "https://github.com/bazelbuild/bazel-central-registry.git",
			wantOwner: "bazelbuild",
			wantRepo:  "bazel-central-registry",
		},
		{
			name:      "https without .git",
			input:     "https://github.com/bazelbuild/bazel-central-registry",
			wantOwner: "bazelbuild",
			wantRepo:  "bazel-central-registry",
		},
		{
			name:      "ssh form",
			input:     "git@github.com:bazelbuild/bazel-central-registry.git",
			wantOwner: "bazelbuild",
			wantRepo:  "bazel-central-registry",
		},
		{
			name:      "fork",
			input:     "https://github.com/some-fork/bazel-central-registry.git",
			wantOwner: "some-fork",
			wantRepo:  "bazel-central-registry",
		},
		{
			name:      "unrecognized URL falls back to default",
			input:     "https://gitlab.com/foo/bar",
			wantOwner: "bazelbuild",
			wantRepo:  "bazel-central-registry",
		},
		{
			name:      "empty string falls back to default",
			input:     "",
			wantOwner: "bazelbuild",
			wantRepo:  "bazel-central-registry",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotOwner, gotRepo := parseGitHubRepoURL(tt.input)
			if gotOwner != tt.wantOwner || gotRepo != tt.wantRepo {
				t.Errorf("parseGitHubRepoURL(%q) = (%q, %q), want (%q, %q)",
					tt.input, gotOwner, gotRepo, tt.wantOwner, tt.wantRepo)
			}
		})
	}
}

func TestMakeOverlayBzlRepository(t *testing.T) {
	const (
		moduleName    = "colordiff"
		moduleVersion = "1.0.22"
		commitSHA     = "abc123"
		repoURL       = "https://github.com/bazelbuild/bazel-central-registry.git"
	)
	lbl := makeBzlRepositoryLabel(moduleName, moduleVersion)
	r := makeOverlayBzlRepository(lbl, moduleName, moduleVersion, repoURL, commitSHA)

	if got, want := r.Kind(), starlarkRepositoryArchiveKind; got != want {
		t.Errorf("kind = %q, want %q", got, want)
	}
	if got, want := r.Name(), "bzl.colordiff---1.0.22"; got != want {
		t.Errorf("name = %q, want %q", got, want)
	}
	if got, want := r.AttrString("strip_prefix"), "bazel-central-registry-abc123/modules/colordiff/1.0.22/overlay"; got != want {
		t.Errorf("strip_prefix = %q, want %q", got, want)
	}
	if got, want := r.AttrStrings("urls"), []string{"https://github.com/bazelbuild/bazel-central-registry/archive/abc123.tar.gz"}; len(got) != 1 || got[0] != want[0] {
		t.Errorf("urls = %v, want %v", got, want)
	}
	if got, want := r.AttrString("type"), "tar.gz"; got != want {
		t.Errorf("type = %q, want %q", got, want)
	}
	if got, want := r.AttrString("build_file_generation"), "clean"; got != want {
		t.Errorf("build_file_generation = %q, want %q", got, want)
	}
	if got := r.AttrStrings("languages"); len(got) != 1 || got[0] != starlarkRepositoryLanguageName {
		t.Errorf("languages = %v, want [%q]", got, starlarkRepositoryLanguageName)
	}
	if got := r.AttrStrings("build_directives"); len(got) != 1 || got[0] != "gazelle:starlarkrepository_root" {
		t.Errorf("build_directives = %v, want [gazelle:starlarkrepository_root]", got)
	}
}

func TestMakeOverlayBzlRepository_ForkURL(t *testing.T) {
	lbl := makeBzlRepositoryLabel("foo", "1.0")
	r := makeOverlayBzlRepository(lbl, "foo", "1.0", "https://github.com/some-fork/bazel-central-registry.git", "deadbeef")

	gotURL := r.AttrStrings("urls")
	wantURL := "https://github.com/some-fork/bazel-central-registry/archive/deadbeef.tar.gz"
	if len(gotURL) != 1 || gotURL[0] != wantURL {
		t.Errorf("urls = %v, want [%q]", gotURL, wantURL)
	}
	wantStripPrefix := "bazel-central-registry-deadbeef/modules/foo/1.0/overlay"
	if got := r.AttrString("strip_prefix"); got != wantStripPrefix {
		t.Errorf("strip_prefix = %q, want %q", got, wantStripPrefix)
	}
}

func TestScanForOverlayBzlFiles(t *testing.T) {
	tests := []struct {
		name         string
		modulesRoot  string
		rel          string
		regularFiles []string
		wantIDs      []moduleID
	}{
		{
			name:         "direct .bzl in overlay",
			modulesRoot:  "modules",
			rel:          "modules/colordiff/1.0.22/overlay",
			regularFiles: []string{"BUILD.bazel", "MODULE.bazel", "colordiff.bzl"},
			wantIDs:      []moduleID{newModuleID("colordiff", "1.0.22")},
		},
		{
			name:         "nested .bzl deep in overlay",
			modulesRoot:  "modules",
			rel:          "modules/libxcrypt/4.4.36/overlay/test",
			regularFiles: []string{"cc_test.bzl"},
			wantIDs:      []moduleID{newModuleID("libxcrypt", "4.4.36")},
		},
		{
			name:         "no .bzl files in overlay subdir",
			modulesRoot:  "modules",
			rel:          "modules/foo/1.0/overlay/data",
			regularFiles: []string{"README.md"},
			wantIDs:      nil,
		},
		{
			name:         "module version dir is not overlay",
			modulesRoot:  "modules",
			rel:          "modules/colordiff/1.0.22",
			regularFiles: []string{"MODULE.bazel", "source.json"},
			wantIDs:      nil,
		},
		{
			name:         "outside modules root is ignored",
			modulesRoot:  "modules",
			rel:          "rules/some_rule.bzl",
			regularFiles: []string{"some_rule.bzl"},
			wantIDs:      nil,
		},
		{
			name:         "non-standard registry root prefix",
			modulesRoot:  "data/bazel-central-registry/modules",
			rel:          "data/bazel-central-registry/modules/flex/2.6.4.bcr.5/overlay",
			regularFiles: []string{"flex.bzl"},
			wantIDs:      []moduleID{newModuleID("flex", "2.6.4.bcr.5")},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ext := &bcrExtension{
				modulesRoot:    tt.modulesRoot,
				overlayBzlByID: make(map[moduleID]bool),
			}
			ext.scanForOverlayBzlFiles(language.GenerateArgs{
				Rel:          tt.rel,
				RegularFiles: tt.regularFiles,
			})
			if len(ext.overlayBzlByID) != len(tt.wantIDs) {
				t.Fatalf("overlayBzlByID size = %d, want %d (got %v)", len(ext.overlayBzlByID), len(tt.wantIDs), ext.overlayBzlByID)
			}
			for _, id := range tt.wantIDs {
				if !ext.overlayBzlByID[id] {
					t.Errorf("expected overlayBzlByID[%s] to be true", id)
				}
			}
		})
	}
}

// fakeStarlarkMetadataRule produces a module_metadata rule whose `repository`
// attribute references one entry; the matching repositoryID is registered in
// repositoriesMetadataByID with Languages={"Starlark": ...}.
func fakeStarlarkMetadataRule() (*protoRule[*bzpb.ModuleMetadata], map[repositoryID]*bzpb.RepositoryMetadata) {
	r := rule.NewRule(moduleMetadataKind, "metadata")
	r.SetAttr("repository", []string{"github:bazelbuild/has_starlark"})
	repoMeta := map[repositoryID]*bzpb.RepositoryMetadata{
		"github:bazelbuild/has_starlark": {
			Languages: map[string]int32{"Starlark": 1000},
		},
	}
	return newProtoRule(r, &bzpb.ModuleMetadata{}), repoMeta
}

// fakeNonStarlarkMetadataRule has a repository entry but with no Starlark in
// the language metadata (e.g. colordiff's www.colordiff.org repo, or any
// non-GitHub source).
func fakeNonStarlarkMetadataRule() (*protoRule[*bzpb.ModuleMetadata], map[repositoryID]*bzpb.RepositoryMetadata) {
	r := rule.NewRule(moduleMetadataKind, "metadata")
	r.SetAttr("repository", []string{"github:bazelbuild/no_starlark"})
	repoMeta := map[repositoryID]*bzpb.RepositoryMetadata{
		"github:bazelbuild/no_starlark": {
			Languages: map[string]int32{"C": 1000},
		},
	}
	return newProtoRule(r, &bzpb.ModuleMetadata{}), repoMeta
}

func TestAddOverlayBzlRepositories_OverlayOnlyModule(t *testing.T) {
	// Module with overlay .bzl, upstream metadata has no Starlark, no
	// pre-existing source-URL-based version → overlay rule is appended.
	metaRule, repoMeta := fakeNonStarlarkMetadataRule()

	ext := &bcrExtension{
		overlayBzlByID:           map[moduleID]bool{newModuleID("colordiff", "1.0.22"): true},
		moduleMetadataRules:      map[moduleName]*protoRule[*bzpb.ModuleMetadata]{"colordiff": metaRule},
		repositoriesMetadataByID: repoMeta,
		bcrCommitSHA:             "abc123",
		bcrRepositoryURL:         "https://github.com/bazelbuild/bazel-central-registry.git",
	}

	versions := make(rankedModuleVersionMap)
	ext.addOverlayBzlRepositories(versions)

	got := versions["colordiff"]
	if len(got) != 1 {
		t.Fatalf("want 1 ranked version, got %d", len(got))
	}
	if string(got[0].version) != "1.0.22" {
		t.Errorf("version = %q, want 1.0.22", got[0].version)
	}
	if got, want := got[0].bzlRepositoryRule.AttrString("strip_prefix"),
		"bazel-central-registry-abc123/modules/colordiff/1.0.22/overlay"; got != want {
		t.Errorf("strip_prefix = %q, want %q", got, want)
	}
}

func TestAddOverlayBzlRepositories_ReplacesSourceURLEntry(t *testing.T) {
	// A source-URL pass already added a rankedVersion for colordiff@1.0.22
	// pointing at the upstream tarball. The overlay pass should overwrite the
	// underlying rule (since the upstream tarball has no .bzl content).
	metaRule, repoMeta := fakeNonStarlarkMetadataRule()

	preexistingLbl := makeBzlRepositoryLabel("colordiff", "1.0.22")
	preexistingRule := rule.NewRule(starlarkRepositoryArchiveKind, preexistingLbl.Repo)
	preexistingRule.SetAttr("urls", []string{"https://www.colordiff.org/colordiff-1.0.22.tar.gz"})
	preexistingRule.SetAttr("strip_prefix", "colordiff-1.0.22")

	versions := rankedModuleVersionMap{
		"colordiff": {
			{
				version:            "1.0.22",
				bzlRepositoryRule:  preexistingRule,
				bzlRepositoryLabel: preexistingLbl,
			},
		},
	}

	ext := &bcrExtension{
		overlayBzlByID:           map[moduleID]bool{newModuleID("colordiff", "1.0.22"): true},
		moduleMetadataRules:      map[moduleName]*protoRule[*bzpb.ModuleMetadata]{"colordiff": metaRule},
		repositoriesMetadataByID: repoMeta,
		bcrCommitSHA:             "abc123",
		bcrRepositoryURL:         "https://github.com/bazelbuild/bazel-central-registry.git",
	}
	ext.addOverlayBzlRepositories(versions)

	if got := len(versions["colordiff"]); got != 1 {
		t.Fatalf("want 1 ranked version after replace, got %d", got)
	}
	v := versions["colordiff"][0]
	if got, want := v.bzlRepositoryRule.AttrString("strip_prefix"),
		"bazel-central-registry-abc123/modules/colordiff/1.0.22/overlay"; got != want {
		t.Errorf("strip_prefix = %q (rule was not replaced), want %q", got, want)
	}
	gotURLs := v.bzlRepositoryRule.AttrStrings("urls")
	wantURL := "https://github.com/bazelbuild/bazel-central-registry/archive/abc123.tar.gz"
	if len(gotURLs) != 1 || gotURLs[0] != wantURL {
		t.Errorf("urls = %v, want [%q]", gotURLs, wantURL)
	}
}

func TestAddOverlayBzlRepositories_SkipsWhenUpstreamHasStarlark(t *testing.T) {
	// Module with overlay .bzl but upstream advertises Starlark — overlay is
	// fallback only, so the existing source-URL entry must not be touched.
	metaRule, repoMeta := fakeStarlarkMetadataRule()

	preexistingLbl := makeBzlRepositoryLabel("rules_foo", "1.0")
	preexistingRule := rule.NewRule(starlarkRepositoryArchiveKind, preexistingLbl.Repo)
	preexistingRule.SetAttr("urls", []string{"https://github.com/bazelbuild/rules_foo/archive/v1.0.tar.gz"})
	preexistingRule.SetAttr("strip_prefix", "rules_foo-1.0")

	versions := rankedModuleVersionMap{
		"rules_foo": {
			{
				version:            "1.0",
				bzlRepositoryRule:  preexistingRule,
				bzlRepositoryLabel: preexistingLbl,
			},
		},
	}

	ext := &bcrExtension{
		overlayBzlByID:           map[moduleID]bool{newModuleID("rules_foo", "1.0"): true},
		moduleMetadataRules:      map[moduleName]*protoRule[*bzpb.ModuleMetadata]{"rules_foo": metaRule},
		repositoriesMetadataByID: repoMeta,
		bcrCommitSHA:             "abc123",
		bcrRepositoryURL:         "https://github.com/bazelbuild/bazel-central-registry.git",
	}
	ext.addOverlayBzlRepositories(versions)

	v := versions["rules_foo"][0]
	if got, want := v.bzlRepositoryRule.AttrString("strip_prefix"), "rules_foo-1.0"; got != want {
		t.Errorf("strip_prefix mutated to %q (overlay should be skipped), want %q", got, want)
	}
}

func TestAddOverlayBzlRepositories_NoSHASkips(t *testing.T) {
	// Defensive: when BCR commit SHA hasn't been resolved yet (e.g. running
	// outside the registry root), the overlay pass must not produce
	// half-initialized rules.
	metaRule, repoMeta := fakeNonStarlarkMetadataRule()
	ext := &bcrExtension{
		overlayBzlByID:           map[moduleID]bool{newModuleID("colordiff", "1.0.22"): true},
		moduleMetadataRules:      map[moduleName]*protoRule[*bzpb.ModuleMetadata]{"colordiff": metaRule},
		repositoriesMetadataByID: repoMeta,
		// bcrCommitSHA intentionally empty
	}
	versions := make(rankedModuleVersionMap)
	ext.addOverlayBzlRepositories(versions)
	if len(versions) != 0 {
		t.Errorf("want empty versions when SHA missing, got %v", versions)
	}
}
