package bcr

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/config"
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
	"github.com/bazelbuild/buildtools/build"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// moduleVersionLoadInfo returns load info for the module_version rule
func moduleVersionLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "@centrl//rules:module_version.bzl",
		Symbols: []string{"module_version"},
	}
}

// moduleVersionKinds returns kind info for the module_version rule
func moduleVersionKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		"module_version": {
			MatchAny: true,
			ResolveAttrs: map[string]bool{
				"deps":         true,
				"source":       true,
				"attestations": true,
			},
		},
	}
}

// makeModuleVersionRule creates a module_version rule from parsed MODULE.bazel data
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

	// Set GazelleImports private attr with the import spec
	// The import spec for a module version is "module_name@version"
	if module.Name != "" && version != "" {
		importSpec := fmt.Sprintf("%s@%s", module.Name, version)
		r.SetPrivateAttr(config.GazelleImportsKey, []string{importSpec})
	}

	return r
}

// moduleVersionImports returns import specs for indexing module_version rules
func moduleVersionImports(r *rule.Rule) []resolve.ImportSpec {
	// Get the module name and version to construct the import spec
	moduleName := r.AttrString("module_name")
	version := r.AttrString("version")

	if moduleName == "" || version == "" {
		return nil
	}

	// Construct and return the import spec: "module_name@version"
	importSpec := resolve.ImportSpec{
		Lang: "bcr",
		Imp:  fmt.Sprintf("%s@%s", moduleName, version),
	}

	return []resolve.ImportSpec{importSpec}
}

// readModuleBazelFile reads and parses a MODULE.bazel file
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

// readModuleBazelBuildFile parses a MODULE.bazel AST into protobuf
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
		module.Deps = append(module.Deps, &bzpb.ModuleDependency{
			Name:    rule.AttrString("name"),
			Version: rule.AttrString("version"),
			Dev:     parseStarlarkBool(rule.AttrString("dev_dependency")),
		})
	}
	return &module, nil
}

// parseStarlarkBool parses the boolean string and discards any parse error
func parseStarlarkBool(value string) bool {
	result, _ := strconv.ParseBool(strings.ToLower(value))
	return result
}

// parseStarlarkInt64 parses the int64 string and discards any parse error
func parseStarlarkInt64(value string) int64 {
	result, _ := strconv.ParseInt(value, 10, 64)
	return result
}
