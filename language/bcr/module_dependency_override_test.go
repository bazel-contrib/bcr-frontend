package bcr

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/modulebazel"
	"github.com/bazelbuild/bazel-gazelle/rule"
)

func TestMakeRegistryOverrideRules(t *testing.T) {
	t.Run("single version", func(t *testing.T) {
		r := makeOverrideRule("dep", &bzpb.ModuleDependencyOverride{
			Override: &bzpb.ModuleDependencyOverride_SingleVersionOverride{
				SingleVersionOverride: &bzpb.SingleVersionOverride{
					Version:   "1.2.3",
					Registry:  "https://registry.example/modules",
					PatchCmds: []string{"echo patched", "touch patched.txt"},
				},
			},
		})
		if r == nil {
			t.Fatal("makeOverrideRule() = nil")
		}
		if got, want := r.Kind(), "single_version_override"; got != want {
			t.Errorf("kind = %q, want %q", got, want)
		}
		if got, want := r.AttrString("registry"), "https://registry.example/modules"; got != want {
			t.Errorf("registry = %q, want %q", got, want)
		}
		commands := r.AttrStrings("patch_cmds")
		if got, want := len(commands), 2; got != want {
			t.Fatalf("len(patch_cmds) = %d, want %d", got, want)
		}
		if commands[0] != "echo patched" || commands[1] != "touch patched.txt" {
			t.Errorf("patch_cmds = %q, want [echo patched touch patched.txt]", commands)
		}
	})

	t.Run("multiple version", func(t *testing.T) {
		r := makeOverrideRule("dep", &bzpb.ModuleDependencyOverride{
			Override: &bzpb.ModuleDependencyOverride_MultipleVersionOverride{
				MultipleVersionOverride: &bzpb.MultipleVersionOverride{
					Versions: []string{"1.2.3", "2.0.0"},
					Registry: "https://registry.example/modules",
				},
			},
		})
		if r == nil {
			t.Fatal("makeOverrideRule() = nil")
		}
		if got, want := r.Kind(), "multiple_version_override"; got != want {
			t.Errorf("kind = %q, want %q", got, want)
		}
		if got, want := r.AttrString("registry"), "https://registry.example/modules"; got != want {
			t.Errorf("registry = %q, want %q", got, want)
		}
		versions := r.AttrStrings("versions")
		if got, want := len(versions), 2; got != want {
			t.Fatalf("len(versions) = %d, want %d", got, want)
		}
		if got, want := versions[1], "2.0.0"; got != want {
			t.Errorf("versions[1] = %q, want %q", got, want)
		}
	})
}

func TestModuleOverridePatchCmdsGeneratedBuild(t *testing.T) {
	want := []string{`echo "patched"`, `printf 'line1\nline2\n' > patched.txt`}
	for _, kind := range []string{"single_version_override", "archive_override"} {
		t.Run(kind, func(t *testing.T) {
			src := fmt.Sprintf(`
module(name = "root", version = "1.0.0")
bazel_dep(name = "dep", version = "1.2.3")
%s(module_name = "dep", patch_cmds = [%q, %q])
`, kind, want[0], want[1])
			filename := filepath.Join(t.TempDir(), "MODULE.bazel")
			if err := os.WriteFile(filename, []byte(src), 0o600); err != nil {
				t.Fatal(err)
			}
			module, err := modulebazel.ExecFile(filename)
			if err != nil {
				t.Fatal(err)
			}
			deps, overrides := makeModuleDependencyRules(module.GetDeps())
			if len(deps) != 1 || len(overrides) != 1 {
				t.Fatalf("generated %d dependencies and %d overrides, want 1 each", len(deps), len(overrides))
			}
			if got := deps[0].AttrString("override"); got != ":dep_override" {
				t.Errorf("dependency override = %q, want :dep_override", got)
			}
			file := rule.EmptyFile("BUILD.bazel", "")
			overrides[0].Insert(file)
			// Parse the formatted BUILD file to verify command order and quoting
			// survive Gazelle's output, rather than just checking the rule object.
			generated, err := rule.LoadData("BUILD.bazel", "", file.Format())
			if err != nil {
				t.Fatal(err)
			}
			if len(generated.Rules) != 1 || generated.Rules[0].Kind() != kind {
				t.Fatalf("unexpected generated BUILD file: %s", file.Format())
			}
			if got := generated.Rules[0].AttrStrings("patch_cmds"); !slices.Equal(got, want) {
				t.Errorf("generated patch_cmds = %q, want %q", got, want)
			}
		})
	}
}

func TestGitOverrideStripPrefixGeneratedBuild(t *testing.T) {
	const src = `
module(name = "root", version = "1.0.0")
bazel_dep(name = "dep", version = "1.2.3")
git_override(
    module_name = "dep",
    remote = "https://example.com/monorepo.git",
    commit = "abc123",
    strip_prefix = "packages/dep",
)
`
	filename := filepath.Join(t.TempDir(), "MODULE.bazel")
	if err := os.WriteFile(filename, []byte(src), 0o600); err != nil {
		t.Fatal(err)
	}
	module, err := modulebazel.ExecFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	deps, overrides := makeModuleDependencyRules(module.GetDeps())
	if len(deps) != 1 || len(overrides) != 1 {
		t.Fatalf("generated %d dependencies and %d overrides, want 1 each", len(deps), len(overrides))
	}
	if got := deps[0].AttrString("override"); got != ":dep_override" {
		t.Errorf("dependency override = %q, want :dep_override", got)
	}
	file := rule.EmptyFile("BUILD.bazel", "")
	deps[0].Insert(file)
	overrides[0].Insert(file)
	generated, err := rule.LoadData("BUILD.bazel", "", file.Format())
	if err != nil {
		t.Fatal(err)
	}
	if len(generated.Rules) != 2 || generated.Rules[1].Kind() != "git_override" {
		t.Fatalf("unexpected generated BUILD file: %s", file.Format())
	}
	if got := generated.Rules[1].AttrString("strip_prefix"); got != "packages/dep" {
		t.Errorf("generated strip_prefix = %q, want packages/dep", got)
	}
}
