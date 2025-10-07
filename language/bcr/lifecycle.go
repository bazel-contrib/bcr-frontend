package bcr

import (
	"context"
)

// Before is called before any other lifecycle methods.
// This can be used to initialize resources needed during the build.
func (ext *bcrExtension) Before(ctx context.Context) {
	// Nothing to initialize before processing
}

// DoneGeneratingRules is called after all rules have been generated.
// This is the ideal place to detect circular dependencies since the
// complete dependency graph has been built.
func (ext *bcrExtension) DoneGeneratingRules() {
	// Detect and log any circular dependencies
	ext.logCycles()
}

// AfterResolvingDeps is called after all dependencies have been resolved.
// This can be used to clean up resources or perform final validation.
func (ext *bcrExtension) AfterResolvingDeps(ctx context.Context) {
	// Nothing to clean up after resolution
}
