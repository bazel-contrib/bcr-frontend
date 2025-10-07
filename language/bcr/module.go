package bcr

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/rule"
	"github.com/bazelbuild/buildtools/build"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

func readModuleBazelFile(filename string) (*bzpb.ModuleVersion, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("reading MODULE.bazel file: %v", err)
	}
	f, err := build.ParseModule(filename, data)
	if err != nil {
		return nil, fmt.Errorf("parsing MODULE.bazel file: %v", err)
	}
	return readModuleBazelBuildFile(filename, f)
}

func readModuleBazelBuildFile(filename string, f *build.File) (*bzpb.ModuleVersion, error) {
	var module bzpb.ModuleVersion
	moduleRules := f.Rules("module")
	if len(moduleRules) != 1 {
		return nil, fmt.Errorf("file does not contain at least one module rule: %s", filename)
	}
	r := moduleRules[0]
	module.Name = r.AttrString("name")
	module.RepoName = r.AttrString("repo_name")
	module.CompatibilityLevel = int32(parseStarlarkInt64(r.AttrString("compatibility_level")))
	for _, rule := range f.Rules("bazel_dep") {
		module.Deps = append(module.Deps, &bzpb.ModuleVersion_Dependency{
			Name:    rule.AttrString("name"),
			Version: rule.AttrString("version"),
			Dev:     parseStarlarkBool(rule.AttrString("dev_dependency")),
		})
	}
	return &module, nil
}

func makeModuleDependencyRules(deps []*bzpb.ModuleVersion_Dependency) []*rule.Rule {
	var rules []*rule.Rule
	for i, dep := range deps {
		name := dep.Name
		if name == "" {
			name = fmt.Sprintf("dep_%d", i)
		}

		r := rule.NewRule("module_dependency", name)
		r.SetAttr("dep_name", dep.Name)
		if dep.Version != "" {
			r.SetAttr("version", dep.Version)
		}
		if dep.Dev {
			r.SetAttr("dev", dep.Dev)
		}
		rules = append(rules, r)
	}
	return rules
}

func makeModuleVersionRule(module *bzpb.ModuleVersion, version string, depRules []*rule.Rule, sourceRule *rule.Rule, attestationsRule *rule.Rule) *rule.Rule {
	r := rule.NewRule("module_version", version)
	if module.Name != "" {
		r.SetAttr("module_name", module.Name)
	}
	if version != "" {
		r.SetAttr("version", version)
	}
	if module.CompatibilityLevel != 0 {
		r.SetAttr("compatibility_level", int(module.CompatibilityLevel))
	}
	if module.RepoName != "" {
		r.SetAttr("repo_name", module.RepoName)
	}
	if len(depRules) > 0 {
		deps := make([]string, len(depRules))
		for i, dr := range depRules {
			deps[i] = fmt.Sprintf(":%s", dr.Name())
		}
		r.SetAttr("deps", deps)
	}
	if sourceRule != nil {
		r.SetAttr("source", fmt.Sprintf(":%s", sourceRule.Name()))
	}
	if attestationsRule != nil {
		r.SetAttr("attestations", fmt.Sprintf(":%s", attestationsRule.Name()))
	}
	r.SetAttr("visibility", []string{"//visibility:public"})
	return r
}

func moduleVersionLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:module_version.bzl",
		Symbols: []string{"module_version"},
	}
}

func moduleDependencyLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:module_dependency.bzl",
		Symbols: []string{"module_dependency"},
	}
}

func moduleVersionKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"module_version": {
			MatchAny:     true,
			ResolveAttrs: map[string]bool{"deps": true, "source": true, "attestations": true},
		},
		"module_dependency": {
			MatchAny:     true,
			ResolveAttrs: map[string]bool{},
		},
	}
}

// parseStarlarkBool parses the boolean string and discards any parse error
func parseStarlarkBool(value string) bool {
	result, _ := strconv.ParseBool(strings.ToLower(value))
	return result
}

// parseStarlarkInt parses the boolean string and discards any parse error
func parseStarlarkInt64(value string) int64 {
	result, _ := strconv.ParseInt(value, 10, 64)
	return result
}
