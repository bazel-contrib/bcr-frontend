package bcr

import (
	"context"
	"log"
)

// Before is called before any other lifecycle methods. This can be used to
// initialize resources needed during the build.
func (ext *bcrExtension) Before(ctx context.Context) {
	// Nothing to initialize before processing
	log.Println("===[Before]======================================")

	// Fetch Bazel release data and create pseudo BCR modules
	ext.fetchBazelRepositoryMetadata(nil)
}

// DoneGeneratingRules is called after all rules have been generated. This is
// the ideal place to detect circular dependencies since the complete dependency
// graph has been built.
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
	ext.fetchGithubRepositoryMetadata(filterGithubRepositories(ext.repositoriesMetadataByID))
	// ext.fetchGitlabRepositoryMetadata(filterGitlabRepositories(ext.repositories))

	log.Println("===[BeforeResolvingDeps]======================================")
}

// AfterResolvingDeps is called after all dependencies have been resolved. This
// can be used to clean up resources or perform final validation.
func (ext *bcrExtension) AfterResolvingDeps(ctx context.Context) {
	log.Println("===[AfterResolvingDeps]======================================")

	// Make docs repositories
	binaryProtoHttpArchives := ext.prepareBinaryprotoRepositories()
	availableBzlRepositories := ext.prepareBzlRepositories()

	// Calculate MVS sets - this updates the rankings of
	ext.calculateMvs(availableBzlRepositories)

	if err := mergeModuleBazelFile(ext.repoRoot, binaryProtoHttpArchives, availableBzlRepositories); err != nil {
		log.Fatal(err)
	}

	// Resolve source commit SHAs for ranked modules (those we're generating
	// docs for) Only do this after MVS calculation and MODULE.bazel merge to
	// narrow down the set
	ext.resolveSourceCommitSHAsForRankedModules(availableBzlRepositories)

	// Write the updated caches back to files - best effort, ignoring errors
	if err := ext.writeResourceStatusCacheFile(); err != nil {
		log.Println("writing resource status cache file: ")
	}

	if err := ext.writeRepositoryMetadataCacheFile(); err != nil {
		log.Println("writing repository metadata cache file: ")
	}

	if err := ext.writeBazelReleaseCacheFile(); err != nil {
		log.Println("writing bazel release cache file: ")
	}
}
