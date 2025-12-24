package modulebazel

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazelbuild/bazel-gazelle/rule"
	"github.com/bazelbuild/buildtools/build"
)

// ExecFile evaluates a MODULE.bazel as starlark file into a ModuleVersion protobuf
func ExecFile(filename string) (*bzpb.ModuleVersion, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	module, err := loadStarlarkModuleBazelFile(filename, data,
		func(msg string) {
			log.Printf("starlark module out> %s", msg)
		}, func(err error) {
			log.Printf("starlark module err> %v", err)
		},
	)
	if err != nil {
		return nil, fmt.Errorf("evaluating %s: %v", filename, err)
	}

	// collect rule source text for overrides for raw display in the UI
	if len(module.Override) > 0 {
		f, err := build.ParseModule(filename, data)
		if err != nil {
			return nil, err
		}
		overridesMap := buildOverridesMap(f)
		for _, override := range module.Override {
			if rule, ok := overridesMap[override.ModuleName]; ok {
				override.Code = formatBuildRules(rule)
			}
		}
	}

	return module, nil
}

// LoadFile parses a MODULE.bazel file from a byte slice and scans it for rules
// and load statements. The syntax tree within the returned File will be
// modified by editing methods.
func LoadFile(path, pkg string) (*rule.File, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	ast, err := build.ParseModule(path, data)
	if err != nil {
		return nil, err
	}

	f := rule.ScanAST(pkg, ast)
	// checkFile is not part of gazelle public API: skip it and pray
	// if err := checkFile(f); err != nil {
	// 	return nil, err
	// }
	f.Content = data
	return f, nil
}

// ParseFile reads and parses a MODULE.bazel file into build.File
func ParseFile(filename string) (*build.File, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, err
	}
	f, err := build.ParseModule(filename, data)
	if err != nil {
		return nil, err
	}
	return f, nil
}

// ParseFileModuleVersion reads and parses a MODULE.bazel file into a
// ModuleVersion protobuf
func ParseFileModuleVersion(filename string) (*bzpb.ModuleVersion, error) {
	f, err := ParseFile(filename)
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

	dep.Override = &bzpb.ModuleDependencyOverride{}

	switch overrideRule.Kind() {
	case "git_override":
		dep.Override.Override = &bzpb.ModuleDependencyOverride_GitOverride{
			GitOverride: &bzpb.GitOverride{
				Commit:     overrideRule.AttrString("commit"),
				Remote:     overrideRule.AttrString("remote"),
				Branch:     overrideRule.AttrString("branch"),
				PatchStrip: parseInt32(overrideRule.AttrString("patch_strip")),
				Patches:    overrideRule.AttrStrings("patches"),
			},
		}
	case "archive_override":
		dep.Override.Override = &bzpb.ModuleDependencyOverride_ArchiveOverride{
			ArchiveOverride: &bzpb.ArchiveOverride{
				Integrity:   overrideRule.AttrString("integrity"),
				PatchStrip:  parseInt32(overrideRule.AttrString("patch_strip")),
				Patches:     overrideRule.AttrStrings("patches"),
				StripPrefix: overrideRule.AttrString("strip_prefix"),
				Urls:        overrideRule.AttrStrings("urls"),
			},
		}
	case "single_version_override":
		dep.Override.Override = &bzpb.ModuleDependencyOverride_SingleVersionOverride{
			SingleVersionOverride: &bzpb.SingleVersionOverride{
				PatchStrip: parseInt32(overrideRule.AttrString("patch_strip")),
				Patches:    overrideRule.AttrStrings("patches"),
				Version:    overrideRule.AttrString("version"),
			},
		}
	case "local_path_override":
		dep.Override.Override = &bzpb.ModuleDependencyOverride_LocalPathOverride{
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

// func formatRules(rules ...*rule.Rule) string {
// 	file := rule.EmptyFile("", "")
// 	for _, r := range rules {
// 		r.Insert(file)
// 	}
// 	return string(file.Format())
// }

func formatBuildRules(rules ...*build.Rule) string {
	file := &build.File{}
	for _, r := range rules {
		file.Stmt = append(file.Stmt, r.Call)
	}
	return string(build.Format(file))
}
