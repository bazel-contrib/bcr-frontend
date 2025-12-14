package bcr

import (
	"fmt"
	"log"
	"os"
	"slices"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/protoutil"
)

func (ext *bcrExtension) readBazelReleaseCacheFile() {
	if ext.bazelReleaseSetFile != "" {
		var bazelReleaseSet bzpb.BazelReleaseSet
		if err := protoutil.ReadFile(os.ExpandEnv(ext.bazelReleaseSetFile), &bazelReleaseSet); err != nil {
			log.Printf("warning: could not read bazel releases: %v", err)
			return
		}
		for _, release := range bazelReleaseSet.Release {
			ext.bazelReleasesByVersion[release.Version] = release
		}
		log.Printf("Loaded %d cached Bazel releases from %s", len(ext.bazelReleasesByVersion), ext.bazelReleaseSetFile)
	}
}

// writeBazelReleaseCacheFile writes the bazel release map back to the file it was loaded from
// Only writes if we actually fetched new releases during this run
func (ext *bcrExtension) writeBazelReleaseCacheFile() error {
	if ext.bazelReleaseSetFile == "" {
		// No file was specified, so nothing to write
		return nil
	}

	if !ext.fetchedBazelReleases {
		// No new releases were fetched, don't overwrite the cache
		log.Printf("No new Bazel releases fetched, skipping write to %s", ext.bazelReleaseSetFile)
		return nil
	}

	// Convert map to BazelReleaseSet
	releaseSet := &bzpb.BazelReleaseSet{
		Release: make([]*bzpb.BazelRelease, 0, len(ext.bazelReleasesByVersion)),
	}

	// Sort by version for deterministic output
	versions := make([]string, 0, len(ext.bazelReleasesByVersion))
	for version := range ext.bazelReleasesByVersion {
		versions = append(versions, version)
	}
	slices.Sort(versions)

	for _, version := range versions {
		release := ext.bazelReleasesByVersion[version]
		releaseSet.Release = append(releaseSet.Release, release)
	}

	filename := os.ExpandEnv(ext.bazelReleaseSetFile)
	if err := protoutil.WriteFile(filename, releaseSet); err != nil {
		return fmt.Errorf("failed to write bazel release file %s: %w", filename, err)
	}

	log.Printf("Wrote %d Bazel releases to %s", len(ext.bazelReleasesByVersion), filename)
	return nil
}
