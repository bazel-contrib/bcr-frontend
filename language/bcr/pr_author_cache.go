package bcr

import (
	"fmt"
	"log"
	"os"
	"slices"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

func (ext *bcrExtension) readPRAuthorCacheFile() {
	if ext.prAuthorSetFile != "" {
		var prAuthorSet bzpb.PRAuthorSet
		if err := protoutil.ReadFile(os.ExpandEnv(ext.prAuthorSetFile), &prAuthorSet); err != nil {
			log.Printf("warning: could not read PR authors cache: %v", err)
			return
		}
		for _, author := range prAuthorSet.Authors {
			ext.prAuthorsByPR[int(author.PullRequest)] = author
		}
		log.Printf("Loaded %d cached PR authors from %s", len(ext.prAuthorsByPR), ext.prAuthorSetFile)
	}
}

// writePRAuthorCacheFile writes the PR author map back to the file it was loaded from.
// Only writes if we actually fetched new PR authors during this run.
func (ext *bcrExtension) writePRAuthorCacheFile() error {
	if ext.prAuthorSetFile == "" {
		return nil
	}

	if !ext.fetchedPRAuthors {
		log.Printf("No new PR authors fetched, skipping write to %s", ext.prAuthorSetFile)
		return nil
	}

	prAuthorSet := &bzpb.PRAuthorSet{
		Authors: make([]*bzpb.PRAuthor, 0, len(ext.prAuthorsByPR)),
	}

	// Sort by PR number for deterministic output
	prNums := make([]int, 0, len(ext.prAuthorsByPR))
	for prNum := range ext.prAuthorsByPR {
		prNums = append(prNums, prNum)
	}
	slices.Sort(prNums)

	for _, prNum := range prNums {
		prAuthorSet.Authors = append(prAuthorSet.Authors, ext.prAuthorsByPR[prNum])
	}

	filename := os.ExpandEnv(ext.prAuthorSetFile)
	if err := protoutil.WriteFile(filename, prAuthorSet); err != nil {
		return fmt.Errorf("failed to write PR author cache file %s: %w", filename, err)
	}

	log.Printf("Wrote %d PR authors to %s", len(ext.prAuthorsByPR), filename)
	return nil
}
