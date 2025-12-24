package bcr

import (
	bzpb "github.com/bazel-contrib/bcr-frontend/build/stack/bazel/registry/v1"
	"github.com/bazel-contrib/bcr-frontend/pkg/presubmityml"
)

// readPresubmitYaml reads and parses a presubmit.yml file
func readPresubmitYaml(filename string) (*bzpb.Presubmit, error) {
	return presubmityml.ReadFile(filename)
}
