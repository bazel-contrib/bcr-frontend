package bcr

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/label"
	"github.com/bazelbuild/bazel-gazelle/rule"
	"github.com/bazelbuild/buildtools/build"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/modulebazel"
)

// trackDocsUrl adds a doc URL to be included in the root MODULE.bazel file and
// returns the label by which is can be included
func (ext *bcrExtension) trackDocsUrl(docUrl string) label.Label {
	if strings.Contains(docUrl, "{OWNER}") || strings.Contains(docUrl, "{REPO}") || strings.Contains(docUrl, "{TAG}") {
		return label.NoLabel
	}

	from := makeDocsHttpArchiveLabel(docUrl)
	httpArchive := makeDocsHttpArchive(from, docUrl)
	ext.httpArchives[from] = httpArchive

	return from
}

func (ext *bcrExtension) trackDocsBundle(module *bzpb.ModuleVersion, source *bzpb.ModuleSource) label.Label {
	from := makeDocsStarlarkRepositoryLabel(module.Name, module.Version)
	starlarkRepository := makeDocsStarlarkRepository(ext.repoRoot, module, from, source, makeEffectiveModuleDeps(module))
	ext.starlarkRepositories[from] = starlarkRepository

	return from
}

// mergeModuleBazelFile updates the MODULE.bazel file with additional rules if
// needed.
func (ext *bcrExtension) mergeModuleBazelFile(repoRoot string) error {
	if len(ext.httpArchives) == 0 && len(ext.starlarkRepositories) == 0 {
		return nil
	}

	filename := filepath.Join(repoRoot, "MODULE.bazel")
	f, err := modulebazel.LoadFile(filename, "")
	if err != nil {
		return fmt.Errorf("parsing: %v", err)
	}

	// clean old rules
	deletedRules := 0
	for _, r := range f.Rules {
		switch r.Kind() {
		case "http_archive":
			if strings.HasSuffix(r.AttrString("url"), ".docs.tar.gz") {
				r.Delete()
				deletedRules++
			}
		case "starlark_repository.archive":
			if strings.HasSuffix(r.Name(), "_docs") {
				r.Delete()
				deletedRules++
			}
		}
	}
	f.Sync()
	log.Printf("cleaned up %d old rules", deletedRules)

	starlarkRepositoryNames := make([]build.Expr, 0, len(ext.starlarkRepositories))
	for lbl := range ext.starlarkRepositories {
		starlarkRepositoryNames = append(starlarkRepositoryNames, &build.StringExpr{Value: lbl.Repo})
	}

	// update stmts
	for _, stmt := range f.File.Stmt {
		switch call := stmt.(type) {
		case *build.CallExpr:
			useRepo := getUseRepoCall(call, "starlark_repository")
			if useRepo != nil {
				useRepo.List = append([]build.Expr{useRepo.List[0]}, starlarkRepositoryNames...)
				call.ForceMultiLine = true
				log.Printf(`updated use_repo(starlark_repository") with %d names (%d)`, len(starlarkRepositoryNames), len(ext.starlarkRepositories))
				break
			}
		}
	}
	f.Sync()

	for _, r := range ext.httpArchives {
		r.Insert(f)
	}
	for _, r := range ext.starlarkRepositories {
		r.Insert(f)
	}
	f.Sync()

	log.Printf("added %d http_archive{s}", len(ext.httpArchives))
	log.Printf("added %d starlark_repositor{y|ies}", len(ext.starlarkRepositories))

	data := f.Format()
	os.WriteFile(filename, data, 0744)

	log.Println("Updated:", filename)
	return nil
}

func getUseRepoCall(call *build.CallExpr, name string) *build.CallExpr {
	if callName, ok := call.X.(*build.Ident); ok {
		if callName.Name == "use_repo" {
			if len(call.List) > 0 {
				if extName, ok := call.List[0].(*build.Ident); ok {
					if extName.Name == name {
						return call
					}
				}
			}
		}
	}
	return nil
}

// makeDocsHttpArchiveLabel creates a label for external workspace
func makeDocsHttpArchiveLabel(docUrl string) label.Label {
	return label.New(makeDocsHttpArchiveRepoName(docUrl), "", "files")
}

// makeDocsStarlarkRepositoryLabel creates a label for a starlark_repository
// rule.
func makeDocsStarlarkRepositoryLabel(moduleName, moduleVersion string) label.Label {
	repo := makeDocsStarlarkRepositoryRepoName(moduleName, moduleVersion)
	return label.New(repo, "", "starlark_bundle")
}

// makeDocsHttpArchiveRepoName creates a named for the external workspace
func makeDocsStarlarkRepositoryRepoName(moduleName, moduleVersion string) (name string) {
	return fmt.Sprintf("%s_%s_docs", moduleName, sanitizeName(moduleVersion))
}

func sanitizeName(name string) string {
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "+", "_")
	return name
}

// makeDocsHttpArchiveRepoName creates a named for the external workspace
func makeDocsHttpArchiveRepoName(docUrl string) (name string) {
	name = strings.TrimSuffix(docUrl, ".docs.tar.gz")
	name = strings.TrimPrefix(name, "https://")
	name = sanitizeName(name)
	return name
}

func makeDocsHttpArchive(from label.Label, docUrl string) *rule.Rule {
	r := rule.NewRule("http_archive", from.Repo)
	r.SetAttr("url", docUrl)
	r.SetAttr("build_file_content", fmt.Sprintf(`filegroup(name = "%s",
    srcs = glob(["**/*.binaryproto"]),
    visibility = ["//visibility:public"],
)`, from.Name))
	return r
}

func makeDocsStarlarkRepository(repoRoot string, module *bzpb.ModuleVersion, from label.Label, source *bzpb.ModuleSource, deps map[string]string) *rule.Rule {
	r := rule.NewRule("starlark_repository.archive", from.Repo)
	r.SetAttr("urls", []string{source.Url})
	if source.StripPrefix != "" {
		r.SetAttr("strip_prefix", source.StripPrefix)
	}
	// TODO: translate integrity to sha256 if possible
	// if source.Integrity != "" {
	// 	r.SetAttr("integity", source.Integrity)
	// }
	r.SetAttr("build_file_generation", "clean")
	r.SetAttr("languages", []string{"starlark_bundle"})
	// r.SetAttr("args", []string{
	// 	fmt.Sprintf("--starlark_bundle_log=%s/starlark_repository-gazelle.%s-%s.log", repoRoot, module.Name, module.Version),
	// })

	directives := []string{
		fmt.Sprintf("gazelle:starlark_bundle_log_file %s/starlark_repository-gazelle.%s-%s.log", repoRoot, module.Name, module.Version),
		"gazelle:starlark_bundle_root",
		fmt.Sprintf("gazelle:module_dependency %s %s", module.Name, makeDocsStarlarkRepositoryRepoName(module.Name, module.Version)),
	}

	depNames := make([]string, 0, len(deps))
	for depName := range deps {
		depNames = append(depNames, depName)
	}
	sort.Strings(depNames)

	for _, name := range depNames {
		version := deps[name]
		directives = append(directives, fmt.Sprintf("gazelle:module_dependency %s %s", name, version))
	}
	r.SetAttr("build_directives", directives)

	return r
}

func makeEffectiveModuleDeps(module *bzpb.ModuleVersion) map[string]string {
	deps := make(map[string]string)
	for _, dep := range module.Deps {
		repoName := dep.Name
		if dep.RepoName != "" {
			repoName = dep.RepoName
		}
		deps[repoName] = makeDocsStarlarkRepositoryRepoName(dep.Name, dep.Version)
	}
	return deps
}
