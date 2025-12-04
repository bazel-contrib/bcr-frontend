package bcr

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"maps"
	"path/filepath"
	"slices"
	"strings"

	"github.com/bazelbuild/bazel-gazelle/label"
	"github.com/bazelbuild/bazel-gazelle/rule"
	"github.com/bazelbuild/buildtools/build"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/modulebazel"
	"github.com/stackb/centrl/pkg/netutil"
)

const (
	starlarkRepositorySuffix             = ".bzl_srcs"
	starlarkRepositoryRootTargetName     = "bzl_srcs"
	binaryProtoRepositorySuffix          = ".binaryprotos"
	binaryProtosRepositoryRootTargetName = "files"
)

type versionedRule struct {
	version string
	rule    *rule.Rule
	label   label.Label
	rank    int
}

type moduleVersionRuleMap map[string][]*versionedRule

type checkItem struct {
	url        string
	moduleKeys []moduleKey
}

// trackDocsUrl keeps a list of rules that reference this doc URL.
func (ext *bcrExtension) trackDocsUrl(url string, modKey moduleKey) {
	if url == "" || strings.Contains(url, "{OWNER}") || strings.Contains(url, "{REPO}") || strings.Contains(url, "{TAG}") {
		return
	}
	ext.moduleKeysByDocUrl[url] = append(ext.moduleKeysByDocUrl[url], modKey)
}

func (ext *bcrExtension) trackSourceUrl(url string, modKey moduleKey) {
	if url == "" {
		return
	}
	ext.moduleKeysBySourceUrl[url] = append(ext.moduleKeysBySourceUrl[url], modKey)
}

// handleDocsUrlStatus processes a docs URL status and updates the repos map and rules
func (ext *bcrExtension) handleDocsUrlStatus(url string, moduleKeys []moduleKey, status netutil.URLStatus, repos map[label.Label]*rule.Rule, cached bool) {
	// Store status in the map for future caching
	ext.resourceStatusByUrl[url] = &bzpb.ResourceStatus{
		Url:     url,
		Code:    int32(status.Code),
		Message: status.Message,
	}

	if status.Exists() {
		httpArchiveLabel := makeBinaryProtoRepositoryLabel(url)
		docsHttpArchive := makeBinaryProtoRepository(httpArchiveLabel, url)
		repos[httpArchiveLabel] = docsHttpArchive
		for _, modKey := range moduleKeys {
			moduleSourceProtoRule := ext.moduleSourceRulesByModuleKey[modKey]
			// Update the module_source rule with status
			updateModuleSourceRuleDocsUrlStatus(moduleSourceProtoRule.Rule(), status)
			// Update the corresponding module_version rule with published_docs
			updateModuleVersionRulePublishedDocs(moduleSourceProtoRule, httpArchiveLabel, ext.moduleVersionRulesByModuleKey)
		}
	} else {
		cacheMsg := ""
		if cached {
			cacheMsg = " (cached)"
		}
		log.Printf("warning: docs URL does not exist%s: %s (status: %d %s)", cacheMsg, url, status.Code, status.Message)
		for _, modKey := range moduleKeys {
			moduleSourceProtoRule := ext.moduleSourceRulesByModuleKey[modKey]
			updateModuleSourceRuleDocsUrlStatus(moduleSourceProtoRule.Rule(), status)
			// No need to update module_version if docs don't exist
		}
	}
}

func (ext *bcrExtension) prepareBinaryprotoRepositories() []*rule.Rule {
	if len(ext.moduleKeysByDocUrl) == 0 {
		return nil
	}

	repos := make(map[label.Label]*rule.Rule)

	// Separate URLs into cached, blacklisted, and uncached
	// NOTE: http_archive rules for docs URLs are NOT subject to MVS filtering
	var uncachedItems []checkItem
	var cachedCount int
	var blacklistedCount int

	for url, moduleKeys := range ext.moduleKeysByDocUrl {
		if ext.blacklistedUrls[url] {
			// Skip blacklisted URLs
			blacklistedCount++
			log.Printf("Skipping blacklisted docs URL: %s", url)
			continue
		}

		if cachedStatus, found := ext.resourceStatusByUrl[url]; found {
			// Use cached status
			cachedCount++
			status := netutil.URLStatus{
				Code:    int(cachedStatus.Code),
				Message: cachedStatus.Message,
			}
			ext.handleDocsUrlStatus(url, moduleKeys, status, repos, true)
		} else {
			// Need to check this URL
			uncachedItems = append(uncachedItems, checkItem{url, moduleKeys})
		}
	}

	if cachedCount > 0 {
		log.Printf("Skipped %d cached docs URL checks", cachedCount)
	}
	if blacklistedCount > 0 {
		log.Printf("Skipped %d blacklisted docs URLs", blacklistedCount)
	}

	// Check uncached URLs in parallel and update rules with status
	if len(uncachedItems) > 0 {
		netutil.CheckURLsParallel("Checking http_archive URLs", uncachedItems, func(item checkItem) string { return item.url },
			func(item checkItem, status netutil.URLStatus) {
				ext.handleDocsUrlStatus(item.url, item.moduleKeys, status, repos, false)
			})
	}

	return slices.Collect(maps.Values(repos))
}

