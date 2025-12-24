package sourcejson

import (
	"fmt"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

// ReadFile reads and parses a source.json file into a Source protobuf
func ReadFile(filename string) (*bzpb.ModuleSource, error) {
	var src bzpb.ModuleSource
	if err := protoutil.ReadFile(filename, &src); err != nil {
		return nil, fmt.Errorf("reading source json: %v", err)
	}
	return &src, nil
}
