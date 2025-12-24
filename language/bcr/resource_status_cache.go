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

func (ext *bcrExtension) readResourceStatusCacheFile() {
	if ext.resourceStatusSetFile != "" {
		var resourceStatusSet bzpb.ResourceStatusSet
		if err := protoutil.ReadFile(os.ExpandEnv(ext.resourceStatusSetFile), &resourceStatusSet); err != nil {
			log.Printf("warning: could not read resource statuses: %v", err)
		}
		for _, status := range resourceStatusSet.Status {
			ext.resourceStatusByUrl[status.Url] = status
		}
	}
}

// writeResourceStatusCacheFile writes the resource status map back to the file it was loaded from
func (ext *bcrExtension) writeResourceStatusCacheFile() error {
	if ext.resourceStatusSetFile == "" {
		// No file was specified, so nothing to write
		return nil
	}

	// Convert map to ResourceStatusSet
	statusSet := &bzpb.ResourceStatusSet{
		Status: make([]*bzpb.ResourceStatus, 0, len(ext.resourceStatusByUrl)),
	}
	urls := slices.Sorted(maps.Keys(ext.resourceStatusByUrl))
	for _, url := range urls {
		status := ext.resourceStatusByUrl[url]
		statusSet.Status = append(statusSet.Status, status)
	}

	filename := os.ExpandEnv(ext.resourceStatusSetFile)
	if err := protoutil.WriteFile(filename, statusSet); err != nil {
		return fmt.Errorf("failed to write resource status file %s: %w", filename, err)
	}

	log.Printf("Wrote %d resource statuses to %s", len(ext.resourceStatusByUrl), filename)
	return nil
}
