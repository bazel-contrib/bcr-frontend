package bcr

import (
	"github.com/bazelbuild/bazel-gazelle/rule"
)

// protoRule holds a Gazelle rule together with its underlying protobuf data
type protoRule[T any] struct {
	rule  *rule.Rule
	proto T
}

// newProtoRule creates a new protoRule from a rule and proto
func newProtoRule[T any](r *rule.Rule, p T) *protoRule[T] {
	return &protoRule[T]{
		rule:  r,
		proto: p,
	}
}

// Rule returns the Gazelle rule
func (pr *protoRule[T]) Rule() *rule.Rule {
	return pr.rule
}

// Proto returns the underlying protobuf data
func (pr *protoRule[T]) Proto() T {
	return pr.proto
}
