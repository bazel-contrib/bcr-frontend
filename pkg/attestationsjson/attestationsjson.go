package attestationsjson

import (
	"fmt"

	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/protoutil"
)

// ReadFile reads and parses an attestations.json file into an Attestations protobuf
func ReadFile(filename string) (*bzpb.Attestations, error) {
	var att bzpb.Attestations
	if err := protoutil.ReadFile(filename, &att); err != nil {
		return nil, fmt.Errorf("reading attestations json: %v", err)
	}
	return &att, nil
}
