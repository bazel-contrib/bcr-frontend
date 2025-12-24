package bcr

import (
	"fmt"
	"log"
	"maps"
	"os"
	"slices"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

func (ext *bcrExtension) readRepositoryMetadataCacheFile() {
	if ext.repositoryMetadataSetFile != "" {
		var repositoryMetadataSet bzpb.RepositoryMetadataSet
		if err := protoutil.ReadFile(os.ExpandEnv(ext.repositoryMetadataSetFile), &repositoryMetadataSet); err != nil {
			log.Printf("warning: could not read repository metadata: %v", err)
		}
		for _, md := range repositoryMetadataSet.RepositoryMetadata {
			normalized := formatRepositoryID(md)
			ext.repositoriesMetadataByID[normalized] = md
		}
	}
}

// writeRepositoryMetadataCacheFile writes the repository metadata map back to the file it was loaded from
// Only writes if we actually fetched new metadata during this run
func (ext *bcrExtension) writeRepositoryMetadataCacheFile() error {
	if ext.repositoryMetadataSetFile == "" {
		// No file was specified, so nothing to write
		return nil
	}

	if !ext.fetchedRepositoryMetadata {
		// No new metadata was fetched, don't overwrite the cache
		log.Printf("No new repository metadata fetched, skipping write to %s", ext.repositoryMetadataSetFile)
		return nil
	}

	// Convert map to RepositoryMetadataSet
	metadataSet := &bzpb.RepositoryMetadataSet{
		RepositoryMetadata: make([]*bzpb.RepositoryMetadata, 0, len(ext.repositoriesMetadataByID)),
	}
	keys := slices.Sorted(maps.Keys(ext.repositoriesMetadataByID))
	for _, key := range keys {
		md := ext.repositoriesMetadataByID[key]
		metadataSet.RepositoryMetadata = append(metadataSet.RepositoryMetadata, md)
	}

	filename := os.ExpandEnv(ext.repositoryMetadataSetFile)
	if err := protoutil.WriteFile(filename, metadataSet); err != nil {
		return fmt.Errorf("failed to write repository metadata file %s: %w", filename, err)
	}

	log.Printf("Wrote %d repository metadata entries to %s", len(ext.repositoriesMetadataByID), filename)
	return nil
}
