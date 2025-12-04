package bcr

import (
	"log"
	"maps"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/bazelbuild/bazel-gazelle/rule"
	"github.com/dominikbraun/graph"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

type moduleDeps map[moduleName]moduleVersion

func (md *moduleDeps) ToStringDict() map[string]string {
	dict := make(map[string]string)
	for k, v := range *md {
		dict[string(k)] = string(v)
	}
	return dict
}

type mvs map[moduleID]moduleDeps

// calculateMvs implements Minimum Version Selection algorithm
// This calculates MVS for each individual module@version in the registry
func (ext *bcrExtension) calculateMvs(bzlRepositories rankedModuleVersionMap) {
	log.Println("Running Minimum Version Selection (MVS) algorithm...")

	// perModuleVersionMvs maps "module@version" -> (module name -> selected
	// version) This shows what MVS would select for regular deps if that
	// specific module@version were the root
	perModuleVersionMvs := ext.calculatePerModuleVersionMvs(ext.regularDepGraph, "regular")
	// perModuleVersionMvsDev maps "module@version" -> (module name -> selected
	// version) This shows what MVS would select for dev deps if that specific
	// module@version were the root
	perModuleVersionMvsDev := ext.calculatePerModuleVersionMvs(ext.devDepGraph, "dev")
	// perModuleVersionMvsMerged records selected versions in the merged set of
	// regular + dev
	// perModuleVersionMvsMerged := ext.calculatePerModuleVersionMvs(allVersions, ext.depGraph, "merged")

	// Annotate module_version rules with their MVS results
	updateModuleVersionRuleMvsAttr(ext.moduleVersionRules, "mvs", perModuleVersionMvs)
	updateModuleVersionRuleMvsAttr(ext.moduleVersionRules, "mvs_dev", perModuleVersionMvsDev)

	ext.rankBzlRepositoryVersions(perModuleVersionMvs, bzlRepositories)
	ext.finalizeBzlSrcsAndDeps(bzlRepositories)
}

// calculatePerModuleVersionMvs computes MVS for each module@version in the given graph
// Returns map of "module@version" -> (module name -> selected version)
// depGraph is the dependency graph to use (either regular deps or dev deps)
// depType is a description for the progress bar ("regular" or "dev")
func (ext *bcrExtension) calculatePerModuleVersionMvs(depGraph graph.Graph[moduleID, moduleID], depType string) mvs {
	perModuleVersionMvs := make(mvs)

	// Get all module@version nodes from the graph
	adjacencyMap, err := depGraph.AdjacencyMap()
	if err != nil {
		log.Printf("Error getting adjacency map for per-version MVS (%s): %v", depType, err)
		return perModuleVersionMvs
	}

	// Collect module keys to process (excluding unresolved)
	var moduleIDs []moduleID
	for id := range adjacencyMap {
		if !ext.unresolvedModules[id] {
			moduleIDs = append(moduleIDs, id)
		}
	}

	if len(moduleIDs) == 0 {
		log.Println("No module versions to calculate MVS for")
		return perModuleVersionMvs
	}

	// Parallelize MVS calculations using worker pool
	var wg sync.WaitGroup
	var mu sync.Mutex

	// Create channels for jobs and results
	jobChan := make(chan moduleID, len(moduleIDs))
	resultChan := make(chan struct {
		id     moduleID
		result map[moduleName]moduleVersion
	}, len(moduleIDs))

	// Start worker goroutines
	numWorkers := min(10, len(moduleIDs)) // Limit concurrent workers

	for range numWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for id := range jobChan {
				// Run MVS with this single module@version as the root
				selected := runMvs([]moduleID{id}, adjacencyMap)
				resultChan <- struct {
					id     moduleID
					result map[moduleName]moduleVersion
				}{id: id, result: selected}
			}
		}()
	}

	// Send jobs
	go func() {
		for _, id := range moduleIDs {
			jobChan <- id
		}
		close(jobChan)
	}()

	// Close result channel when all workers are done
	go func() {
		wg.Wait()
		close(resultChan)
	}()

	// Collect results with progress reporting
	for result := range resultChan {
		mu.Lock()
		perModuleVersionMvs[result.id] = result.result
		mu.Unlock()
	}

	log.Printf("Calculated MVS for %d module versions", len(moduleIDs))
	return perModuleVersionMvs
}

// runMvs runs the MVS algorithm starting from root module@version keys
// adjacencyMap is passed in to avoid repeated fetches
// Returns the selected version for each module (excluding the roots themselves)
func runMvs(roots []moduleID, adjacencyMap map[moduleID]map[moduleID]graph.Edge[moduleID]) moduleDeps {
	selected := make(moduleDeps)

	// Initialize selected versions from roots
	for _, id := range roots {
		selected[id.name()] = id.version()
	}

	// Build the transitive closure of dependencies
	// Start from roots and traverse the graph, selecting maximum versions
	visited := make(map[moduleID]bool)
	var visit func(id moduleID)

	visit = func(id moduleID) {
		if visited[id] {
			return
		}
		visited[id] = true

		moduleName := id.name()
		version := id.version()

		// Update selected version if this is higher
		if currentVersion, exists := selected[moduleName]; !exists || compareVersions(version, currentVersion) > 0 {
			selected[moduleName] = version
		}

		// Visit dependencies using adjacency map
		if deps, exists := adjacencyMap[id]; exists {
			for targetKey := range deps {
				visit(targetKey)
			}
		}
	}

	// Visit all root module@version keys (and their transitive dependencies)
	for _, id := range roots {
		visit(id)
	}

	return selected
}

