package intoto

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
)

const fixtureReBzl = "testdata/re-bzl-0.2.0-source.intoto.jsonl"

// wantReBzl mirrors the expected extraction from
// testdata/re-bzl-0.2.0-source.intoto.jsonl. The fixture is a real Sigstore
// bundle from re.bzl 0.2.0 source.json attestation; if it's ever re-fetched and
// the upstream regenerates with different content, this expectation must move
// with it.
func wantReBzl() *bzpb.Attestations_AttestationPayload {
	return &bzpb.Attestations_AttestationPayload{
		SubjectName:         "source.json",
		SubjectSha256:       "3bef86adc17eda01a0f07bc7adb09e9ad50f96927eeebf42b885671eb9cc5b3d",
		SignerIdentity:      "https://github.com/bazel-contrib/publish-to-bcr/.github/workflows/publish.yaml@refs/tags/v1.0.0",
		SignerIssuer:        "https://token.actions.githubusercontent.com",
		SourceRepoUrl:       "https://github.com/jvolkman/re.bzl",
		SourceCommitSha:     "7d05b882f69d7b07b53256653fdf1ddb4fe2a79b",
		SourceRef:           "refs/tags/v0.2.0",
		BuilderId:           "https://github.com/bazel-contrib/publish-to-bcr/.github/workflows/publish.yaml@refs/tags/v1.0.0",
		BuildType:           "https://actions.github.io/buildtypes/workflow/v1",
		WorkflowPath:        ".github/workflows/release.yaml",
		InvocationUrl:       "https://github.com/jvolkman/re.bzl/actions/runs/20580868871/attempts/1",
		PredicateType:       "https://slsa.dev/provenance/v1",
		RekorLogIndex:       781457678,
		RekorLogUrl:         "https://search.sigstore.dev/?logIndex=781457678",
		RekorIntegratedTime: 1767036092,
	}
}

func TestParse_ReBzlGolden(t *testing.T) {
	data, err := os.ReadFile(fixtureReBzl)
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}
	got := Parse(data)
	checkPayload(t, got, wantReBzl())
}

func TestParse_EmptyInput(t *testing.T) {
	got := Parse(nil)
	if got == nil {
		t.Fatal("Parse(nil) returned nil; expected non-nil with ParseError set")
	}
	if got.ParseError == "" {
		t.Errorf("ParseError = empty; want non-empty for nil input")
	}
}

func TestParse_BadJSON(t *testing.T) {
	got := Parse([]byte("not json at all"))
	if got.ParseError == "" {
		t.Errorf("ParseError = empty; want non-empty for malformed input")
	}
}

func TestParse_UnsupportedPredicateType(t *testing.T) {
	bundle := buildBundleWithStatement(t, statement{
		Type:          "https://in-toto.io/Statement/v1",
		Subject:       []statementSub{{Name: "file", Digest: map[string]string{"sha256": "abc"}}},
		PredicateType: "https://example.com/something-weird/v1",
		Predicate:     json.RawMessage(`{}`),
	})
	got := Parse(bundle)
	if got.ParseError == "" {
		t.Errorf("ParseError = empty; want non-empty for unsupported predicateType")
	}
	if got.SubjectName != "file" || got.SubjectSha256 != "abc" {
		t.Errorf("subject not best-effort populated: name=%q sha256=%q", got.SubjectName, got.SubjectSha256)
	}
	if got.PredicateType != "https://example.com/something-weird/v1" {
		t.Errorf("PredicateType = %q; want preserved verbatim", got.PredicateType)
	}
}

func TestParse_SLSAv02Predicate(t *testing.T) {
	bundle := buildBundleWithStatement(t, statement{
		Type:          "https://in-toto.io/Statement/v0.1",
		Subject:       []statementSub{{Name: "tar.gz", Digest: map[string]string{"sha256": "deadbeef"}}},
		PredicateType: predicateTypeSLSAV02,
		Predicate: mustMarshalJSON(t, slsaV02Predicate{
			Builder:   slsaV1Builder{ID: "https://example.com/builder@v1"},
			BuildType: "https://example.com/buildtype/v1",
			Invocation: slsaV02Invocation{
				ConfigSource: slsaV02ConfigSource{
					URI:    "git+https://github.com/foo/bar@refs/tags/v1",
					Digest: map[string]string{"sha1": "abc123"},
				},
			},
			Metadata: slsaV02Metadata{BuildInvocationID: "https://example.com/runs/42"},
		}),
	})
	got := Parse(bundle)
	if got.ParseError != "" {
		t.Errorf("unexpected ParseError: %q", got.ParseError)
	}
	if got.BuilderId != "https://example.com/builder@v1" {
		t.Errorf("BuilderId = %q", got.BuilderId)
	}
	if got.BuildType != "https://example.com/buildtype/v1" {
		t.Errorf("BuildType = %q", got.BuildType)
	}
	if got.SourceRepoUrl != "git+https://github.com/foo/bar@refs/tags/v1" {
		t.Errorf("SourceRepoUrl = %q", got.SourceRepoUrl)
	}
	if got.SourceCommitSha != "abc123" {
		t.Errorf("SourceCommitSha = %q", got.SourceCommitSha)
	}
	if got.InvocationUrl != "https://example.com/runs/42" {
		t.Errorf("InvocationUrl = %q", got.InvocationUrl)
	}
}

