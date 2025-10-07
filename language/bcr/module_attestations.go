package bcr

import (
	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/attestationsjson"
)

func readAttestationsJson(filename string) (*bzpb.Attestations, error) {
	return attestationsjson.ReadFile(filename)
}

func makeModuleAttestationsRule(attestations *bzpb.Attestations, attestationsJsonFile string) *rule.Rule {
	r := rule.NewRule("module_attestations", "attestations")
	if attestations.MediaType != "" {
		r.SetAttr("media_type", attestations.MediaType)
	}
	if len(attestations.Attestations) > 0 {
		// Convert map[string]*Attestation to map[string]string for the url
		urls := make(map[string]string)
		integrities := make(map[string]string)
		for name, att := range attestations.Attestations {
			if att.Url != "" {
				urls[name] = att.Url
			}
			if att.Integrity != "" {
				integrities[name] = att.Integrity
			}
		}
		if len(urls) > 0 {
			r.SetAttr("urls", urls)
		}
		if len(integrities) > 0 {
			r.SetAttr("integrities", integrities)
		}
	}
	if attestationsJsonFile != "" {
		r.SetAttr("attestations_json", attestationsJsonFile)
	}
	return r
}

func moduleAttestationsLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:module_attestations.bzl",
		Symbols: []string{"module_attestations"},
	}
}

func moduleAttestationsKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"module_attestations": {
			MatchAny:     true,
			ResolveAttrs: map[string]bool{},
		},
	}
}