func (ext *bcrExtension) rankBzlRepositoryVersions(perModuleVersionMvs mvs, bzlRepositories rankedModuleVersionMap) {
	for id, mvs := range perModuleVersionMvs {
		ext.rankBzlRepositoryVersionsForModule(id, mvs, bzlRepositories)
	}
}

func (ext *bcrExtension) rankBzlRepositoryVersionsForModule(id moduleID, deps moduleDeps, bzlRepositories rankedModuleVersionMap) {
	// skip setting bzl_srcs and deps on non-latest versions
	moduleVersionRule, exists := ext.moduleVersionRules[id]
	if !exists {
		return
	}
	if !isLatestVersion(moduleVersionRule) {
		return
	}

	rootModuleName := id.name()
	rootModuleVersion := id.version()

	for moduleName, version := range deps {
		moduleMetadataProtoRule, exists := ext.moduleMetadataRules[rootModuleName]
		if !exists {
			return
		}
		if !hasStarlarkLanguage(moduleMetadataProtoRule.Rule(), ext.repositoriesMetadataByID) {
			continue
		}

		metadata := moduleMetadataProtoRule.Proto()

		if moduleName == rootModuleName && version == rootModuleVersion {
			// This is the root module → bzl_srcs (single label)
			selectVersion(moduleVersionRule, version, true, bzlRepositories[moduleName], metadata)
		} else {
			// This is a dependency → bzl_deps (list)
			selectVersion(moduleVersionRule, version, false, bzlRepositories[moduleName], metadata)
		}
	}

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
			version:            highest.version,
			bzlRepositoryLabel: highest.bzlRepositoryLabel,
			bzlRepositoryRule:  highest.bzlRepositoryRule,
			source:             mergedSource,
			deps:               mergedDeps,
			rank:               mergedRank,
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

func (ext *bcrExtension) finalizeBzlSrcsAndDeps(bzlRepositories rankedModuleVersionMap) {
	// collect selected bzlDeps foreach rule so we can sort them later
	bzlSrcRuleMap := make(map[*protoRule[*bzpb.ModuleVersion]]string)
	bzlDepsRuleMap := make(map[*protoRule[*bzpb.ModuleVersion]][]string)

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
				}
				for _, rule := range version.deps {
					bzlDepsRuleMap[rule] = append(bzlDepsRuleMap[rule], version.bzlRepositoryLabel.String())
				}
			}
		}
	}

	for rule, bzlSrc := range bzlSrcRuleMap {
		rule.Rule().SetAttr("bzl_srcs", makeBzlSrcSelectExpr(bzlSrc))
	}
	for rule, bzlDeps := range bzlDepsRuleMap {
		sort.Strings(bzlDeps)
		rule.Rule().SetAttr("bzl_deps", makeBzlDepsSelectExpr(bzlDeps))
	}
}

func selectVersion(rule *protoRule[*bzpb.ModuleVersion], version moduleVersion, isSource bool, available []*rankedVersion, _ *bzpb.ModuleMetadata) {
	if len(available) == 0 {
		return
	}

	choose := func(v *rankedVersion) {
		if isSource {
			if v.source != nil {
				log.Panicf("more than one module is claiming to be the source module! %s", version)
			}
			v.source = rule
		} else {
			v.deps = append(v.deps, rule)
		}
		v.rank++
	}

	for _, v := range available {
		if v.version == version {
			choose(v)
			return
		}
	}

	choose(available[len(available)-1])
}

// compareVersions compares two version strings lexicographically
// Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
// This is used during MVS graph traversal to select the maximum version
// when multiple versions of the same module are encountered.
func compareVersions(v1, v2 moduleVersion) int {
	if v1 == v2 {
		return 0
	}
	if v1 < v2 {
		return -1
	}
	return 1
}

func hasStarlarkLanguage(moduleMetadataRule *rule.Rule, repositoryMetadataByID map[repositoryID]*bzpb.RepositoryMetadata) bool {
	// Get the repository field
	repositories := moduleMetadataRule.AttrStrings("repository")
	if len(repositories) == 0 {
		return false
	}

	// Check if the repositoriy has Starlark in its languages
	for _, repo := range repositories {
		canonicalName := normalizeRepositoryID(repo)
		repoMetadata, exists := repositoryMetadataByID[canonicalName]
		if !exists {
			continue
		}
		if repoMetadata.Languages == nil {
			continue
		}
		if _, hasLang := repoMetadata.Languages["Starlark"]; hasLang {
			return true
		}
	}

	return false
}
