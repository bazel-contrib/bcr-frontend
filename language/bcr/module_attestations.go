package bcr

import (
	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

const moduleAttestationsKind = "module_attestations"

func makeModuleAttestationsRule(attestations *bzpb.Attestations, attestationsJsonFile string) *rule.Rule {
	r := rule.NewRule(moduleAttestationsKind, "attestations")
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
		Name:    "//rules:module_attestations.bzl",
		Symbols: []string{moduleAttestationsKind},
	}
}

func moduleAttestationsKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		moduleAttestationsKind: {
			MatchAny:     true,
			ResolveAttrs: map[string]bool{},
		},
	}
}
