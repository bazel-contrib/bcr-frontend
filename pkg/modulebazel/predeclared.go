package modulebazel

import (
	"fmt"
	"log"
	"sort"

	bzpb "github.com/stackb/centrl/build/stack/bazel/registry/v1"
	"go.starlark.net/starlark"
	"go.starlark.net/starlarkstruct"
)

func loadStarlarkModuleBazelFile(filename string, src any, reporter func(msg string), errorReporter func(err error)) (*bzpb.ModuleVersion, error) {
	module := new(bzpb.ModuleVersion)
	predeclared := newPredeclared(module)

	_, _, err := loadStarlarkProgram(filename, src, predeclared, reporter, errorReporter)
	if err != nil {
		return nil, err
	}

	// at this point all bazel_dep rules have been called, but there can be
	// duplicate values (e.g. 'boost.accumulators' in modules/boost.pin_version/1.88.0.bcr.1/MODULE.bazel)
	// dedup them.
	module.Deps = deduplicateAndSortDeps(module.Deps, module.Override)

	return module, nil
}

func newPredeclared(module *bzpb.ModuleVersion) *permissiveStringDict {
	return &permissiveStringDict{
		StringDict: starlark.StringDict{
			"module":                  starlark.NewBuiltin("module", makeModuleBuiltin(module)),
			"bazel_dep":               starlark.NewBuiltin("bazel_dep", makeBazelDepBuiltin(module)),
			"git_override":            starlark.NewBuiltin("git_override", makeGitOverrideBuiltin(module)),
			"archive_override":        starlark.NewBuiltin("archive_override", makeArchiveOverrideBuiltin(module)),
			"single_version_override": starlark.NewBuiltin("single_version_override", makeSingleVersionOverrideBuiltin(module)),
			"local_path_override":     starlark.NewBuiltin("local_path_override", makeLocalPathOverrideBuiltin(module)),
			"use_extension":           starlark.NewBuiltin("use_extension", ignoreReturningCallable("use_extension")),
			"use_repo":                starlark.NewBuiltin("use_repo", ignore()),
			"use_repo_rule":           starlark.NewBuiltin("use_repo_rule", ignoreReturningCallable("use_repo_rule")),
			"struct":                  starlark.NewBuiltin("struct", starlarkstruct.Make),
			"True":                    starlark.True,
			"False":                   starlark.False,
			"None":                    starlark.None,
		},
	}
}

func makeModuleBuiltin(module *bzpb.ModuleVersion) goStarlarkFunction {
	return func(thread *starlark.Thread, _ *starlark.Builtin, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
		var name, version, repoName string
		bazelCompatibility := &starlark.List{}
		toolchainsToRegister := &starlark.List{}
		if err := starlark.UnpackArgs("module", args, kwargs,
			"name", &name,
			"version?", &version,
			"repo_name?", &repoName,
			"bazel_compatibility?", &bazelCompatibility,
			"compatibility_level?", &module.CompatibilityLevel,
			"toolchains_to_register?", &toolchainsToRegister,
		); err != nil {
			return nil, err
		}
		module.Name = name
		module.Version = version
		module.RepoName = repoName
		module.BazelCompatibility = mustGetStringSlice(bazelCompatibility)
		module.ToolchainsToRegister = mustGetStringSlice(toolchainsToRegister)
		return starlark.None, nil
	}
}

func makeBazelDepBuiltin(module *bzpb.ModuleVersion) goStarlarkFunction {
	return func(thread *starlark.Thread, _ *starlark.Builtin, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
		var name, version, repoName string
		var devDependency bool
		var maxCompatibilityLevel int

		if err := starlark.UnpackArgs("bazel_dep", args, kwargs,
			"name", &name,
			"version?", &version,
			"repo_name??", &repoName,
			"dev_dependency?", &devDependency,
			"max_compatibility_level?", &maxCompatibilityLevel,
		); err != nil {
			return nil, fmt.Errorf("unpack error: %v", err)
		}

		module.Deps = append(module.Deps, &bzpb.ModuleDependency{
			Name:                  name,
			Version:               version,
			RepoName:              repoName,
			Dev:                   devDependency,
			MaxCompatibilityLevel: int32(maxCompatibilityLevel),
		})
		return starlark.None, nil
	}
}

