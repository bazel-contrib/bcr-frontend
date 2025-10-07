package bcr

import (
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
	"github.com/stackb/centrl/pkg/presubmityml"
)

// readPresubmitYaml reads and parses a presubmit.yml file
func readPresubmitYaml(filename string) (*bzpb.Presubmit, error) {
	return presubmityml.ReadFile(filename)
}