// handleSourceUrlStatus processes a source URL status and updates the repos map
// and rules
func (ext *bcrExtension) handleSourceUrlStatus(url string, moduleKeys []moduleKey, status netutil.URLStatus, repos moduleVersionRuleMap, cached bool) {
	// Store status in the map for future caching
	ext.resourceStatusByUrl[url] = &bzpb.ResourceStatus{
		Url:     url,
		Code:    int32(status.Code),
		Message: status.Message,
	}

	var moduleSourceProtoRule *protoRule[*bzpb.ModuleSource]
	for _, modKey := range moduleKeys {
		moduleSourceProtoRule = ext.moduleSourceRulesByModuleKey[modKey]
		updateModuleSourceRuleUrlStatus(moduleSourceProtoRule.Rule(), status)
	}

	if !status.Exists() {
		cacheMsg := ""
		if cached {
			cacheMsg = " (cached)"
		}
		log.Printf("warning: source URL does not exist%s: %s (status: %d %s)", cacheMsg, url, status.Code, status.Message)
		return
	}

	module := moduleSourceProtoRule.Rule().PrivateAttr(moduleVersionPrivateAttr).(*bzpb.ModuleVersion)
	source := moduleSourceProtoRule.Proto()
	lbl := makeStarlarkRepositoryLabel(module.Name, module.Version)
	rule := makeStarlarkRepository(lbl, source)
	repos[module.Name] = append(repos[module.Name], &versionedRule{version: module.Version, rule: rule, label: lbl})
	log.Printf("created starlark repository: %v (%s)", lbl, moduleSourceProtoRule.Rule().AttrString("url"))
}

func (ext *bcrExtension) prepareStarlarkRepositories() moduleVersionRuleMap {
	if len(ext.moduleKeysBySourceUrl) == 0 {
		return nil
	}

	repos := make(moduleVersionRuleMap)

	// Separate URLs into cached, blacklisted, MVS-filtered, bzl_srcs-filtered, and uncached
	var uncachedItems []checkItem
	var cachedCount int
	var unrequestedCount int
	var blacklistedCount int
	var bzlSrcsFilteredCount int

	for url, moduleKeys := range ext.moduleKeysBySourceUrl {
		if ext.blacklistedUrls[url] {
			// Skip blacklisted URLs
			blacklistedCount++
			log.Printf("Skipping blacklisted source URL: %s", url)
			continue
		}

		if cachedStatus, found := ext.resourceStatusByUrl[url]; found {
			// Use cached status
			cachedCount++
			status := netutil.URLStatus{
				Code:    int(cachedStatus.Code),
				Message: cachedStatus.Message,
			}
			ext.handleSourceUrlStatus(url, moduleKeys, status, repos, true)
		} else {
			// Need to check this URL
			uncachedItems = append(uncachedItems, checkItem{url, moduleKeys})
		}
	}

	if cachedCount > 0 {
		log.Printf("Skipped %d cached source URL checks", cachedCount)
	}
	if blacklistedCount > 0 {
		log.Printf("Skipped %d blacklisted source URLs", blacklistedCount)
	}
	if unrequestedCount > 0 {
		log.Printf("Skipped %d unused source URLs", unrequestedCount)
	}
	if bzlSrcsFilteredCount > 0 {
		log.Printf("Skipped %d source URLs (not referenced in any bzl_srcs)", bzlSrcsFilteredCount)
	}

	// Check uncached URLs in parallel and update rules with status
	if len(uncachedItems) > 0 {
		netutil.CheckURLsParallel("Checking source URLs", uncachedItems, func(item checkItem) string { return item.url },
			func(item checkItem, status netutil.URLStatus) {
				ext.handleSourceUrlStatus(item.url, item.moduleKeys, status, repos, false)
			})
	}

	return repos
}

// mergeModuleBazelFile updates the MODULE.bazel file with additional rules if
// needed.
func mergeModuleBazelFile(repoRoot string, binaryProtoHttpArchives []*rule.Rule, starlarkRepositories moduleVersionRuleMap) error {
	if len(binaryProtoHttpArchives) == 0 && len(starlarkRepositories) == 0 {
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
			if strings.HasSuffix(r.Name(), binaryProtoRepositorySuffix) {
				r.Delete()
				deletedRules++
			}
		case "starlark_repository.archive":
			if strings.HasSuffix(r.Name(), starlarkRepositorySuffix) {
				r.Delete()
				deletedRules++
			}
		}
	}
	f.Sync()
	log.Printf("cleaned up %d old rules", deletedRules)

	starlarkRepoNames := make([]build.Expr, 0, len(starlarkRepositories))
	for _, versions := range starlarkRepositories {
		for _, version := range versions {
			if version.rank > 0 {
				starlarkRepoNames = append(starlarkRepoNames, &build.StringExpr{Value: version.rule.Name()})
			}
		}
	}

	// update stmts
	for _, stmt := range f.File.Stmt {
		switch call := stmt.(type) {
		case *build.CallExpr:
			useRepo := getUseRepoCall(call, "starlark_repository")
			if useRepo != nil {
				useRepo.List = append([]build.Expr{useRepo.List[0] /* the starlark_repository module extension symbol */}, starlarkRepoNames...)
				call.ForceMultiLine = true
				log.Printf(`updated use_repo(starlark_repository") with %d names`, len(starlarkRepoNames))
				break
			}
		}
	}
	f.Sync()

	for _, r := range binaryProtoHttpArchives {
		r.Insert(f)
	}
	for _, versions := range starlarkRepositories {
		for _, version := range versions {
			if version.rank > 0 {
				version.rule.Insert(f)
			}
		}
	}
	f.Sync()

	log.Printf("added %d http_archive rules", len(binaryProtoHttpArchives))
	log.Printf("added %d starlark_repository rules", len(starlarkRepositories))

	log.Println("Updating:", filename)
	return f.Save(filename)
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

