package sourcejson

import (
	"fmt"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/protoutil"
)

// ReadFile reads and parses a source.json file into a Source protobuf
func ReadFile(filename string) (*bzpb.Source, error) {
	var src bzpb.Source
	if err := protoutil.ReadFile(filename, &src); err != nil {
		return nil, fmt.Errorf("reading source json: %v", err)
	}
	return &src, nil
}
