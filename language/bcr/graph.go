package bcr

import (
	"fmt"
	"log"

	"github.com/dominikbraun/graph"
)

// initDepGraph creates and returns a new directed graph for tracking module dependencies
func initDepGraph() graph.Graph[string, string] {
	return graph.New(graph.StringHash, graph.Directed())
}

// addModuleToGraph adds a module version to the dependency graph
func (ext *bcrExtension) addModuleToGraph(moduleName, version string) {
	if moduleName == "" || version == "" {
		return
	}
	moduleKey := fmt.Sprintf("%s@%s", moduleName, version)
	if err := ext.depGraph.AddVertex(moduleKey); err != nil {
		// Vertex might already exist, which is fine
		log.Printf("addModuleToGraph: %v", err)
	}
}

// addDependencyEdge adds a dependency edge from one module version to another
func (ext *bcrExtension) addDependencyEdge(fromModule, fromVersion, toModule, toVersion string) {
	if fromModule == "" || fromVersion == "" || toModule == "" || toVersion == "" {
		return
	}

	fromKey := fmt.Sprintf("%s@%s", fromModule, fromVersion)
	toKey := fmt.Sprintf("%s@%s", toModule, toVersion)

	// Ensure both vertices exist
	_ = ext.depGraph.AddVertex(fromKey)
	_ = ext.depGraph.AddVertex(toKey)

	// Add edge
	if err := ext.depGraph.AddEdge(fromKey, toKey); err != nil {
		// Edge might already exist, which is fine
		log.Printf("addDependencyEdge: %v", err)
	}
}

// detectCycles finds all strongly connected components (cycles) in the dependency graph
// Returns only SCCs with more than one node (actual cycles)
func (ext *bcrExtension) detectCycles() ([][]string, error) {
	sccs, err := graph.StronglyConnectedComponents(ext.depGraph)
	if err != nil {
		return nil, fmt.Errorf("detecting cycles: %w", err)
	}

	// Filter out single-node SCCs (not cycles)
	var cycles [][]string
	for _, scc := range sccs {
		if len(scc) > 1 {
			cycles = append(cycles, scc)
		}
	}

	return cycles, nil
}

// logCycles logs all detected circular dependencies
func (ext *bcrExtension) logCycles() {
	cycles, err := ext.detectCycles()
	if err != nil {
		log.Printf("Error detecting cycles: %v", err)
		return
	}

	if len(cycles) == 0 {
		return
	}

	log.Printf("WARNING: Found %d circular dependency group(s):", len(cycles))
	for i, cycle := range cycles {
		log.Printf("  Cycle %d: %v", i+1, cycle)
	}
}
