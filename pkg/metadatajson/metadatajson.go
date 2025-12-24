package metadatajson

import (
	"fmt"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

// ReadFile reads and parses a metadata.json file into a Metadata protobuf
func ReadFile(filename string) (*bzpb.ModuleMetadata, error) {
	var md bzpb.ModuleMetadata
	if err := protoutil.ReadFile(filename, &md); err != nil {
		return nil, fmt.Errorf("reading metadata json: %v", err)
	}
	return &md, nil
}
