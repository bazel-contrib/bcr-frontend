package bcr

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"maps"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/modulebazel"
	"github.com/bazel-contrib/bcr-frontend/pkg/netutil"
	"github.com/bazelbuild/bazel-gazelle/label"
	"github.com/bazelbuild/bazel-gazelle/rule"
	"github.com/bazelbuild/buildtools/build"
)

const (
	debugBzlRepositoryResolution          = false
	binaryProtoRepositorySuffix           = ".binaryprotos"
	binaryProtosRepositoryRootTargetName  = "files"
	bzlRepositoryModulesName              = "modules"
	bzlRepositoryPackagesName             = "starlark_packages"
	bzlRepositoryPrefix                   = "bzl."
	httpArchiveKind                       = "http_archive"
	starlarkRepositoryArchiveKind         = "starlark_repository.archive"
	starlarkRepositoryLocalKind           = "starlark_repository.local"
	starlarkRepositoryModuleExtensionName = "starlark_repository"
	starlarkRepositoryLanguageName        = "starlarkrepository"
)

// rankedVersion represents a module version that has been ranked by the MVS algorithm.
// The rank indicates priority for documentation generation - higher ranks are selected
// when multiple versions of the same module are available. A rank of 0 means the version
// is not selected for documentation.
type rankedVersion struct {
	version                    moduleVersion                     // semver version string
	bzlRepositoryLabel         label.Label                       // label of the starlark_repository :modules target
	bzlRepositoryPackagesLabel label.Label                       // label of the starlark_repository :packages target
	bzlRepositoryRule          *rule.Rule                        // the starlark_repository rule itself
	source                     *protoRule[*bzpb.ModuleVersion]   // source module version proto
	deps                       []*protoRule[*bzpb.ModuleVersion] // dependency module version protos
	rank                       int                               // MVS rank (0 = not selected, >0 = selected)
}

// rankedModuleVersionMap maps module names to their ranked versions.
// Used to track which module versions should have documentation generated based on MVS.
type rankedModuleVersionMap map[moduleName][]*rankedVersion

// checkItem groups a URL with the module IDs that reference it.
// Used for batching URL status checks to avoid duplicate network requests.
type checkItem struct {
	url       string     // URL to check (docs or source)
	moduleIDs []moduleID // modules that reference this URL
}

// trackDocsUrl keeps a list of rules that reference this doc URL.
func (ext *bcrExtension) trackDocsUrl(url string, id moduleID) {
	if url == "" || strings.Contains(url, "{OWNER}") || strings.Contains(url, "{REPO}") || strings.Contains(url, "{TAG}") {
		return
	}
	ext.moduleIDsByDocUrl[url] = append(ext.moduleIDsByDocUrl[url], id)
}

func (ext *bcrExtension) trackSourceUrl(url string, id moduleID) {
	if url == "" {
		return
	}
	ext.moduleIDsBySourceUrl[url] = append(ext.moduleIDsBySourceUrl[url], id)
}

// handleDocsUrlStatus processes a docs URL status and updates the repos map and rules
func (ext *bcrExtension) handleDocsUrlStatus(url string, moduleIDs []moduleID, status netutil.URLStatus, repos map[label.Label]*rule.Rule, cached bool) {
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
		for _, id := range moduleIDs {
			moduleSourceProtoRule := ext.moduleSourceRules[id]
			// Update the module_source rule with status
			updateModuleSourceRuleDocsUrlStatus(moduleSourceProtoRule.Rule(), status)
			// Update the corresponding module_version rule with published_docs
			updateModuleVersionRulePublishedDocs(moduleSourceProtoRule, httpArchiveLabel, ext.moduleVersionRules)
		}
	} else {
		cacheMsg := ""
		if cached {
			cacheMsg = " (cached)"
		}
		log.Printf("warning: docs URL does not exist%s: %s (status: %d %s)", cacheMsg, url, status.Code, status.Message)
		for _, id := range moduleIDs {
			moduleSourceProtoRule := ext.moduleSourceRules[id]
			updateModuleSourceRuleDocsUrlStatus(moduleSourceProtoRule.Rule(), status)
			// No need to update module_version if docs don't exist
		}
	}
}

