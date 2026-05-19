package intoto

import (
	"bytes"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
)

const (
	predicateTypeSLSAV1  = "https://slsa.dev/provenance/v1"
	predicateTypeSLSAV02 = "https://slsa.dev/provenance/v0.2"

	// buildTypeGitHubActionsV1 is the SLSA buildType emitted by the GitHub
	// Actions workflow builder. When this is set, buildDefinition.externalParameters
	// carries a "workflow" object with {ref, repository, path}.
	buildTypeGitHubActionsV1 = "https://actions.github.io/buildtypes/workflow/v1"

	// rekorSearchURL is the public Rekor search UI; we synthesize a link to a
	// specific log entry by appending ?logIndex=<idx>.
	rekorSearchURL = "https://search.sigstore.dev/?logIndex="
)

// Parse decodes a .intoto.jsonl byte slice (a Sigstore bundle wrapping a DSSE
// envelope around an in-toto Statement) and returns a UI-shaped
// AttestationPayload.
//
// Parse never returns nil and never returns an error: any parsing problem is
// reported via the returned payload's ParseError field, and best-effort
// extraction continues for the remaining fields. The input is expected to be
// JSON-Lines but in practice always contains exactly one line (one bundle).
func Parse(data []byte) *bzpb.Attestations_AttestationPayload {
	payload := &bzpb.Attestations_AttestationPayload{}

	line := firstNonEmptyLine(data)
	if len(line) == 0 {
		payload.ParseError = "empty .intoto.jsonl input"
		return payload
	}

	var bundle sigstoreBundle
	if err := json.Unmarshal(line, &bundle); err != nil {
		payload.ParseError = fmt.Sprintf("decoding bundle: %v", err)
		return payload
	}

	parseDSSEStatement(bundle.DSSEEnvelope.Payload, payload)
	parseCertificate(bundle.VerificationMaterial.Certificate.RawBytes, payload)
	parseRekorEntry(bundle.VerificationMaterial.TLogEntries, payload)

	return payload
}

func firstNonEmptyLine(data []byte) []byte {
	for _, line := range bytes.Split(data, []byte("\n")) {
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			return trimmed
		}
	}
	return nil
}

func parseDSSEStatement(payloadB64 string, out *bzpb.Attestations_AttestationPayload) {
	if payloadB64 == "" {
		out.ParseError = appendErr(out.ParseError, "empty dsseEnvelope.payload")
		return
	}
	stmtBytes, err := base64.StdEncoding.DecodeString(payloadB64)
	if err != nil {
		out.ParseError = appendErr(out.ParseError, fmt.Sprintf("decoding dsse payload: %v", err))
		return
	}
	var stmt statement
	if err := json.Unmarshal(stmtBytes, &stmt); err != nil {
		out.ParseError = appendErr(out.ParseError, fmt.Sprintf("decoding statement: %v", err))
		return
	}

	if len(stmt.Subject) > 0 {
		out.SubjectName = stmt.Subject[0].Name
		out.SubjectSha256 = stmt.Subject[0].Digest["sha256"]
	}
	out.PredicateType = stmt.PredicateType

	switch stmt.PredicateType {
	case predicateTypeSLSAV1:
		fillFromSLSAV1(stmt.Predicate, out)
	case predicateTypeSLSAV02:
		fillFromSLSAV02(stmt.Predicate, out)
	default:
		out.ParseError = appendErr(out.ParseError, fmt.Sprintf("unsupported predicateType: %q", stmt.PredicateType))
	}
}

func fillFromSLSAV1(predicate json.RawMessage, out *bzpb.Attestations_AttestationPayload) {
	var p slsaV1Predicate
	if err := json.Unmarshal(predicate, &p); err != nil {
		out.ParseError = appendErr(out.ParseError, fmt.Sprintf("decoding slsa v1 predicate: %v", err))
		return
	}
	out.BuildType = p.BuildDefinition.BuildType
	out.BuilderId = p.RunDetails.Builder.ID
	out.InvocationUrl = p.RunDetails.Metadata.InvocationID

	if p.BuildDefinition.BuildType == buildTypeGitHubActionsV1 {
		if raw, ok := p.BuildDefinition.ExternalParameters["workflow"]; ok {
			var w slsaV1Workflow
			if err := json.Unmarshal(raw, &w); err == nil {
				out.SourceRepoUrl = w.Repository
				out.SourceRef = w.Ref
				out.WorkflowPath = w.Path
			}
		}
	}

	for _, dep := range p.BuildDefinition.ResolvedDependencies {
		if sha := dep.Digest["gitCommit"]; sha != "" {
			out.SourceCommitSha = sha
			break
		}
	}
}

func fillFromSLSAV02(predicate json.RawMessage, out *bzpb.Attestations_AttestationPayload) {
	var p slsaV02Predicate
	if err := json.Unmarshal(predicate, &p); err != nil {
		out.ParseError = appendErr(out.ParseError, fmt.Sprintf("decoding slsa v0.2 predicate: %v", err))
		return
	}
	out.BuildType = p.BuildType
	out.BuilderId = p.Builder.ID
	out.InvocationUrl = p.Metadata.BuildInvocationID
	out.SourceRepoUrl = p.Invocation.ConfigSource.URI
	if sha := p.Invocation.ConfigSource.Digest["sha1"]; sha != "" {
		out.SourceCommitSha = sha
	}
	for _, m := range p.Materials {
		if sha := m.Digest["gitCommit"]; sha != "" && out.SourceCommitSha == "" {
			out.SourceCommitSha = sha
		}
	}
}

func parseCertificate(rawB64 string, out *bzpb.Attestations_AttestationPayload) {
	if rawB64 == "" {
		return
	}
	der, err := base64.StdEncoding.DecodeString(rawB64)
	if err != nil {
		out.ParseError = appendErr(out.ParseError, fmt.Sprintf("decoding certificate: %v", err))
		return
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		out.ParseError = appendErr(out.ParseError, fmt.Sprintf("parsing certificate: %v", err))
		return
	}
	out.SignerIdentity, out.SignerIssuer = signerFromCert(cert)
}

func parseRekorEntry(entries []sigstoreTLogEntry, out *bzpb.Attestations_AttestationPayload) {
	if len(entries) == 0 {
		return
	}
	entry := entries[0]
	if idx, err := strconv.ParseInt(entry.LogIndex, 10, 64); err == nil {
		out.RekorLogIndex = idx
		out.RekorLogUrl = rekorSearchURL + entry.LogIndex
	}
	if ts, err := strconv.ParseInt(entry.IntegratedTime, 10, 64); err == nil {
		out.RekorIntegratedTime = ts
	}
}

func appendErr(existing, msg string) string {
	if existing == "" {
		return msg
	}
	return existing + "; " + msg
}
