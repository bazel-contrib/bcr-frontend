// Package intoto parses Sigstore bundles that wrap in-toto Statements (DSSE
// envelope + SLSA provenance predicate) into a UI-shaped AttestationPayload
// proto. Parsing is structural only: no signature, certificate-chain, or
// transparency-log verification is performed.
package intoto

import "encoding/json"

// sigstoreBundle mirrors the JSON shape of a Sigstore bundle v0.3 .intoto.jsonl
// (mediaType "application/vnd.dev.sigstore.bundle.v0.3+json"). Only the fields
// the parser reads are included; unknown fields are ignored by encoding/json.
type sigstoreBundle struct {
	MediaType            string                       `json:"mediaType"`
	VerificationMaterial sigstoreVerificationMaterial `json:"verificationMaterial"`
	DSSEEnvelope         dsseEnvelope                 `json:"dsseEnvelope"`
}

type sigstoreVerificationMaterial struct {
	Certificate sigstoreCertificate `json:"certificate"`
	TLogEntries []sigstoreTLogEntry `json:"tlogEntries"`
}

type sigstoreCertificate struct {
	// Base64-encoded DER X.509 leaf certificate.
	RawBytes string `json:"rawBytes"`
}

type sigstoreTLogEntry struct {
	// Quoted decimal int64 (JSON numbers serialized as strings).
	LogIndex string `json:"logIndex"`
	// Quoted Unix-seconds int64.
	IntegratedTime string `json:"integratedTime"`
}

// dsseEnvelope is the DSSE envelope embedded in a Sigstore bundle (see
// https://github.com/secure-systems-lab/dsse).
type dsseEnvelope struct {
	// Base64-encoded in-toto Statement JSON.
	Payload     string `json:"payload"`
	PayloadType string `json:"payloadType"`
}

// statement is an in-toto Statement (v1 _type "https://in-toto.io/Statement/v1"
// or v0.1 "https://in-toto.io/Statement/v0.1"). The predicate is deferred to a
// raw message and parsed based on predicateType.
type statement struct {
	Type          string          `json:"_type"`
	Subject       []statementSub  `json:"subject"`
	PredicateType string          `json:"predicateType"`
	Predicate     json.RawMessage `json:"predicate"`
}

type statementSub struct {
	Name   string            `json:"name"`
	Digest map[string]string `json:"digest"`
}

// slsaV1Predicate is the SLSA Provenance v1 predicate shape
// (predicateType "https://slsa.dev/provenance/v1").
type slsaV1Predicate struct {
	BuildDefinition slsaV1BuildDefinition `json:"buildDefinition"`
	RunDetails      slsaV1RunDetails      `json:"runDetails"`
}

type slsaV1BuildDefinition struct {
	BuildType            string                     `json:"buildType"`
	ExternalParameters   map[string]json.RawMessage `json:"externalParameters"`
	ResolvedDependencies []slsaResourceDescriptor   `json:"resolvedDependencies"`
}

type slsaV1RunDetails struct {
	Builder  slsaV1Builder  `json:"builder"`
	Metadata slsaV1Metadata `json:"metadata"`
}

type slsaV1Builder struct {
	ID string `json:"id"`
}

type slsaV1Metadata struct {
	InvocationID string `json:"invocationId"`
}

type slsaResourceDescriptor struct {
	URI    string            `json:"uri"`
	Digest map[string]string `json:"digest"`
}

// slsaV1Workflow is the shape of buildDefinition.externalParameters.workflow
// when buildType is the GitHub Actions workflow build type
// "https://actions.github.io/buildtypes/workflow/v1".
type slsaV1Workflow struct {
	Ref        string `json:"ref"`
	Repository string `json:"repository"`
	Path       string `json:"path"`
}

// slsaV02Predicate is the SLSA Provenance v0.2 predicate shape
// (predicateType "https://slsa.dev/provenance/v0.2").
type slsaV02Predicate struct {
	Builder    slsaV1Builder      `json:"builder"`
	BuildType  string             `json:"buildType"`
	Invocation slsaV02Invocation  `json:"invocation"`
	Materials  []slsaV02Material  `json:"materials"`
	Metadata   slsaV02Metadata    `json:"metadata"`
}

type slsaV02Invocation struct {
	ConfigSource slsaV02ConfigSource `json:"configSource"`
}

type slsaV02ConfigSource struct {
	URI        string            `json:"uri"`
	Digest     map[string]string `json:"digest"`
	EntryPoint string            `json:"entryPoint"`
}

type slsaV02Material struct {
	URI    string            `json:"uri"`
	Digest map[string]string `json:"digest"`
}

type slsaV02Metadata struct {
	BuildInvocationID string `json:"buildInvocationId"`
}