func (ext *bcrExtension) prepareBinaryprotoRepositories() []*rule.Rule {
	if len(ext.moduleIDsByDocUrl) == 0 {
		return nil
	}

	repos := make(map[label.Label]*rule.Rule)

	// Separate URLs into cached, blacklisted, and uncached
	// NOTE: http_archive rules for docs URLs are NOT subject to MVS filtering
	var uncachedItems []checkItem
	var cachedCount int
	var blacklistedCount int

	for url, moduleIDs := range ext.moduleIDsByDocUrl {
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
			ext.handleDocsUrlStatus(url, moduleIDs, status, repos, true)
		} else {
			// Need to check this URL
			uncachedItems = append(uncachedItems, checkItem{url, moduleIDs})
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
				ext.handleDocsUrlStatus(item.url, item.moduleIDs, status, repos, false)
			})
	}

	return slices.Collect(maps.Values(repos))
}

// handleSourceUrlStatus processes a source URL status and updates the repos map
// and rules
func (ext *bcrExtension) handleSourceUrlStatus(url string, moduleIDs []moduleID, status netutil.URLStatus, versions rankedModuleVersionMap, cached bool) {
	// Store status in the map for future caching
	ext.resourceStatusByUrl[url] = &bzpb.ResourceStatus{
		Url:     url,
		Code:    int32(status.Code),
		Message: status.Message,
	}

	var moduleSourceProtoRule *protoRule[*bzpb.ModuleSource]
	for _, id := range moduleIDs {
		moduleSourceProtoRule = ext.moduleSourceRules[id]
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
	lbl := makeBzlRepositoryModulesLabel(module.Name, module.Version)
	pkgLbl := makeBzlRepositoryPackagesLabel(module.Name, module.Version)
	// If BCR declares overlay files for this module-version, the upstream
	// tarball is insufficient (overlay typically supplies BUILD/MODULE/.bzl
	// files missing from upstream). Point at the on-disk overlay directly via
	// .local — we avoid downloading the upstream archive at all in that case.
	var bzlRule *rule.Rule
	if len(source.Overlay) > 0 && ext.registryRoot != "" {
		bzlRule = makeOverlayBzlRepository(lbl, module.Name, module.Version, ext.registryRoot)
	} else {
		bzlRule = makeBzlRepository(lbl, module, source)
	}
	name := moduleName(module.Name)
	version := moduleVersion(module.Version)
	versions[name] = append(versions[name], &rankedVersion{
		version:                    version,
		bzlRepositoryRule:          bzlRule,
		bzlRepositoryLabel:         lbl,
		bzlRepositoryPackagesLabel: pkgLbl,
	})
}

func (ext *bcrExtension) prepareBzlRepositories() rankedModuleVersionMap {
	if len(ext.moduleIDsBySourceUrl) == 0 {
		return nil
	}

	versions := make(rankedModuleVersionMap)

	// Separate URLs into cached, blacklisted, backup, and uncached
	var uncachedItems []checkItem
	var cachedCount int
	var backupCount int
	var unrequestedCount int
	var blacklistedCount int
	var bzlSrcsFilteredCount int

	for url, moduleIDs := range ext.moduleIDsBySourceUrl {
		if ext.blacklistedUrls[url] {
			// Skip blacklisted URLs
			blacklistedCount++
			log.Printf("Skipping blacklisted source URL: %s", url)
			continue
		}

		// Priority 1: Check local cache
		if cachedStatus, found := ext.resourceStatusByUrl[url]; found {
			cachedCount++
			status := netutil.URLStatus{
				Code:    int(cachedStatus.Code),
				Message: cachedStatus.Message,
			}
			ext.handleSourceUrlStatus(url, moduleIDs, status, versions, true)
			continue
		}

		// Priority 2: Check backup registry
		if backupStatus := ext.getBackupSourceUrlStatus(url); backupStatus != nil {
			backupCount++
			status := netutil.URLStatus{
				Code:    int(backupStatus.Code),
				Message: backupStatus.Message,
			}
			ext.handleSourceUrlStatus(url, moduleIDs, status, versions, true)
			continue
		}

		// Priority 3: Need to check this URL via HTTP
		uncachedItems = append(uncachedItems, checkItem{url, moduleIDs})
	}

	if cachedCount > 0 {
		log.Printf("Skipped %d cached source URL checks", cachedCount)
	}
	if backupCount > 0 {
		log.Printf("Retrieved %d source URL statuses from backup registry", backupCount)
	}
	if blacklistedCount > 0 {
		log.Printf("Skipped %d blacklisted source URLs", blacklistedCount)
	}
	if unrequestedCount > 0 {
		log.Printf("Skipped %d unused source URLs", unrequestedCount)
	}
	if bzlSrcsFilteredCount > 0 {
		log.Printf("Skipped %d source URLs (not referenced in any bzl_src)", bzlSrcsFilteredCount)
	}

	// Check uncached URLs in parallel and update rules with status
	if len(uncachedItems) > 0 {
		netutil.CheckURLsParallel("Checking source URLs", uncachedItems, func(item checkItem) string { return item.url },
			func(item checkItem, status netutil.URLStatus) {
				ext.handleSourceUrlStatus(item.url, item.moduleIDs, status, versions, false)
			})
	}

	return versions
}

func (ext *bcrExtension) rankBzlRepositoryVersions(perModuleVersionMvs mvs, bzlRepositories rankedModuleVersionMap) {
	for id, mvs := range perModuleVersionMvs {
		ext.rankBzlRepositoryVersionsForModule(id, mvs, bzlRepositories)
	}
}

func (ext *bcrExtension) rankBzlRepositoryVersionsForModule(id moduleID, deps moduleDeps, bzlRepositories rankedModuleVersionMap) {
	moduleVersionRule, exists := ext.moduleVersionRules[id]
	if !exists {
		return
	}
	// When docs-all-versions is off, only process latest versions
	if !ext.docsAllVersions && !isLatestVersion(moduleVersionRule) {
		return
	}
	// When docs-module-filter is set, skip modules that don't match any prefix
	if ext.docsModuleFilter != "" && !ext.matchesModuleFilter(id.name()) {
		return
	}
	// Skip versions that already have docs on the site repo
	if ext.existingDocs[id] {
		return
	}

	rootModuleName := id.name()
	rootModuleVersion := id.version()

	for moduleName, version := range deps {
		moduleMetadataProtoRule, exists := ext.moduleMetadataRules[rootModuleName]
		if !exists {
			return
		}
		// Generate docs if the module's upstream repo advertises Starlark, OR
		// (as a fallback) if BCR declares overlay files for this version
		// (which typically supply BUILD/MODULE/.bzl content missing upstream).
		sourceProtoRule, hasSource := ext.moduleSourceRules[id]
		hasOverlay := hasSource && len(sourceProtoRule.Proto().Overlay) > 0
		if !isStarlarkCandidate(moduleMetadataProtoRule.Rule(), ext.repositoriesMetadataByID) &&
			!hasOverlay {
			continue
		}

		metadata := moduleMetadataProtoRule.Proto()

		if moduleName == rootModuleName && version == rootModuleVersion {
			// This is the root module → bzl_src (single label)
			selectVersion(moduleVersionRule, version, true, bzlRepositories[moduleName], metadata)
		} else {
			// This is a dependency → bzl_deps (list)
			selectVersion(moduleVersionRule, version, false, bzlRepositories[moduleName], metadata)
		}
	}

}

// matchesModuleFilter returns true if the module name matches any of the
// comma-separated prefixes in the docs-module-filter flag.
func (ext *bcrExtension) matchesModuleFilter(name moduleName) bool {
	for _, prefix := range strings.Split(ext.docsModuleFilter, ",") {
		prefix = strings.TrimSpace(prefix)
		if prefix != "" && strings.HasPrefix(string(name), prefix) {
			return true
		}
	}
	return false
}

func (ext *bcrExtension) finalizeBzlSrcsAndDeps(bzlRepositories rankedModuleVersionMap) {
	// collect selected bzlDeps foreach rule so we can sort them later
	bzlSrcRuleMap := make(map[*protoRule[*bzpb.ModuleVersion]]string)
	bzlDepsRuleMap := make(map[*protoRule[*bzpb.ModuleVersion]][]string)
	// parallel maps for the :packages target on the same starlark_repository
	pkgSrcRuleMap := make(map[*protoRule[*bzpb.ModuleVersion]]string)
	pkgDepsRuleMap := make(map[*protoRule[*bzpb.ModuleVersion]][]string)

	// Debug: Log all available versions and their ranks
	if debugBzlRepositoryResolution {
		log.Println("=== Available bzl repository versions with ranks ===")
		for moduleName, versions := range bzlRepositories {
			for _, version := range versions {
				if version.rank > 0 {
					log.Printf("  %s@%s: rank=%d label=%s", moduleName, version.version, version.rank, version.bzlRepositoryLabel.String())
				}
			}
		}
	}

	moduleNames := slices.Sorted(maps.Keys(bzlRepositories))

	// iterate the list of versions for each module (e.g. "bazel_skylib").
	for _, moduleName := range moduleNames {

		moduleMetadata := ext.moduleMetadataRules[moduleName]
		if moduleMetadata == nil {
			log.Printf("WARNING: no metadata found for module %s, skipping", moduleName)
			continue
		}

		// Convert string slice to moduleVersion slice
		sortedVersions := make([]moduleVersion, len(moduleMetadata.Proto().Versions))
		for i, v := range moduleMetadata.Proto().Versions {
			sortedVersions[i] = moduleVersion(v)
		}

		// coalesce / merge patch versions or minor versions together such that
		// we reduce the overall number of repos to fetch.
		versions := bzlRepositories[moduleName]
		// originalCount := len(versions)
		// versions = narrowSelectedVersionsByPatchLevel(sortedVersions, versions)
		// if len(versions) < originalCount {
		// 	log.Printf("Narrowed %s versions from %d to %d by merging patch levels", moduleName, originalCount, len(versions))
		// }

		// iterate the list of versions for each module (e.g. "bazel_skylib").
		// The ranked versions is a sparse list of available versions that may
		// or may not have any interested parties (rules that want to use them
		// for doc generation).
		for _, version := range versions {
			if version.rank > 0 {
				if version.source != nil {
					bzlSrcRuleMap[version.source] = version.bzlRepositoryLabel.String()
					pkgSrcRuleMap[version.source] = version.bzlRepositoryPackagesLabel.String()
				}
				for _, rule := range version.deps {
					bzlDepsRuleMap[rule] = append(bzlDepsRuleMap[rule], version.bzlRepositoryLabel.String())
					pkgDepsRuleMap[rule] = append(pkgDepsRuleMap[rule], version.bzlRepositoryPackagesLabel.String())
				}
			}
		}
	}

	for rule, bzlSrc := range bzlSrcRuleMap {
		rule.Rule().SetAttr("bzl_src", makeBzlSrcSelectExpr(bzlSrc))
	}
	for rule, bzlDeps := range bzlDepsRuleMap {
		sort.Strings(bzlDeps)
		rule.Rule().SetAttr("bzl_deps", makeBzlDepsSelectExpr(bzlDeps))
	}
	for rule, pkgSrc := range pkgSrcRuleMap {
		rule.Rule().SetAttr("pkg_src", makeBzlSrcSelectExpr(pkgSrc))
	}
	for rule, pkgDeps := range pkgDepsRuleMap {
		sort.Strings(pkgDeps)
		rule.Rule().SetAttr("pkg_deps", makeBzlDepsSelectExpr(pkgDeps))
	}
}

// mergeGeneratedModuleBazelFile updates the MODULE.bazel file with additional
// rules.
func mergeGeneratedModuleBazelFile(repoRoot string, binaryProtoHttpArchives []*rule.Rule, attestationHttpFiles []*rule.Rule, bzlRepositories rankedModuleVersionMap) error {
	if len(binaryProtoHttpArchives) == 0 && len(attestationHttpFiles) == 0 && len(bzlRepositories) == 0 {
		return nil
	}

	filename := filepath.Join(repoRoot, "data/generated.MODULE.bazel")
	f, err := modulebazel.LoadFile(filename, "")
	if err != nil {
		return fmt.Errorf("parsing: %v", err)
	}

	if len(attestationHttpFiles) > 0 {
		ensureHttpFileUseRepoRule(f.File)
		f.Sync()
	}

	// clean old rules
	deletedRules := 0
	for _, r := range f.Rules {
		switch r.Kind() {
		case httpArchiveKind:
			if strings.HasSuffix(r.Name(), binaryProtoRepositorySuffix) {
				r.Delete()
				deletedRules++
			}
		case httpFileKind:
			if strings.HasSuffix(r.Name(), attestationRepositorySuffix) {
				r.Delete()
				deletedRules++
			}
		case starlarkRepositoryArchiveKind, starlarkRepositoryLocalKind:
			if strings.HasPrefix(r.Name(), bzlRepositoryPrefix) {
				r.Delete()
				deletedRules++
			}
		}
	}
	f.Sync()
	log.Printf("cleaned up %d old rules", deletedRules)

	// Collect repository names in deterministic order
	bzlRepoNames := make([]build.Expr, 0, len(bzlRepositories))

	// Sort module names for deterministic order
	moduleNames := make([]string, 0, len(bzlRepositories))
	for moduleName := range bzlRepositories {
		moduleNames = append(moduleNames, string(moduleName))
	}
	sort.Strings(moduleNames)

	for _, moduleNameStr := range moduleNames {
		versions := bzlRepositories[moduleName(moduleNameStr)]
		for _, version := range versions {
			if version.rank > 0 {
				bzlRepoNames = append(bzlRepoNames, &build.StringExpr{Value: version.bzlRepositoryRule.Name()})
			}
		}
	}

	// update stmts
	for _, stmt := range f.File.Stmt {
		switch call := stmt.(type) {
		case *build.CallExpr:
			useRepo := getUseRepoCall(call, starlarkRepositoryModuleExtensionName)
			if useRepo != nil {
				useRepo.List = append([]build.Expr{useRepo.List[0] /* the starlark_repository module extension symbol */}, bzlRepoNames...)
				call.ForceMultiLine = true
				log.Printf(`updated use_repo(starlark_repository) with %d names`, len(bzlRepoNames))
				break
			}
		}
	}
	f.Sync()

	// Insert http_archive rules in sorted order
	sortedHttpArchives := make([]*rule.Rule, 0, len(binaryProtoHttpArchives))
	for _, r := range binaryProtoHttpArchives {
		sortedHttpArchives = append(sortedHttpArchives, r)
	}
	sort.Slice(sortedHttpArchives, func(i, j int) bool {
		return sortedHttpArchives[i].Name() < sortedHttpArchives[j].Name()
	})
	for _, r := range sortedHttpArchives {
		r.Insert(f)
	}

	// Insert attestation http_file rules in sorted order (Gazelle already
	// sorted these by URL, but re-sort by repo name for stable output).
	sortedHttpFiles := make([]*rule.Rule, 0, len(attestationHttpFiles))
	sortedHttpFiles = append(sortedHttpFiles, attestationHttpFiles...)
	sort.Slice(sortedHttpFiles, func(i, j int) bool {
		return sortedHttpFiles[i].Name() < sortedHttpFiles[j].Name()
	})
	for _, r := range sortedHttpFiles {
		r.Insert(f)
	}

	// Insert starlark_repository rules in sorted order by module name
	for _, moduleNameStr := range moduleNames {
		versions := bzlRepositories[moduleName(moduleNameStr)]
		for _, version := range versions {
			if version.rank > 0 {
				version.bzlRepositoryRule.Insert(f)
			}
		}
	}
	f.Sync()

	log.Printf("added %d http_archive rules", len(binaryProtoHttpArchives))
	log.Printf("added %d http_file rules", len(attestationHttpFiles))
	log.Printf("added %d starlark_repository rules", len(bzlRepositories))

	log.Println("Updating:", filename)
	return f.Save(filename)
}

// ensureHttpFileUseRepoRule prepends a `http_file = use_repo_rule(...)`
// statement to the MODULE.bazel file if one is not already present. The repo
// rule is needed before any http_file(...) calls Gazelle later inserts.
func ensureHttpFileUseRepoRule(f *build.File) {
	for _, stmt := range f.Stmt {
		assign, ok := stmt.(*build.AssignExpr)
		if !ok {
			continue
		}
		lhs, ok := assign.LHS.(*build.Ident)
		if !ok || lhs.Name != httpFileKind {
			continue
		}
		// Already declared; nothing to do.
		return
	}

	useRepoRule := &build.AssignExpr{
		LHS: &build.Ident{Name: httpFileKind},
		Op:  "=",
		RHS: &build.CallExpr{
			X: &build.Ident{Name: "use_repo_rule"},
			List: []build.Expr{
				&build.StringExpr{Value: "@bazel_tools//tools/build_defs/repo:http.bzl"},
				&build.StringExpr{Value: httpFileKind},
			},
		},
	}

	// Insert just after the existing `http_archive = use_repo_rule(...)` if
	// present, otherwise at the top of the file. Co-locating the two
	// statements keeps generated.MODULE.bazel readable.
	insertAt := 0
	for i, stmt := range f.Stmt {
		assign, ok := stmt.(*build.AssignExpr)
		if !ok {
			continue
		}
		lhs, ok := assign.LHS.(*build.Ident)
		if !ok {
			continue
		}
		if lhs.Name == httpArchiveKind {
			insertAt = i + 1
			break
		}
	}
	f.Stmt = append(f.Stmt[:insertAt], append([]build.Expr{useRepoRule}, f.Stmt[insertAt:]...)...)
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
	r := rule.NewRule(httpArchiveKind, from.Repo)
	r.SetAttr("url", docUrl)
	r.SetAttr("build_file_content", fmt.Sprintf(`filegroup(name = "%s",
    srcs = glob(["**/*.binaryproto"]),
    visibility = ["//visibility:public"],
)`, from.Name))
	return r
}

// makeBzlRepositoryName creates a named for the external workspace
func makeBzlRepositoryName(moduleName, moduleVersion string) (name string) {
	return fmt.Sprintf("%s%s---%s", bzlRepositoryPrefix, moduleName, moduleVersion) // TODO: do we need to sanitize moduleVersion?
}

// makeBzlRepositoryModulesLabel creates a label for a starlark_repository modules rule.
func makeBzlRepositoryModulesLabel(moduleName, moduleVersion string) label.Label {
	return makeBzlRepositoryLabel(moduleName, moduleVersion, bzlRepositoryModulesName)
}

// makeBzlRepositoryPackagesLabel creates a label for a starlark_repository Packages rule.
func makeBzlRepositoryPackagesLabel(moduleName, moduleVersion string) label.Label {
	return makeBzlRepositoryLabel(moduleName, moduleVersion, bzlRepositoryPackagesName)
}

// makeBzlRepositoryLabel creates a label for a starlark_repository target rule.
func makeBzlRepositoryLabel(moduleName, moduleVersion, targetName string) label.Label {
	repo := makeBzlRepositoryName(moduleName, moduleVersion)
	pkg := ""
	name := targetName

	// special case: if this is the bazel_tools repo
	if moduleName == bazelToolsName {
		pkg = "tools"
	}

	return label.New(repo, pkg, name)
}

func makeBzlRepository(from label.Label, moduleVersion *bzpb.ModuleVersion, source *bzpb.ModuleSource) *rule.Rule {

	r := rule.NewRule(starlarkRepositoryArchiveKind, from.Repo)
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
	r.SetAttr("build_file_generation", "preserve")
	r.SetAttr("languages", []string{starlarkRepositoryLanguageName})

	rootDirective := fmt.Sprintf("gazelle:%s_root", starlarkRepositoryLanguageName)
	if moduleVersion.Name == bazelToolsName {
		// special case: only generate docs for @bazel_tools if this is the
		// bazel pseudomodule
		rootDirective = fmt.Sprintf("gazelle:%s_root tools", starlarkRepositoryLanguageName)
	}

	r.SetAttr("build_directives", []string{rootDirective})

	return r
}

// makeOverlayBzlRepository emits a starlark_repository.local rule that points
// at the on-disk BCR overlay directory for this module-version. Used as a
// fallback when the upstream source repo doesn't advertise Starlark but the
// BCR overlay carries .bzl files that should be documented.
//
// registryRoot is the workspace-relative path to the BCR root (e.g.
// "data/bazel-central-registry"). Using a local path avoids ~449 parallel
// fetches of the same github.com archive (which trip GitHub's 429 rate
// limit) and skips redundant per-rule extraction of a 100MB tarball.
func makeOverlayBzlRepository(from label.Label, moduleName, moduleVersion, registryRoot string) *rule.Rule {
	r := rule.NewRule(starlarkRepositoryLocalKind, from.Repo)

	r.SetAttr("path", filepath.Join(registryRoot, "modules", moduleName, moduleVersion, "overlay"))
	r.SetAttr("build_file_generation", "preserve")
	r.SetAttr("languages", []string{starlarkRepositoryLanguageName})
	r.SetAttr("build_directives", []string{fmt.Sprintf("gazelle:%s_root", starlarkRepositoryLanguageName)})

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

// narrowSelectedVersionsByPatchLevel reduces the number of versions by merging
// patch versions within the same major.minor group. This minimizes the number
// of starlark repositories we need to generate while maintaining coverage.
//
// For example, if we have:
//   - 1.8.2 (rank=10)
//   - 1.8.1 (rank=5)
//   - 1.8.0 (rank=3)
//   - 1.7.1 (rank=2)
//
// We'll keep only:
//   - 1.8.2 (rank=18) ← merged 1.8.1 and 1.8.0
//   - 1.7.1 (rank=2)
//
// The sortedVersions list should be the sorted versions from moduleMetadata.Versions
func narrowSelectedVersionsByPatchLevel(sortedVersions []moduleVersion, versions []*rankedVersion) []*rankedVersion {
	if len(versions) == 0 {
		return versions
	}

	// Create a map from version string to rankedVersion for quick lookup
	versionMap := make(map[moduleVersion]*rankedVersion)
	for _, v := range versions {
		versionMap[v.version] = v
	}

	// Group versions by major.minor prefix
	// Key is major.minor (e.g., "1.8"), value is list of full versions
	groups := make(map[string][]moduleVersion)
	for _, version := range sortedVersions {
		if _, exists := versionMap[version]; !exists {
			// Skip versions that don't have rankings (not selected by MVS)
			continue
		}

		// Extract major.minor by taking everything before the last dot
		// This handles versions like "1.8.2", "1.8.2-rc1", etc.
		majorMinor := extractMajorMinor(string(version))
		groups[majorMinor] = append(groups[majorMinor], version)
	}

	// For each group, keep only the highest version and merge ranks
	narrowed := make([]*rankedVersion, 0, len(groups))
	for _, groupVersions := range groups {
		if len(groupVersions) == 0 {
			continue
		}

		// The versions are already sorted (from sortedVersions), so the last one is highest
		// within this group (since we iterated in order)
		highestVersion := groupVersions[len(groupVersions)-1]
		highest := versionMap[highestVersion]

		if len(groupVersions) == 1 {
			// Only one version in this group, keep it as-is
			narrowed = append(narrowed, highest)
			continue
		}

		// Merge ranks and deps from all versions in this group
		mergedRank := 0
		var mergedDeps []*protoRule[*bzpb.ModuleVersion]
		var mergedSource *protoRule[*bzpb.ModuleVersion]

		for _, version := range groupVersions {
			v := versionMap[version]
			mergedRank += v.rank
			mergedDeps = append(mergedDeps, v.deps...)
			if v.source != nil {
				if mergedSource == nil {
					mergedSource = v.source
				}
				// If multiple sources, prefer the one from the highest version
				if version == highestVersion {
					mergedSource = v.source
				}
			}
		}

		// Create a new rankedVersion with merged data
		merged := &rankedVersion{
			version:                    highest.version,
			bzlRepositoryLabel:         highest.bzlRepositoryLabel,
			bzlRepositoryPackagesLabel: highest.bzlRepositoryPackagesLabel,
			bzlRepositoryRule:          highest.bzlRepositoryRule,
			source:                     mergedSource,
			deps:                       mergedDeps,
			rank:                       mergedRank,
		}

		narrowed = append(narrowed, merged)
	}

	return narrowed
}

// extractMajorMinor extracts the major.minor prefix from a version string
// Examples:
//   - "1.8.2" -> "1.8"
//   - "1.8.2-rc1" -> "1.8"
//   - "2.0.0" -> "2.0"
func extractMajorMinor(version string) string {
	// Find the last dot to separate patch version
	lastDot := strings.LastIndex(version, ".")
	if lastDot == -1 {
		// No dots, use the whole version
		return version
	}

	// Take everything before the last dot, but stop at any non-numeric character after that
	majorMinor := version[:lastDot]

	// Handle pre-release suffixes like "1.8.2-rc1" - find the first dash/hyphen
	if dashIdx := strings.Index(majorMinor, "-"); dashIdx != -1 {
		majorMinor = majorMinor[:dashIdx]
	}

	return majorMinor
}

// selectVersion votes for a version and returns the actual version selected.
// If the requested version is not available, it falls back to the highest available version.
// Returns the version that was actually selected (which may differ from the requested version).
func selectVersion(rule *protoRule[*bzpb.ModuleVersion], version moduleVersion, isSource bool, available []*rankedVersion, _ *bzpb.ModuleMetadata) moduleVersion {
	if len(available) == 0 {
		return ""
	}

	choose := func(v *rankedVersion) moduleVersion {
		if isSource {
			if v.source != nil {
				// In --docs-all-versions mode, multiple module versions may
				// fall back to the same available version. Only the first
				// claimant gets bzl_src; others are silently skipped.
				if debugBzlRepositoryResolution {
					log.Printf("WARNING: %s already claimed as source by another version, skipping %s", v.version, version)
				}
				return ""
			}
			v.source = rule
		} else {
			v.deps = append(v.deps, rule)
		}
		v.rank++
		return v.version
	}

	for _, v := range available {
		if v.version == version {
			return choose(v)
		}
	}

	// Fallback to highest available version
	fallback := available[len(available)-1]
	if debugBzlRepositoryResolution {
		log.Printf("WARNING: %s not available, falling back to %s", newModuleID(rule.Proto().Name, string(version)), newModuleID(rule.Proto().Name, string(fallback.version)))
	}
	return choose(fallback)
}

// isStarlarkCandidate returns true when the module's upstream repository is
// a plausible Starlark candidate. Concretely, that means at least one of:
//
//   - some listed repository has "Starlark" in its Languages map, OR
//   - none of the listed repositories has a populated Languages map (so we
//     have no evidence one way or the other — typically because the repo
//     isn't on GitHub and we never fetched language stats).
//
// Only repos with a populated Languages map that does NOT contain "Starlark"
// constitute a negative signal. This keeps non-GitHub-hosted modules
// (e.g. GitLab tarballs like rules_tar 1.0.1) in the candidate set instead
// of silently dropping them.
func isStarlarkCandidate(moduleMetadataRule *rule.Rule, repositoryMetadataByID map[repositoryID]*bzpb.RepositoryMetadata) bool {
	repositories := moduleMetadataRule.AttrStrings("repository")
	if len(repositories) == 0 {
		return false
	}

	sawPopulatedLanguages := false
	for _, repo := range repositories {
		canonicalName := normalizeRepositoryID(repo)
		repoMetadata, exists := repositoryMetadataByID[canonicalName]
		if !exists {
			continue
		}
		if len(repoMetadata.Languages) == 0 {
			continue
		}
		sawPopulatedLanguages = true
		if _, hasLang := repoMetadata.Languages["Starlark"]; hasLang {
			return true
		}
	}

	return !sawPopulatedLanguages
}