func makeGitOverrideBuiltin(module *bzpb.ModuleVersion) goStarlarkFunction {
	return func(thread *starlark.Thread, _ *starlark.Builtin, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
		var moduleName, commit, remote, branch string
		var patchStrip int
		patches := &starlark.List{}

		if err := starlark.UnpackArgs("git_override", args, kwargs,
			"module_name", &moduleName,
			"commit?", &commit,
			"remote?", &remote,
			"branch?", &branch,
			"patch_strip?", &patchStrip,
			"patches?", &patches,
		); err != nil {
			return nil, fmt.Errorf("unpack error: %v", err)
		}

		override := &bzpb.ModuleDependencyOverride{
			ModuleName: moduleName,
			Override: &bzpb.ModuleDependencyOverride_GitOverride{
				GitOverride: &bzpb.GitOverride{
					Commit:     commit,
					Remote:     remote,
					Branch:     branch,
					PatchStrip: int32(patchStrip),
					Patches:    mustGetStringSlice(patches),
				},
			},
		}
		module.Override = append(module.Override, override)
		return starlark.None, nil
	}
}

func makeArchiveOverrideBuiltin(module *bzpb.ModuleVersion) goStarlarkFunction {
	return func(thread *starlark.Thread, _ *starlark.Builtin, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
		var moduleName, integrity, stripPrefix string
		var patchStrip int
		patches := &starlark.List{}
		var urlsValue, urlValue starlark.Value

		if err := starlark.UnpackArgs("archive_override", args, kwargs,
			"module_name", &moduleName,
			"integrity?", &integrity,
			"strip_prefix?", &stripPrefix,
			"patch_strip?", &patchStrip,
			"patches?", &patches,
			"url?", &urlValue,
			"urls?", &urlsValue,
		); err != nil {
			return nil, fmt.Errorf("unpack error: %v", err)
		}

		// Handle urls as either string or list
		var urls []string
		if urlsValue != nil {
			switch v := urlsValue.(type) {
			case starlark.String:
				urls = []string{v.GoString()}
			case *starlark.List:
				urls = mustGetStringSlice(v)
			default:
				return nil, fmt.Errorf("archive_override: urls must be string or list, got %s", urlsValue.Type())
			}
		}

		// Handle singular url parameter
		if urlValue != nil {
			if urlStr, ok := urlValue.(starlark.String); ok {
				urls = append(urls, urlStr.GoString())
			} else {
				return nil, fmt.Errorf("archive_override: url must be string, got %s", urlValue.Type())
			}
		}

		override := &bzpb.ModuleDependencyOverride{
			ModuleName: moduleName,
			Override: &bzpb.ModuleDependencyOverride_ArchiveOverride{
				ArchiveOverride: &bzpb.ArchiveOverride{
					Integrity:   integrity,
					StripPrefix: stripPrefix,
					PatchStrip:  int32(patchStrip),
					Patches:     mustGetStringSlice(patches),
					Urls:        urls,
				},
			},
		}
		module.Override = append(module.Override, override)
		return starlark.None, nil
	}
}

func makeSingleVersionOverrideBuiltin(module *bzpb.ModuleVersion) goStarlarkFunction {
	return func(thread *starlark.Thread, _ *starlark.Builtin, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
		var moduleName, version string
		var patchStrip int
		patches := &starlark.List{}

		if err := starlark.UnpackArgs("single_version_override", args, kwargs,
			"module_name", &moduleName,
			"version?", &version,
			"patch_strip?", &patchStrip,
			"patches?", &patches,
		); err != nil {
			return nil, fmt.Errorf("unpack error: %v", err)
		}

		override := &bzpb.ModuleDependencyOverride{
			ModuleName: moduleName,
			Override: &bzpb.ModuleDependencyOverride_SingleVersionOverride{
				SingleVersionOverride: &bzpb.SingleVersionOverride{
					Version:    version,
					PatchStrip: int32(patchStrip),
					Patches:    mustGetStringSlice(patches),
				},
			},
		}
		module.Override = append(module.Override, override)
		return starlark.None, nil
	}
}

