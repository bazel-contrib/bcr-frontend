package bcr

import (
	"testing"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
)

func TestMakeRegistryOverrideRules(t *testing.T) {
	t.Run("single version", func(t *testing.T) {
		r := makeOverrideRule("dep", &bzpb.ModuleDependencyOverride{
			Override: &bzpb.ModuleDependencyOverride_SingleVersionOverride{
				SingleVersionOverride: &bzpb.SingleVersionOverride{
					Version:  "1.2.3",
					Registry: "https://registry.example/modules",
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
