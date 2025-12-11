package stardoc

import (
	"github.com/bazelbuild/bazel-gazelle/label"
	bzpb "github.com/stackb/centrl/build/stack/bazel/bzlmod/v1"
)

// ParseLabel parses a Bazel label string into its components
func ParseLabel(labelStr string) *bzpb.Label {
	l, err := label.Parse(labelStr)
	if err != nil {
		// If parsing fails, return empty label
		return &bzpb.Label{}
	}
	return ToLabel(l)
}

func ToLabel(l label.Label) *bzpb.Label {
	return &bzpb.Label{
		Repo: l.Repo,
		Pkg:  l.Pkg,
		Name: l.Name,
	}
}

func FromLabel(l *bzpb.Label) label.Label {
	return label.New(l.Repo, l.Pkg, l.Name)
}
