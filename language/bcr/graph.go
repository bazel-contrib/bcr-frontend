package bcr

import (
	"fmt"
	"log"

	"github.com/dominikbraun/graph"
)

// initDepGraph creates and returns a new directed graph for tracking module
// dependencies
func initDepGraph() graph.Graph[moduleID, moduleID] {
	moduleIDHash := func(id moduleID) moduleID {
		return id
	}
	return graph.New(moduleIDHash, graph.Directed())
}

// addModuleToGraph adds a module version to the dependency graph
func (ext *bcrExtension) addModuleToGraph(moduleName, version string) {
	if moduleName == "" || version == "" {
		return
	}
	id := newModuleID(moduleName, version)
	if err := ext.depGraph.AddVertex(id); err != nil {
		// Vertex might already exist, which is fine
		if err != graph.ErrVertexAlreadyExists {
			log.Panicf("addModuleToGraph: %v", err)
		}
	}
}

// addDependencyEdge adds a dependency edge from one module version to another
func (ext *bcrExtension) addDependencyEdge(fromModule, fromVersion, toModule, toVersion string) {
	if fromModule == "" || fromVersion == "" || toModule == "" || toVersion == "" {
		return
	}

	fromID := newModuleID(fromModule, fromVersion)
	toID := newModuleID(toModule, toVersion)

	// Ensure both vertices exist
	_ = ext.depGraph.AddVertex(fromID)
	_ = ext.depGraph.AddVertex(toID)

	// Add edge
	if err := ext.depGraph.AddEdge(fromID, toID); err != nil {
		// Edge might already exist, which is fine
		if err != graph.ErrEdgeAlreadyExists {
			log.Panicf("addDependencyEdge: %v", err)
		}
	}
}

// detectCycles finds all strongly connected components (cycles) in the
// dependency graph Returns only SCCs with more than one node (actual cycles)
func (ext *bcrExtension) detectCycles() ([][]moduleID, error) {
	sccs, err := graph.StronglyConnectedComponents(ext.depGraph)
	if err != nil {
		return nil, fmt.Errorf("detecting cycles: %w", err)
	}

	// Filter out single-node SCCs (not cycles)
	var cycles [][]moduleID
	for _, scc := range sccs {
		if len(scc) > 1 {
			cycles = append(cycles, scc)
		}
	}

	return cycles, nil
}

// getCycles returns all detected circular dependencies Returns an empty slice
// if no cycles are found or if an error occurs
func (ext *bcrExtension) getCycles() [][]moduleID {
	cycles, err := ext.detectCycles()
	if err != nil {
		log.Printf("Error detecting cycles: %v", err)
		return nil
	}
	return cycles
}

// logCycles logs all detected circular dependencies
func (ext *bcrExtension) logCycles() {
	cycles := ext.getCycles()
	if len(cycles) == 0 {
		return
	}

	log.Printf("WARNING: Found %d circular dependency group(s):", len(cycles))
	for i, cycle := range cycles {
		log.Printf("  Cycle %d: %v", i+1, cycle)
	}
}
