package bcr

import (
	"log"
	"slices"
	"sync"

	"github.com/bazelbuild/buildtools/build"
	"github.com/dominikbraun/graph"
)

type mvs map[string]map[string]string

// calculateMvs implements Minimum Version Selection algorithm
// This calculates MVS for each individual module@version in the registry
func (ext *bcrExtension) calculateMvs(starlarkRepositories moduleVersionRuleMap) {
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
	updateModuleVersionMvsAttr(ext.moduleVersionRulesByModuleKey, "mvs", perModuleVersionMvs)
	updateModuleVersionMvsAttr(ext.moduleVersionRulesByModuleKey, "mvs_dev", perModuleVersionMvsDev)

	ext.updateModuleVersionRulesBzlSrcsAndDeps(perModuleVersionMvs, starlarkRepositories)
}

// calculatePerModuleVersionMvs computes MVS for each module@version in the given graph
// Returns map of "module@version" -> (module name -> selected version)
// depGraph is the dependency graph to use (either regular deps or dev deps)
// depType is a description for the progress bar ("regular" or "dev")
func (ext *bcrExtension) calculatePerModuleVersionMvs(depGraph graph.Graph[moduleKey, moduleKey], depType string) mvs {
	perModuleVersionMvs := make(mvs)

	// Get all module@version nodes from the graph
	adjacencyMap, err := depGraph.AdjacencyMap()
	if err != nil {
		log.Printf("Error getting adjacency map for per-version MVS (%s): %v", depType, err)
		return perModuleVersionMvs
	}

	// Collect module keys to process (excluding unresolved)
	var moduleKeys []moduleKey
	for modKey := range adjacencyMap {
		if !ext.unresolvedModulesByModuleName[modKey] {
			moduleKeys = append(moduleKeys, modKey)
		}
	}

	if len(moduleKeys) == 0 {
		log.Println("No module versions to calculate MVS for")
		return perModuleVersionMvs
	}

	// Parallelize MVS calculations using worker pool
	var wg sync.WaitGroup
	var mu sync.Mutex

	// Create channels for jobs and results
	jobChan := make(chan moduleKey, len(moduleKeys))
	resultChan := make(chan struct {
		moduleKey string
		result    map[string]string
	}, len(moduleKeys))

	// Start worker goroutines
	numWorkers := min(10, len(moduleKeys)) // Limit concurrent workers

	for range numWorkers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for modKey := range jobChan {
				// Run MVS with this single module@version as the root
				selected := runMvs([]moduleKey{modKey}, adjacencyMap)
				resultChan <- struct {
					moduleKey string
					result    map[string]string
				}{moduleKey: modKey.String(), result: selected}
			}
		}()
	}

	// Send jobs
	go func() {
		for _, moduleKey := range moduleKeys {
			jobChan <- moduleKey
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
		perModuleVersionMvs[result.moduleKey] = result.result
		mu.Unlock()
	}

	log.Printf("Calculated MVS for %d module versions", len(moduleKeys))
	return perModuleVersionMvs
}

// runMvs runs the MVS algorithm starting from root module@version keys
// adjacencyMap is passed in to avoid repeated fetches
// Returns the selected version for each module (excluding the roots themselves)
func runMvs(roots []moduleKey, adjacencyMap map[moduleKey]map[moduleKey]graph.Edge[moduleKey]) map[string]string {
	selected := make(map[string]string)

	// Initialize selected versions from roots
	for _, modKey := range roots {
		moduleName := modKey.name()
		version := modKey.version()
		selected[moduleName] = version
	}

	// Build the transitive closure of dependencies
	// Start from roots and traverse the graph, selecting maximum versions
	visited := make(map[moduleKey]bool)
	var visit func(modKey moduleKey)

	visit = func(modKey moduleKey) {
		if visited[modKey] {
			return
		}
		visited[modKey] = true

		moduleName := modKey.name()
		version := modKey.version()

		// Update selected version if this is higher
		if currentVersion, exists := selected[moduleName]; !exists || compareVersions(version, currentVersion) > 0 {
			selected[moduleName] = version
		}

		// Visit dependencies using adjacency map
		if deps, exists := adjacencyMap[modKey]; exists {
			for targetKey := range deps {
				visit(targetKey)
			}
		}
	}

	// Visit all root module@version keys (and their transitive dependencies)
	for _, modKey := range roots {
		visit(modKey)
	}

	return selected
}

// makeBzlSrcSelectExpr creates a select expression for the bzl_srcs attribute (single label)
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

// compareVersions compares two version strings lexicographically
// Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
// This is used during MVS graph traversal to select the maximum version
// when multiple versions of the same module are encountered.
func compareVersions(v1, v2 string) int {
	if v1 == v2 {
		return 0
	}
	if v1 < v2 {
		return -1
	}
	return 1
}
