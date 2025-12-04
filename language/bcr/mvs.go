package bcr

import (
	"log"
	"sync"

	"github.com/dominikbraun/graph"
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