// buildBundleWithStatement constructs a minimal Sigstore-bundle JSON wrapping the
// given statement. The certificate is omitted (so signer fields stay empty),
// which exercises the parser's tolerance for absent verificationMaterial.
func buildBundleWithStatement(t *testing.T, stmt statement) []byte {
	t.Helper()
	stmtBytes, err := json.Marshal(stmt)
	if err != nil {
		t.Fatalf("marshalling statement: %v", err)
	}
	bundle := sigstoreBundle{
		MediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
		DSSEEnvelope: dsseEnvelope{
			Payload:     base64.StdEncoding.EncodeToString(stmtBytes),
			PayloadType: "application/vnd.in-toto+json",
		},
	}
	b, err := json.Marshal(&bundle)
	if err != nil {
		t.Fatalf("marshalling bundle: %v", err)
	}
	return b
}

func mustMarshalJSON(t *testing.T, v interface{}) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// checkPayload reports per-field differences so a failing golden test points
// at the exact field that drifted, not just a diff of two opaque proto blobs.
func checkPayload(t *testing.T, got, want *bzpb.Attestations_AttestationPayload) {
	t.Helper()
	if got == nil {
		t.Fatal("got nil payload")
	}
	if got.ParseError != "" {
		t.Errorf("ParseError = %q; want empty for valid input", got.ParseError)
	}
	cmpStr(t, "SubjectName", got.SubjectName, want.SubjectName)
	cmpStr(t, "SubjectSha256", got.SubjectSha256, want.SubjectSha256)
	cmpStr(t, "SignerIdentity", got.SignerIdentity, want.SignerIdentity)
	cmpStr(t, "SignerIssuer", got.SignerIssuer, want.SignerIssuer)
	cmpStr(t, "SourceRepoUrl", got.SourceRepoUrl, want.SourceRepoUrl)
	cmpStr(t, "SourceCommitSha", got.SourceCommitSha, want.SourceCommitSha)
	cmpStr(t, "SourceRef", got.SourceRef, want.SourceRef)
	cmpStr(t, "BuilderId", got.BuilderId, want.BuilderId)
	cmpStr(t, "BuildType", got.BuildType, want.BuildType)
	cmpStr(t, "WorkflowPath", got.WorkflowPath, want.WorkflowPath)
	cmpStr(t, "InvocationUrl", got.InvocationUrl, want.InvocationUrl)
	cmpStr(t, "PredicateType", got.PredicateType, want.PredicateType)
	cmpStr(t, "RekorLogUrl", got.RekorLogUrl, want.RekorLogUrl)
	if got.RekorLogIndex != want.RekorLogIndex {
		t.Errorf("RekorLogIndex = %d; want %d", got.RekorLogIndex, want.RekorLogIndex)
	}
	if got.RekorIntegratedTime != want.RekorIntegratedTime {
		t.Errorf("RekorIntegratedTime = %d; want %d", got.RekorIntegratedTime, want.RekorIntegratedTime)
	}
}

func cmpStr(t *testing.T, field, got, want string) {
	t.Helper()
	if got != want {
		t.Errorf("%s = %q;\n           want %q", field, got, want)
	}
}

// Confirm fixture is committed at the expected path so the test failure mode is
// "wrong answer" rather than "missing file."
func TestFixturePresent(t *testing.T) {
	if _, err := os.Stat(filepath.FromSlash(fixtureReBzl)); err != nil {
		t.Fatalf("fixture not found: %v", err)
	}
}

func TestSetSubjectMatches(t *testing.T) {
	// 32 bytes of 0xab in hex / base64.
	hexAB := "abababababababababababababababababababababababababababababababab"
	sriAB := "sha256-q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s="

	cases := []struct {
		name      string
		hexSha256 string
		integrity string
		want      bool
	}{
		{"match", hexAB, sriAB, true},
		{"mismatch", hexAB, "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", false},
		{"empty integrity", hexAB, "", false},
		{"non-sha256 prefix", hexAB, "sha512-q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s=", false},
		{"bad base64", hexAB, "sha256-not!base64!", false},
		{"empty subject sha", "", sriAB, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := &bzpb.Attestations_AttestationPayload{SubjectSha256: c.hexSha256}
			SetSubjectMatches(p, c.integrity)
			if p.SubjectMatches != c.want {
				t.Errorf("SubjectMatches = %v; want %v", p.SubjectMatches, c.want)
			}
		})
	}
}
