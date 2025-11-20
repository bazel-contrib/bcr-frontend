package bcr

import (
	"context"
	"log"
)

// Before is called before any other lifecycle methods.
// This can be used to initialize resources needed during the build.
func (ext *bcrExtension) Before(ctx context.Context) {
	// Nothing to initialize before processing
	log.Println("===[Before]======================================")
}

// DoneGeneratingRules is called after all rules have been generated.
// This is the ideal place to detect circular dependencies since the
// complete dependency graph has been built.
func (ext *bcrExtension) DoneGeneratingRules() {
	log.Println("===[DoneGeneratingRules]======================================")

	// Get all detected cycles
	cycles := ext.getCycles()

	// Build the module-to-cycle mapping for use during resolution
	ext.moduleToCycle = buildModuleToCycleMap(cycles)

	// Log any circular dependencies
	ext.logCycles()

	// fetch repository metadata now that we know the full list of repos to
	// gather info for
	// ext.fetchGithubRepositoryMetadata(filterGithubRepositories(ext.repositories))
	// ext.fetchGitlabRepositoryMetadata(filterGitlabRepositories(ext.repositories))
	// in case we had issues fetching metadata, propagate formward from previous
	// (base) repository state.
	if ext.baseRegistry != nil {
		propagateBaseRepositoryMetadata(ext.repositories, makeRepositoryMetadataMap(ext.baseRegistry))
	}

	log.Println("===[BeforeResolvingDeps]======================================")
}

// AfterResolvingDeps is called after all dependencies have been resolved.
// This can be used to clean up resources or perform final validation.
func (ext *bcrExtension) AfterResolvingDeps(ctx context.Context) {
	// Nothing to clean up after resolution
	log.Println("===[AfterResolvingDeps]======================================")
}
