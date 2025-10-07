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
	module.CompatibilityLevel = parseStarlarkInt32(r.AttrString("compatibility_level"))

	// Build a map of overrides by module name
	overrides := buildOverridesMap(f)

	for _, rule := range f.Rules("bazel_dep") {
		name := rule.AttrString("name")
		dep := &bzpb.ModuleDependency{
			Name:    name,
			Version: rule.AttrString("version"),
			Dev:     parseStarlarkBool(rule.AttrString("dev_dependency")),
		}

		// Add override if one exists for this module
		addOverrideToModuleDependency(dep, name, overrides)

		module.Deps = append(module.Deps, dep)
	}
	return &module, nil
}

// buildOverridesMap builds a map of module name to override rule from the MODULE.bazel file
func buildOverridesMap(f *build.File) map[string]*build.Rule {
	overrides := make(map[string]*build.Rule)
	overrideKinds := []string{"git_override", "archive_override", "single_version_override", "local_path_override"}

	for _, kind := range overrideKinds {
		for _, r := range f.Rules(kind) {
			if moduleName := r.AttrString("module_name"); moduleName != "" {
				overrides[moduleName] = r
			}
		}
	}

	return overrides
}

// addOverrideToModuleDependency adds the override to the module dependency based on the rule type
func addOverrideToModuleDependency(dep *bzpb.ModuleDependency, moduleName string, overrides map[string]*build.Rule) {
	overrideRule, ok := overrides[moduleName]
	if !ok {
		return
	}

	switch overrideRule.Kind() {
	case "git_override":
		dep.Override = &bzpb.ModuleDependency_GitOverride{
			GitOverride: &bzpb.GitOverride{
				Commit:     overrideRule.AttrString("commit"),
				PatchStrip: parseStarlarkInt32(overrideRule.AttrString("patch_strip")),
				Patches:    overrideRule.AttrStrings("patches"),
				Remote:     overrideRule.AttrString("remote"),
			},
		}
	case "archive_override":
		dep.Override = &bzpb.ModuleDependency_ArchiveOverride{
			ArchiveOverride: &bzpb.ArchiveOverride{
				Integrity:   overrideRule.AttrString("integrity"),
				PatchStrip:  parseStarlarkInt32(overrideRule.AttrString("patch_strip")),
				Patches:     overrideRule.AttrStrings("patches"),
				StripPrefix: overrideRule.AttrString("strip_prefix"),
				Urls:        overrideRule.AttrStrings("urls"),
			},
		}
	case "single_version_override":
		dep.Override = &bzpb.ModuleDependency_SingleVersionOverride{
			SingleVersionOverride: &bzpb.SingleVersionOverride{
				PatchStrip: parseStarlarkInt32(overrideRule.AttrString("patch_strip")),
				Patches:    overrideRule.AttrStrings("patches"),
				Version:    overrideRule.AttrString("version"),
			},
		}
	case "local_path_override":
		dep.Override = &bzpb.ModuleDependency_LocalPathOverride{
			LocalPathOverride: &bzpb.LocalPathOverride{
				Path: overrideRule.AttrString("path"),
			},
		}
	}
}

// parseStarlarkBool parses the boolean string and discards any parse error
func parseStarlarkBool(value string) bool {
	result, _ := strconv.ParseBool(strings.ToLower(value))
	return result
}

// parseStarlarkInt32 parses the int32 string and discards any parse error
func parseStarlarkInt32(value string) int32 {
	result, _ := strconv.ParseInt(value, 10, 32)
	return int32(result)
}
