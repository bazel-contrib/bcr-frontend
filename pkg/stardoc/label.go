package stardoc

import (
	"log"

	slpb "github.com/bazel-contrib/bcr-frontend/build/stack/starlark/v1beta1"
	"github.com/bazelbuild/bazel-gazelle/label"
)

// ParseLabel parses a Bazel label string into its components
func ParseLabel(labelStr string) *slpb.Label {
	l, err := label.Parse(labelStr)
	if err != nil {
		log.Printf("Bad Label: %q: %v", labelStr, err)
		// If parsing fails, return empty label
		return &slpb.Label{}
	}
	return ToLabel(l)
}

func ToLabel(l label.Label) *slpb.Label {
	return &slpb.Label{
		Repo: l.Repo,
		Pkg:  l.Pkg,
		Name: l.Name,
	}
}

func LabelFromProto(l *slpb.Label) label.Label {
	return label.New(l.Repo, l.Pkg, l.Name)
}
