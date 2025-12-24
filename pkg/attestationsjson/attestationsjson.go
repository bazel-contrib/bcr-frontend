package attestationsjson

import (
	"fmt"

	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/protoutil"
)

// ReadFile reads and parses an attestations.json file into an Attestations protobuf
func ReadFile(filename string) (*bzpb.Attestations, error) {
	var att bzpb.Attestations
	if err := protoutil.ReadFile(filename, &att); err != nil {
		return nil, fmt.Errorf("reading attestations json: %v", err)
	}
	return &att, nil
}