func sanitizeName(name string) string {
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "+", "_")
	return name
}

// makeBinaryProtoRepositoryName creates a named for the external workspace
func makeBinaryProtoRepositoryName(docUrl string) (name string) {
	name = strings.TrimPrefix(docUrl, "https://")
	name = strings.TrimSuffix(name, ".docs.tar.gz")
	name = sanitizeName(name)
	return name + binaryProtoRepositorySuffix
}

// makeBinaryProtoRepositoryLabel creates a label for external workspace
func makeBinaryProtoRepositoryLabel(docUrl string) label.Label {
	return label.New(makeBinaryProtoRepositoryName(docUrl), "", binaryProtosRepositoryRootTargetName)
}

func makeBinaryProtoRepository(from label.Label, docUrl string) *rule.Rule {
	r := rule.NewRule("http_archive", from.Repo)
	r.SetAttr("url", docUrl)
	r.SetAttr("build_file_content", fmt.Sprintf(`filegroup(name = "%s",
    srcs = glob(["**/*.binaryproto"]),
    visibility = ["//visibility:public"],
)`, from.Name))
	return r
}

// makeStarlarkRepositoryName creates a named for the external workspace
func makeStarlarkRepositoryName(moduleName, moduleVersion string) (name string) {
	return fmt.Sprintf("%s%s%s", moduleName, sanitizeName(moduleVersion), starlarkRepositorySuffix)
}

// makeStarlarkRepositoryLabel creates a label for a starlark_repository rule.
func makeStarlarkRepositoryLabel(moduleName, moduleVersion string) label.Label {
	repo := makeStarlarkRepositoryName(moduleName, moduleVersion)
	return label.New(repo, "", starlarkRepositoryRootTargetName)
}

func makeStarlarkRepository(from label.Label, source *bzpb.ModuleSource) *rule.Rule {
	r := rule.NewRule("starlark_repository.archive", from.Repo)
	r.SetAttr("urls", []string{source.Url})
	r.SetAttr("type", getArchiveTypeOrDefault(source.Url, "tar.gz"))

	if source.StripPrefix != "" {
		r.SetAttr("strip_prefix", source.StripPrefix)
	}
	if source.Integrity != "" && strings.HasPrefix(source.Url, "http:") {
		if sha256, ok := getSha256Integrity(source.Integrity); ok {
			r.SetAttr("sha256", sha256)
		}
	}
	r.SetAttr("build_file_generation", "clean")
	r.SetAttr("languages", []string{"starlarklibrary"})

	directives := []string{
		// fmt.Sprintf("gazelle:starlarklibrary_log_file %s/starlark_repository-gazelle.%s-%s.log", repoRoot, module.Name, module.Version),
		"gazelle:starlarklibrary_root",
	}

	r.SetAttr("build_directives", directives)

	return r
}

// getArchiveTypeOrDefault retuns a default if the url extension is not one of
// the ones recognized by http_archive.
func getArchiveTypeOrDefault(sourceUrl, defaultType string) string {
	// see https://bazel.build/rules/lib/repo/http#http_archive
	allowedTypes := []string{
		".zip", ".jar", ".war", ".aar", ".tar", ".tar.gz", ".tgz",
		".tar.xz", ".txz", ".tar.zst", ".tzst", ".tar.bz2", ".ar", ".deb", ".7z",
	}

	// Try matching from longest to shortest to handle multi-part extensions like .tar.gz
	for _, ext := range allowedTypes {
		if strings.HasSuffix(sourceUrl, ext) {
			// Return without the leading dot
			return strings.TrimPrefix(ext, ".")
		}
	}

	// Default to tar.gz if no recognized extension
	return defaultType
}

func getSha256Integrity(integrity string) (string, bool) {
	// example:
	// integrity = "sha256-ShAT7rtQ9yj8YBvdgzsLKHAzPDs+WoFu66kh2VvsbxU=",

	if !strings.HasPrefix(integrity, "sha256-") {
		return "", false
	}

	// Remove the "sha256-" prefix
	b64Hash := strings.TrimPrefix(integrity, "sha256-")

	// Decode from base64
	hashBytes, err := base64.StdEncoding.DecodeString(b64Hash)
	if err != nil {
		return "", false
	}

	// Convert to hex string
	return hex.EncodeToString(hashBytes), true
}
