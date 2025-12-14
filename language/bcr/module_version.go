package bcr

import (
	"fmt"
	"log"
	"slices"

	"github.com/bazelbuild/bazel-gazelle/label"
	"github.com/bazelbuild/bazel-gazelle/resolve"
	"github.com/bazelbuild/bazel-gazelle/rule"
	"github.com/bazelbuild/buildtools/build"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

const (
	moduleVersionKind          = "module_version"
	isLatestVersionPrivateAttr = "_is_latest_version"
)

// moduleVersionLoadInfo returns load info for the module_version rule
func moduleVersionLoadInfo() rule.LoadInfo {
	return rule.LoadInfo{
		Name:    "//rules:module_version.bzl",
		Symbols: []string{moduleVersionKind},
	}
}

// moduleVersionKinds returns kind info for the module_version rule
func moduleVersionKinds() map[string]rule.KindInfo {
	return map[string]rule.KindInfo{
		moduleVersionKind: {
			MatchAny: true,
			ResolveAttrs: map[string]bool{
				"deps":         true,
				"source":       true,
				"attestations": true,
				"presubmit":    true,
				"commit":       true,
			},
		},
	}
}

// makeModuleVersionRule creates a module_version rule from parsed MODULE.bazel data
func makeModuleVersionRule(module *bzpb.ModuleVersion, version string, depRules []*rule.Rule, sourceRule *rule.Rule, attestationsRule *rule.Rule, presubmitRule *rule.Rule, commitRule *rule.Rule, moduleBazelFile string) *rule.Rule {
	r := rule.NewRule(moduleVersionKind, version)

	if module.Name != "" {
		r.SetAttr("module_name", module.Name)
	}
	if version != "" {
		r.SetAttr("version", version)
	}
	if module.CompatibilityLevel != 0 {
		r.SetAttr("compatibility_level", int(module.CompatibilityLevel))
	}
	if len(module.BazelCompatibility) > 0 {
		r.SetAttr("bazel_compatibility", module.BazelCompatibility)
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
	if presubmitRule != nil {
		r.SetAttr("presubmit", fmt.Sprintf(":%s", presubmitRule.Name()))
	}
	if commitRule != nil {
		r.SetAttr("commit", fmt.Sprintf(":%s", commitRule.Name()))
	}
	if moduleBazelFile != "" {
		r.SetAttr("module_bazel", moduleBazelFile)
	}
	r.SetAttr("build_bazel", ":BUILD.bazel")
	r.SetAttr("visibility", []string{"//visibility:public"})

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
		Lang: bcrLangName,
		Imp:  newModuleID(moduleName, version).String(),
	}

	return []resolve.ImportSpec{importSpec}
}

func resolveModuleVersionRule(r *rule.Rule, moduleRules map[moduleName]*protoRule[*bzpb.ModuleMetadata]) {
	moduleName := moduleName(r.AttrString("module_name"))
	moduleVersion := moduleVersion(r.AttrString("version"))

	if protoRule, ok := moduleRules[moduleName]; !ok {
		// https://github.com/bazelbuild/bazel-central-registry/tree/8c5761038905a45f1cf2d1098ba9917a456d20bb/modules/postgres/14.18
		log.Printf("WARN: while resolving latest versions, discovered unknown module: %v", moduleName)
	} else {
		versions := protoRule.Proto().Versions

		// latest version is expected to be the last element in the list
		if len(versions) > 0 && versions[len(versions)-1] == string(moduleVersion) {
			r.SetAttr("is_latest_version", true)
			r.SetPrivateAttr(isLatestVersionPrivateAttr, true)
		}
	}
}

// updateModuleVersionRulePublishedDocs sets the published_docs attribute on the
// module_version rule corresponding to the given module_source rule
func updateModuleVersionRulePublishedDocs(moduleSource *protoRule[*bzpb.ModuleSource], httpArchiveLabel label.Label, moduleVersions map[moduleID]*protoRule[*bzpb.ModuleVersion]) {
	// Get the module@version from the module_source rule's private attr
	module := moduleSource.Rule().PrivateAttr(moduleVersionPrivateAttr).(*bzpb.ModuleVersion)

	// Look up the corresponding module_version rule using ext.moduleVersions map
	id := newModuleID(module.Name, module.Version)
	if protoRule, exists := moduleVersions[id]; exists {
		// Set the published_docs attribute as a label_list
		if httpArchiveLabel != label.NoLabel {
			protoRule.Rule().SetAttr("published_docs", []string{httpArchiveLabel.String()})
		}
	} else {
		log.Panicf("BUG: not module version found for %s", id)
	}
}

func updateModuleVersionRuleMvsAttr(moduleVersions map[moduleID]*protoRule[*bzpb.ModuleVersion], attrName string, perModuleVersionMvs mvs) (annotatedCount int) {
	for id, mvs := range perModuleVersionMvs {
		// Find the corresponding module_version rule
		protoRule, exists := moduleVersions[id]
		if !exists {
			continue
		}

		// Extract root module name and version to exclude from mvs attribute
		rootModuleName := id.name()

		// Remove root module from the mvs dict (we only want dependencies)
		mvsWithoutRoot := make(moduleDeps)
		for moduleName, version := range mvs {
			if moduleName != rootModuleName {
				mvsWithoutRoot[moduleName] = version
			}
		}

		// Set the "mvs" attribute as a dict (without root module)
		if len(mvsWithoutRoot) > 0 {
			protoRule.Rule().SetAttr(attrName, mvsWithoutRoot.ToStringDict())
			annotatedCount++
		}
	}

	return
}

func isLatestVersion(moduleVersionRule *protoRule[*bzpb.ModuleVersion]) bool {
	isLatest, ok := moduleVersionRule.Rule().PrivateAttr(isLatestVersionPrivateAttr).(bool)
	return ok && isLatest
}

// makeBzlSrcSelectExpr creates a select expression for the bzl_src attribute (single label)
//
//	Returns: select({
//	    "//app/bcr:is_docs_release": "label",
//	    "//conditions:default": None,
//	})
func makeBzlSrcSelectExpr(label string) *build.CallExpr {
	return &build.CallExpr{
		X: &build.Ident{Name: "select"},
		List: []build.Expr{
			&build.DictExpr{
				List: []*build.KeyValueExpr{
					{
						Key:   &build.StringExpr{Value: "//app/bcr:is_docs_release"},
						Value: &build.StringExpr{Value: label},
					},
					{
						Key:   &build.StringExpr{Value: "//conditions:default"},
						Value: &build.Ident{Name: "None"},
					},
				},
			},
		},
	}
}

// makeBzlDepsSelectExpr creates a select expression for the bzl_deps attribute (list of labels)
//
//	Returns: select({
//	    "//app/bcr:is_docs_release": [labels...],
//	    "//conditions:default": [],
//	})
func makeBzlDepsSelectExpr(labels []string) *build.CallExpr {
	// Sort labels for consistent output
	sortedLabels := make([]string, len(labels))
	copy(sortedLabels, labels)
	slices.Sort(sortedLabels)

	// Create list of label string expressions
	labelExprs := make([]build.Expr, 0, len(sortedLabels))
	for _, lbl := range sortedLabels {
		labelExprs = append(labelExprs, &build.StringExpr{Value: lbl})
	}

	return &build.CallExpr{
		X: &build.Ident{Name: "select"},
		List: []build.Expr{
			&build.DictExpr{
				List: []*build.KeyValueExpr{
					{
						Key: &build.StringExpr{Value: "//app/bcr:is_docs_release"},
						Value: &build.ListExpr{
							List: labelExprs,
						},
					},
					{
						Key:   &build.StringExpr{Value: "//conditions:default"},
						Value: &build.ListExpr{List: []build.Expr{}},
					},
				},
			},
		},
	}
}
