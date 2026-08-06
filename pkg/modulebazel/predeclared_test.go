package modulebazel

import (
	"strings"
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
)

func TestLoadStarlarkModuleBazelFileRegistryOverrides(t *testing.T) {
	tests := []struct {
		name string
		src  string
		want func(*testing.T, *bzpb.ModuleDependencyOverride)
	}{
		{
			name: "single version",
			src: `
module(name = "root", version = "1.0.0")
bazel_dep(name = "dep", version = "1.2.3")
single_version_override(
    module_name = "dep",
    version = "1.2.4",
    registry = "https://registry.example/modules",
)
`,
			want: func(t *testing.T, got *bzpb.ModuleDependencyOverride) {
				t.Helper()
				override := got.GetSingleVersionOverride()
				if override == nil {
					t.Fatal("override type is not single_version_override")
				}
				if got, want := override.GetRegistry(), "https://registry.example/modules"; got != want {
					t.Errorf("registry = %q, want %q", got, want)
				}
				if got, want := override.GetVersion(), "1.2.4"; got != want {
					t.Errorf("version = %q, want %q", got, want)
				}
			},
		},
		{
			name: "multiple version",
			src: `
module(name = "root", version = "1.0.0")
bazel_dep(name = "dep", version = "1.2.3")
multiple_version_override(
    module_name = "dep",
    versions = ["1.2.3", "2.0.0"],
    registry = "https://registry.example/modules",
)
`,
			want: func(t *testing.T, got *bzpb.ModuleDependencyOverride) {
				t.Helper()
				override := got.GetMultipleVersionOverride()
				if override == nil {
					t.Fatal("override type is not multiple_version_override")
				}
				if got, want := override.GetRegistry(), "https://registry.example/modules"; got != want {
					t.Errorf("registry = %q, want %q", got, want)
				}
				if got, want := strings.Join(override.GetVersions(), ","), "1.2.3,2.0.0"; got != want {
					t.Errorf("versions = %q, want %q", got, want)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			module, err := loadStarlarkModuleBazelFile("MODULE.bazel", tt.src, func(string) {}, func(error) {})
			if err != nil {
				t.Fatalf("loadStarlarkModuleBazelFile() error = %v", err)
			}
			if got, want := len(module.GetOverride()), 1; got != want {
				t.Fatalf("len(overrides) = %d, want %d", got, want)
			}
			tt.want(t, module.GetOverride()[0])
			if module.GetDeps()[0].GetOverride() != module.GetOverride()[0] {
				t.Error("dependency is not linked to its override")
			}
		})
	}
}

func TestLoadStarlarkModuleBazelFileRejectsUnexpectedOverrideKeyword(t *testing.T) {
	const src = `
module(name = "root", version = "1.0.0")
single_version_override(module_name = "dep", registries = ["https://registry.example/modules"])
`

	_, err := loadStarlarkModuleBazelFile("MODULE.bazel", src, func(string) {}, func(error) {})
	if err == nil {
		t.Fatal("loadStarlarkModuleBazelFile() succeeded, want unexpected keyword error")
	}
	if !strings.Contains(err.Error(), `unexpected keyword argument "registries"`) {
		t.Fatalf("error = %q, want unexpected keyword error", err)
	}
}
