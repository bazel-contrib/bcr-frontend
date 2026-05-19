package bcr

import (
	"strings"
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

const testSRI = "sha256-3vSwj/15LRiq+aTpFrcuQYxxOoFlDfNk9eRzaT7gWoQ="

// newTestExtension creates a fresh bcrExtension wired up enough for
// attestation-flow unit tests without touching the network or files.
func newTestExtension() *bcrExtension {
	return &bcrExtension{
		fetchAttestations:   true,
		attestationFetches:  make(map[string]*attestationFetch),
		resourceStatusByUrl: make(map[string]*bzpb.ResourceStatus),
		blacklistedUrls:     stringBoolMap{},
	}
}

func TestMakeAttestationRepoName_StableAndSanitized(t *testing.T) {
	url := "https://github.com/foo/bar/releases/download/v1.2.3/source.json.intoto.jsonl"
	got := makeAttestationRepoName(url)
	want := "github.com_foo_bar_releases_download_v1.2.3_source.json.attestation"
	if got != want {
		t.Errorf("makeAttestationRepoName(%q) =\n  %q;\nwant %q", url, got, want)
	}
	// Must not contain chars Bazel forbids in repo names (path separators).
	if strings.ContainsAny(got, "/+") {
		t.Errorf("repo name %q still contains a path separator or plus", got)
	}
	// Same input must yield the same output across calls.
	if again := makeAttestationRepoName(url); again != got {
		t.Errorf("repo name not stable: first=%q second=%q", got, again)
	}
	// Different URL must yield a different name.
	other := makeAttestationRepoName("https://github.com/foo/bar/releases/download/v1.2.3/MODULE.bazel.intoto.jsonl")
	if other == got {
		t.Errorf("expected distinct repo names for distinct URLs, both got %q", got)
	}
}

func TestTrackAttestationFetch_DedupAndFiltering(t *testing.T) {
	ext := newTestExtension()

	url := "https://github.com/foo/bar/releases/download/v1/source.json.intoto.jsonl"

	lbl := ext.trackAttestationFetch(url, testSRI, "source.json")
	if lbl.Repo == "" {
		t.Fatal("expected non-empty label for valid input")
	}
	if got := len(ext.attestationFetches); got != 1 {
		t.Errorf("attestationFetches size = %d; want 1", got)
	}

	// Same URL+filename again should dedup, not double-insert.
	_ = ext.trackAttestationFetch(url, testSRI, "source.json")
	if got := len(ext.attestationFetches); got != 1 {
		t.Errorf("attestationFetches size after dedup = %d; want 1", got)
	}

	// Different URL adds a second entry.
	url2 := "https://github.com/foo/bar/releases/download/v1/MODULE.bazel.intoto.jsonl"
	_ = ext.trackAttestationFetch(url2, testSRI, "MODULE.bazel")
	if got := len(ext.attestationFetches); got != 2 {
		t.Errorf("attestationFetches size = %d; want 2", got)
	}

	// fetchAttestations disabled → empty label, no insert.
	ext2 := newTestExtension()
	ext2.fetchAttestations = false
	if lbl := ext2.trackAttestationFetch(url, testSRI, "source.json"); lbl.Repo != "" {
		t.Errorf("expected empty label when fetch disabled, got %v", lbl)
	}
	if got := len(ext2.attestationFetches); got != 0 {
		t.Errorf("attestationFetches size when fetch disabled = %d; want 0", got)
	}

	// Bad integrity → empty label.
	ext3 := newTestExtension()
	if lbl := ext3.trackAttestationFetch(url, "not-sri", "source.json"); lbl.Repo != "" {
		t.Errorf("expected empty label for malformed integrity, got %v", lbl)
	}
}

// TestPrepareAttestationRepositories_AllLive primes the resource-status cache
// with 200s for every URL so the URL-check pass is fully cache-served (no
// network) and exercises only the "happy path" repo emission.
func TestPrepareAttestationRepositories_AllLive(t *testing.T) {
	ext := newTestExtension()
	urls := []string{
		"https://example.com/c.intoto.jsonl",
		"https://example.com/a.intoto.jsonl",
		"https://example.com/b.intoto.jsonl",
	}
	for _, u := range urls {
		ext.trackAttestationFetch(u, testSRI, "x.json")
		ext.resourceStatusByUrl[u] = &bzpb.ResourceStatus{Url: u, Code: 200, Message: "OK"}
	}
	rules := ext.prepareAttestationRepositories()
	if len(rules) != 3 {
		t.Fatalf("got %d rules; want 3", len(rules))
	}
	for _, r := range rules {
		if r.Kind() != httpFileKind {
			t.Errorf("rule kind = %q; want %q", r.Kind(), httpFileKind)
		}
	}
}

// TestPrepareAttestationRepositories_DeadURL_DropsLabelAndMarksUnavailable
// primes the resource-status cache with a 404 for one URL and verifies that:
//   - no http_file rule is emitted for it,
//   - its label is removed from each referencing module_attestations rule's
//     attestations_intoto, and
//   - the entry's filename is appended to that rule's unavailable_entries.
func TestPrepareAttestationRepositories_DeadURL_DropsLabelAndMarksUnavailable(t *testing.T) {
	ext := newTestExtension()

	liveURL := "https://example.com/live/source.json.intoto.jsonl"
	deadURL := "https://example.com/dead/MODULE.bazel.intoto.jsonl"

	liveLabel := ext.trackAttestationFetch(liveURL, testSRI, "source.json").String()
	deadLabel := ext.trackAttestationFetch(deadURL, testSRI, "MODULE.bazel").String()

	// Build a fake module_attestations rule that references both URLs, then
	// register it so the dead-URL pass can find it.
	r := rule.NewRule(moduleAttestationsKind, "attestations")
	r.SetAttr("attestations_intoto", []string{liveLabel, deadLabel})
	ext.registerAttestationRule(r, map[string]string{
		"source.json":  liveURL,
		"MODULE.bazel": deadURL,
	})

	// Prime cache: live URL 200, dead URL 404.
	ext.resourceStatusByUrl[liveURL] = &bzpb.ResourceStatus{Url: liveURL, Code: 200, Message: "OK"}
	ext.resourceStatusByUrl[deadURL] = &bzpb.ResourceStatus{Url: deadURL, Code: 404, Message: "Not Found"}

	rules := ext.prepareAttestationRepositories()

	// Only the live URL produces an http_file rule.
	if len(rules) != 1 {
		t.Fatalf("emitted http_file rules = %d; want 1", len(rules))
	}

	// The rule's attestations_intoto must no longer contain the dead label.
	gotIntoto := r.AttrStrings("attestations_intoto")
	if len(gotIntoto) != 1 || gotIntoto[0] != liveLabel {
		t.Errorf("attestations_intoto after dead-URL filter = %v; want [%q]", gotIntoto, liveLabel)
	}

	// The dead entry's filename must be in unavailable_entries.
	gotUnavailable := r.AttrStrings("unavailable_entries")
	if len(gotUnavailable) != 1 || gotUnavailable[0] != "MODULE.bazel" {
		t.Errorf("unavailable_entries = %v; want [MODULE.bazel]", gotUnavailable)
	}
}

// TestPrepareAttestationRepositories_Blacklist verifies that an explicitly
// blacklisted URL is treated identically to a 404: dropped from emissions,
// label removed, filename moved to unavailable_entries — without ever consulting
// the URL-status cache or the network.
func TestPrepareAttestationRepositories_Blacklist(t *testing.T) {
	ext := newTestExtension()
	url := "https://example.com/blacklisted/source.json.intoto.jsonl"
	lbl := ext.trackAttestationFetch(url, testSRI, "source.json").String()
	ext.blacklistedUrls = stringBoolMap{url: true}

	r := rule.NewRule(moduleAttestationsKind, "attestations")
	r.SetAttr("attestations_intoto", []string{lbl})
	ext.registerAttestationRule(r, map[string]string{"source.json": url})

	rules := ext.prepareAttestationRepositories()
	if len(rules) != 0 {
		t.Fatalf("emitted http_file rules = %d; want 0 (URL blacklisted)", len(rules))
	}
	if got := r.AttrStrings("attestations_intoto"); len(got) != 0 {
		t.Errorf("attestations_intoto = %v; want empty after blacklist", got)
	}
	if got := r.AttrStrings("unavailable_entries"); len(got) != 1 || got[0] != "source.json" {
		t.Errorf("unavailable_entries = %v; want [source.json]", got)
	}
}
