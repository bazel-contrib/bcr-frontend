package modulebazel

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/bazelbuild/buildtools/build"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// ReadFile reads and parses a MODULE.bazel file into a ModuleVersion protobuf
func ReadFile(filename string) (*bzpb.ModuleVersion, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	f, err := build.ParseModule(filename, data)
	if err != nil {
		return nil, err
	}
	return parse(filename, f)
}

// parse parses a MODULE.bazel AST into protobuf
func parse(filename string, f *build.File) (*bzpb.ModuleVersion, error) {
	var module bzpb.ModuleVersion
	moduleRules := f.Rules("module")
	if len(moduleRules) != 1 {
		return nil, fmt.Errorf("file does not contain at least one module rule: %s", filename)
	}
	r := moduleRules[0]
	module.Name = r.AttrString("name")
	module.RepoName = r.AttrString("repo_name")
	module.CompatibilityLevel = parseInt32(r.AttrString("compatibility_level"))
	module.BazelCompatibility = r.AttrStrings("bazel_compatibility")

	// Build a map of overrides by module name
	overrides := buildOverridesMap(f)

	for _, rule := range f.Rules("bazel_dep") {
		name := rule.AttrString("name")
		dep := &bzpb.ModuleDependency{
			Name:    name,
			Version: rule.AttrString("version"),
			Dev:     parseBool(rule.AttrString("dev_dependency")),
		}

		// Add override if one exists for this module
		addOverride(dep, name, overrides)

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

// addOverride adds the override to the module dependency based on the rule type
func addOverride(dep *bzpb.ModuleDependency, moduleName string, overrides map[string]*build.Rule) {
	overrideRule, ok := overrides[moduleName]
	if !ok {
		return
	}

	switch overrideRule.Kind() {
	case "git_override":
		dep.Override = &bzpb.ModuleDependency_GitOverride{
			GitOverride: &bzpb.GitOverride{
				Commit:     overrideRule.AttrString("commit"),
				PatchStrip: parseInt32(overrideRule.AttrString("patch_strip")),
				Patches:    overrideRule.AttrStrings("patches"),
				Remote:     overrideRule.AttrString("remote"),
			},
		}
	case "archive_override":
		dep.Override = &bzpb.ModuleDependency_ArchiveOverride{
			ArchiveOverride: &bzpb.ArchiveOverride{
				Integrity:   overrideRule.AttrString("integrity"),
				PatchStrip:  parseInt32(overrideRule.AttrString("patch_strip")),
				Patches:     overrideRule.AttrStrings("patches"),
				StripPrefix: overrideRule.AttrString("strip_prefix"),
				Urls:        overrideRule.AttrStrings("urls"),
			},
		}
	case "single_version_override":
		dep.Override = &bzpb.ModuleDependency_SingleVersionOverride{
			SingleVersionOverride: &bzpb.SingleVersionOverride{
				PatchStrip: parseInt32(overrideRule.AttrString("patch_strip")),
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

// parseBool parses the boolean string and discards any parse error
func parseBool(value string) bool {
	result, _ := strconv.ParseBool(strings.ToLower(value))
	return result
}

// parseInt32 parses the int32 string and discards any parse error
func parseInt32(value string) int32 {
	result, _ := strconv.ParseInt(value, 10, 32)
	return int32(result)
}
