package modulebazel

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"google.golang.org/protobuf/proto"
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
    patches = ["//patches:fix.patch"],
    patch_strip = 1,
    patch_cmds = ["echo patched", "touch patched.txt"],
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
				if got, want := strings.Join(override.GetPatches(), ","), "//patches:fix.patch"; got != want {
					t.Errorf("patches = %q, want %q", got, want)
				}
				if got, want := override.GetPatchStrip(), int32(1); got != want {
					t.Errorf("patch_strip = %d, want %d", got, want)
				}
				if got, want := strings.Join(override.GetPatchCmds(), ","), "echo patched,touch patched.txt"; got != want {
					t.Errorf("patch_cmds = %q, want %q", got, want)
				}
			},
		},
		{
			name: "single version with patch_cmds",
			src: `
module(name = "root", version = "1.0.0")
bazel_dep(name = "dep", version = "1.2.3")
single_version_override(
    module_name = "dep",
    version = "1.2.3",
    patch_cmds = ["rm -f foo"],
    patch_strip = 1,
    patches = ["//:dep.patch"],
)
`,
			want: func(t *testing.T, got *bzpb.ModuleDependencyOverride) {
				t.Helper()
				override := got.GetSingleVersionOverride()
				if override == nil {
					t.Fatal("override type is not single_version_override")
				}
				if got, want := strings.Join(override.GetPatches(), ","), "//:dep.patch"; got != want {
					t.Errorf("patches = %q, want %q", got, want)
				}
			},
		},
		{
			name: "archive with patch_cmds",
			src: `
module(name = "root", version = "1.0.0")
bazel_dep(name = "dep", version = "1.2.3")
archive_override(
    module_name = "dep",
    urls = ["https://example.com/dep.tar.gz"],
    patch_cmds = ["rm -f foo"],
)
`,
			want: func(t *testing.T, got *bzpb.ModuleDependencyOverride) {
				t.Helper()
				override := got.GetArchiveOverride()
				if override == nil {
					t.Fatal("override type is not archive_override")
				}
				if got, want := strings.Join(override.GetUrls(), ","), "https://example.com/dep.tar.gz"; got != want {
					t.Errorf("urls = %q, want %q", got, want)
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

func TestOverridePatchCmdsFromFile(t *testing.T) {
	want := []string{`echo "patched"`, `printf 'line1\nline2\n' > patched.txt`}
	for _, kind := range []string{"single_version_override", "archive_override"} {
		t.Run(kind, func(t *testing.T) {
			code := fmt.Sprintf("%s(\n    module_name = \"dep\",\n    patch_cmds = [\n        %q,\n        %q,\n    ],\n)\n", kind, want[0], want[1])
			src := "module(name = \"root\", version = \"1.0.0\")\nbazel_dep(name = \"dep\", version = \"1.2.3\")\n" + code
			filename := filepath.Join(t.TempDir(), "MODULE.bazel")
			if err := os.WriteFile(filename, []byte(src), 0o600); err != nil {
				t.Fatal(err)
			}
			for _, loader := range []struct {
				name string
				load func(string) (*bzpb.ModuleVersion, error)
			}{
				{"ExecFile", ExecFile},
				{"ParseFileModuleVersion", ParseFileModuleVersion},
			} {
				t.Run(loader.name, func(t *testing.T) {
					module, err := loader.load(filename)
					if err != nil {
						t.Fatal(err)
					}
					// The frontend reads serialized module metadata, so check that the
					// protobuf descriptor preserves both commands and display source.
					data, err := proto.Marshal(module)
					if err != nil {
						t.Fatal(err)
					}
					module = new(bzpb.ModuleVersion)
					if err := proto.Unmarshal(data, module); err != nil {
						t.Fatal(err)
					}
					if len(module.GetDeps()) != 1 {
						t.Fatalf("len(deps) = %d, want 1", len(module.GetDeps()))
					}
					override := module.GetDeps()[0].GetOverride()
					var commands []string
					if kind == "single_version_override" {
						commands = override.GetSingleVersionOverride().GetPatchCmds()
					} else {
						commands = override.GetArchiveOverride().GetPatchCmds()
					}
					if !slices.Equal(commands, want) {
						t.Errorf("patch_cmds = %q, want %q", commands, want)
					}
					if loader.name == "ExecFile" {
						// Both UI override templates render this source verbatim.
						if got := override.GetCode(); got != code {
							t.Errorf("override display source = %q, want %q", got, code)
						}
						if len(module.GetOverride()) != 1 || module.GetOverride()[0].GetCode() != code {
							t.Error("module override display source was not preserved")
						}
					}
				})
			}
		})
	}
}

func TestGitOverrideStripPrefixFromFile(t *testing.T) {
	for _, prefix := range []string{"packages/dep", ""} {
		t.Run(fmt.Sprintf("strip_prefix=%q", prefix), func(t *testing.T) {
			const baseCode = "git_override(\n    module_name = \"dep\",\n    remote = \"https://example.com/monorepo.git\",\n    commit = \"abc123\",\n"
			code := baseCode
			if prefix != "" {
				code += fmt.Sprintf("    strip_prefix = %q,\n", prefix)
			}
			code += ")\n"
			src := "module(name = \"root\", version = \"1.0.0\")\nbazel_dep(name = \"dep\", version = \"1.2.3\")\n" + code
			filename := filepath.Join(t.TempDir(), "MODULE.bazel")
			if err := os.WriteFile(filename, []byte(src), 0o600); err != nil {
				t.Fatal(err)
			}
			for _, loader := range []struct {
				name string
				load func(string) (*bzpb.ModuleVersion, error)
			}{
				{"ExecFile", ExecFile},
				{"ParseFileModuleVersion", ParseFileModuleVersion},
			} {
				t.Run(loader.name, func(t *testing.T) {
					module, err := loader.load(filename)
					if err != nil {
						t.Fatal(err)
					}
					data, err := proto.Marshal(module)
					if err != nil {
						t.Fatal(err)
					}
					module = new(bzpb.ModuleVersion)
					if err := proto.Unmarshal(data, module); err != nil {
						t.Fatal(err)
					}
					if len(module.GetDeps()) != 1 {
						t.Fatalf("len(deps) = %d, want 1", len(module.GetDeps()))
					}
					override := module.GetDeps()[0].GetOverride()
					git := override.GetGitOverride()
					if git == nil {
						t.Fatal("dependency has no git override")
					}
					if got := git.GetStripPrefix(); got != prefix {
						t.Errorf("strip_prefix = %q, want %q", got, prefix)
					}
					if loader.name == "ExecFile" {
						if got := override.GetCode(); got != code {
							t.Errorf("override display source = %q, want %q", got, code)
						}
						if len(module.GetOverride()) != 1 || module.GetOverride()[0].GetCode() != code {
							t.Error("module override display source was not preserved")
						}
					}
				})
			}
		})
	}
}