func makeLocalPathOverrideBuiltin(module *bzpb.ModuleVersion) goStarlarkFunction {
	return func(thread *starlark.Thread, _ *starlark.Builtin, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
		var moduleName, path string

		if err := starlark.UnpackArgs("local_path_override", args, kwargs,
			"module_name", &moduleName,
			"path?", &path,
		); err != nil {
			return nil, fmt.Errorf("unpack error: %v", err)
		}

		override := &bzpb.ModuleDependencyOverride{
			ModuleName: moduleName,
			Override: &bzpb.ModuleDependencyOverride_LocalPathOverride{
				LocalPathOverride: &bzpb.LocalPathOverride{
					Path: path,
				},
			},
		}
		module.Override = append(module.Override, override)
		return starlark.None, nil
	}
}

func ignore() goStarlarkFunction {
	return func(thread *starlark.Thread, _ *starlark.Builtin, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
		// Accept any arguments without validation
		return starlark.None, nil
	}
}

func ignoreReturningCallable(name string) goStarlarkFunction {
	return func(thread *starlark.Thread, _ *starlark.Builtin, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
		// Return a stub that supports both calls and attribute access
		return &stubValue{name: name}, nil
	}
}

// stubValue is a Starlark value that accepts any call and attribute access
type stubValue struct {
	name string
}

var _ starlark.Callable = (*stubValue)(nil)
var _ starlark.HasAttrs = (*stubValue)(nil)

func (s *stubValue) String() string        { return s.name }
func (s *stubValue) Type() string          { return "stub" }
func (s *stubValue) Freeze()               {}
func (s *stubValue) Truth() starlark.Bool  { return starlark.True }
func (s *stubValue) Hash() (uint32, error) { return 0, fmt.Errorf("unhashable: %s", s.Type()) }

// Attr allows attribute access like export.symlink
func (s *stubValue) Attr(name string) (starlark.Value, error) {
	return &stubValue{name: s.name + "." + name}, nil
}

func (s *stubValue) AttrNames() []string { return []string{} }

// Name implements starlark.Callable
func (s *stubValue) Name() string { return s.name }

// CallInternal implements starlark.Callable
func (s *stubValue) CallInternal(thread *starlark.Thread, args starlark.Tuple, kwargs []starlark.Tuple) (starlark.Value, error) {
	return starlark.None, nil
}

func deduplicateAndSortDeps(deps []*bzpb.ModuleDependency, overrides []*bzpb.ModuleDependencyOverride) []*bzpb.ModuleDependency {
	if len(deps) == 0 {
		return deps
	}

	// Build a map of module_name to override
	overrideMap := make(map[string]*bzpb.ModuleDependencyOverride)
	for _, override := range overrides {
		if override.ModuleName != "" {
			overrideMap[override.ModuleName] = override
		}
	}

	// Use a map to track unique deps by name
	seen := make(map[string]*bzpb.ModuleDependency)
	var names []string

	for _, dep := range deps {
		if _, exists := seen[dep.Name]; !exists {
			// Assign override if one exists for this module
			if override, hasOverride := overrideMap[dep.Name]; hasOverride {
				dep.Override = override
			}
			seen[dep.Name] = dep
			names = append(names, dep.Name)
		}
	}

	// Sort by name
	sort.Strings(names)

	// Build result in sorted order
	result := make([]*bzpb.ModuleDependency, 0, len(names))
	for _, name := range names {
		result = append(result, seen[name])
	}

	return result
}

func mustGetStringSlice(list *starlark.List) (out []string) {
	for i := 0; i < list.Len(); i++ {
		value := list.Index(i)
		switch value := (value).(type) {
		case starlark.String:
			out = append(out, value.GoString())
		default:
			log.Fatalf("list[%d]: expected string, got %s", i, value.Type())
		}
	}
	return
}
