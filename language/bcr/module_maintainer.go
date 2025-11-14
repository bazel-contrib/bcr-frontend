package bcr

import (
	"fmt"

	"github.com/bazelbuild/bazel-gazelle/rule"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// moduleMaintainerLoadInfo returns load info for the module_maintainer rule
func moduleMaintainerLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:module_maintainer.bzl",
		Symbols: []string{"module_maintainer"},
	}
}

// moduleMaintainerKinds returns kind info for the module_maintainer rule
func moduleMaintainerKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"module_maintainer": {
			MatchAttrs: []string{"name", "email"},
		},
	}
}

// makeModuleMaintainerRules creates module_maintainer rules from protobuf maintainers
func makeModuleMaintainerRules(maintainers []*bzpb.Maintainer) []*rule.Rule {
	var rules []*rule.Rule
	for i, m := range maintainers {
		name := fmt.Sprintf("maintainer_%d", i)
		if m.Github != "" {
			name = m.Github
		} else if m.Email != "" {
			name = m.Email
		}

		r := rule.NewRule("module_maintainer", name)
		if m.Email != "" {
			r.SetAttr("email", m.Email)
		}
		if m.Name != "" {
			r.SetAttr("username", m.Name)
		}
		if m.Github != "" {
			r.SetAttr("github", m.Github)
		}
		if m.DoNotNotify {
			r.SetAttr("do_not_notify", m.DoNotNotify)
		}
		if m.GithubUserId != 0 {
			r.SetAttr("github_user_id", int(m.GithubUserId))
		}
		rules = append(rules, r)
	}
	return rules
}
