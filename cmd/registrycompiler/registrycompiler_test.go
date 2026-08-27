package main

import (
	"os"
	"path/filepath"
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
	"google.golang.org/protobuf/proto"
)

func mv(name, version string, latest bool) *bzpb.ModuleVersion {
	return &bzpb.ModuleVersion{
		Name:                 name,
		Version:              version,
		IsLatestVersion:      latest,
		CompatibilityLevel:   1,
		BazelCompatibility:   []string{">=7.0.0"},
		RepoName:             name,
		Deps:                 []*bzpb.ModuleDependency{{Name: "rules_cc", Version: "0.0.9"}},
		Override:             []*bzpb.ModuleDependencyOverride{{ModuleName: "rules_cc"}},
		ToolchainsToRegister: []string{"//toolchain:all"},
		Source:               &bzpb.ModuleSource{Url: "https://example.com/a.tar.gz", Integrity: "sha256-abc"},
		Attestations:         &bzpb.Attestations{MediaType: "application/vnd.dev.sigstore.bundle+json"},
		Presubmit:            &bzpb.Presubmit{},
		Commit: &bzpb.ModuleCommit{
			Sha1:        "deadbeefdeadbeef",
			Date:        "2026-01-02T03:04:05Z",
			Message:     "a very long commit message that dominates the payload",
			PullRequest: "1234",
			GithubUser:  "octocat",
			GithubName:  "The Octocat",
		},
	}
}

func TestThinRegistryKeepsLatestVersionsIntact(t *testing.T) {
	reg := &bzpb.Registry{Modules: []*bzpb.Module{{
		Name:     "foo",
		Versions: []*bzpb.ModuleVersion{mv("foo", "2.0.0", true), mv("foo", "1.0.0", false)},
	}}}

	if err := thinRegistry(reg, ""); err != nil {
		t.Fatalf("thinRegistry: %v", err)
	}

	latest := reg.Modules[0].Versions[0]
	if latest.Source == nil || latest.Attestations == nil || latest.Presubmit == nil {
		t.Error("latest version lost detail fields; it must be served from the boot payload")
	}
	if latest.Commit.Message == "" || latest.Commit.Sha1 == "" {
		t.Error("latest version lost commit sha1/message")
	}
	if len(latest.ToolchainsToRegister) == 0 {
		t.Error("latest version lost toolchains_to_register")
	}
}

func TestThinRegistryStripsDetailFromHistoricalVersions(t *testing.T) {
	reg := &bzpb.Registry{Modules: []*bzpb.Module{{
		Name:     "foo",
		Versions: []*bzpb.ModuleVersion{mv("foo", "2.0.0", true), mv("foo", "1.0.0", false)},
	}}}

	if err := thinRegistry(reg, ""); err != nil {
		t.Fatalf("thinRegistry: %v", err)
	}

	old := reg.Modules[0].Versions[1]
	if old.Source != nil {
		t.Error("source should be stripped; it is only rendered on a detail page")
	}
	if old.Attestations != nil {
		t.Error("attestations should be stripped")
	}
	if old.Presubmit != nil {
		t.Error("presubmit should be stripped")
	}
	if old.ToolchainsToRegister != nil {
		t.Error("toolchains_to_register should be stripped")
	}

	// The dependency graph must survive: buildReverseDependencyIndex and MVS
	// both walk the entire version history.
	if len(old.Deps) != 1 {
		t.Errorf("deps must be retained on historical versions, got %d", len(old.Deps))
	}
	if len(old.Override) != 1 {
		t.Errorf("override must be retained on historical versions, got %d", len(old.Override))
	}

	// The home "recently added" feed reads the oldest version's commit, and
	// the maintainers page filters by commit.github_user.
	if old.Commit == nil {
		t.Fatal("commit must be retained on historical versions")
	}
	if old.Commit.Date == "" || old.Commit.PullRequest == "" || old.Commit.GithubUser == "" || old.Commit.GithubName == "" {
		t.Error("commit lost a field the home/maintainers feeds depend on")
	}
	if old.Commit.Message != "" {
		t.Error("commit message should be dropped from historical versions")
	}
	if old.Commit.Sha1 != "" {
		t.Error("commit sha1 should be dropped from historical versions")
	}
}

func TestThinRegistryWritesFullRecordPerHistoricalVersion(t *testing.T) {
	dir := t.TempDir()
	reg := &bzpb.Registry{Modules: []*bzpb.Module{{
		Name:     "foo",
		Versions: []*bzpb.ModuleVersion{mv("foo", "2.0.0", true), mv("foo", "1.0.0", false)},
	}}}

	if err := thinRegistry(reg, dir); err != nil {
		t.Fatalf("thinRegistry: %v", err)
	}

	// Only non-latest versions need a sidecar; latest ships in the payload.
	if _, err := os.Stat(filepath.Join(dir, "foo", "2.0.0", "moduleversion.pb.gz")); !os.IsNotExist(err) {
		t.Error("latest version should not get a sidecar record")
	}

	path := filepath.Join(dir, "foo", "1.0.0", "moduleversion.pb.gz")
	var got bzpb.ModuleVersion
	if err := protoutil.ReadFile(path, &got); err != nil {
		t.Fatalf("reading sidecar: %v", err)
	}
	if got.Source == nil || got.Source.Url == "" {
		t.Error("sidecar must carry the source that was stripped from the payload")
	}
	if got.Attestations == nil || got.Presubmit == nil {
		t.Error("sidecar must carry attestations and presubmit")
	}
	if got.Commit.Message == "" || got.Commit.Sha1 == "" {
		t.Error("sidecar must carry the full commit, including message and sha1")
	}
}

// TestThinRegistryAgainstRealRegistry reports the actual payload reduction.
// Skipped unless BCR_REGISTRY_PB points at a real registry.pb, e.g.
//
//	BCR_REGISTRY_PB=/path/to/registry.pb go test ./cmd/registrycompiler/ -run Real -v
func TestThinRegistryAgainstRealRegistry(t *testing.T) {
	path := os.Getenv("BCR_REGISTRY_PB")
	if path == "" {
		t.Skip("set BCR_REGISTRY_PB to measure against real registry data")
	}

	var reg bzpb.Registry
	if err := protoutil.ReadFile(path, &reg); err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}

	before, err := proto.Marshal(&reg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var nLatest, nHistorical int
	for _, m := range reg.Modules {
		for _, v := range m.Versions {
			if v.IsLatestVersion {
				nLatest++
			} else {
				nHistorical++
			}
		}
	}

	if err := thinRegistry(&reg, t.TempDir()); err != nil {
		t.Fatalf("thinRegistry: %v", err)
	}
	after, err := proto.Marshal(&reg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	t.Logf("modules=%d latest=%d historical=%d", len(reg.Modules), nLatest, nHistorical)
	t.Logf("wire: %.2f MB -> %.2f MB (%.1f%% smaller)",
		float64(len(before))/1e6, float64(len(after))/1e6,
		(1-float64(len(after))/float64(len(before)))*100)

	if len(after) >= len(before) {
		t.Errorf("thinning did not shrink the payload: %d -> %d", len(before), len(after))
	}
}
