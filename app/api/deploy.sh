#!/bin/bash
set -euox pipefail

# Deploy script for Cloudflare Worker using Bazel-generated WASM
# Usage: bazel run //app/api:deploy [-- --env staging]

# Source the Bazel runfiles library for portable path resolution
# Find the runfiles directory (works for both bazel run and manual execution)
if [ -n "${RUNFILES_DIR:-}" ]; then
    RUNFILES="$RUNFILES_DIR"
elif [ -n "${RUNFILES_MANIFEST_FILE:-}" ]; then
    RUNFILES="$(dirname "$RUNFILES_MANIFEST_FILE")/$(basename "$RUNFILES_MANIFEST_FILE" _manifest)"
else
    # Fallback for direct execution
    RUNFILES="${0}.runfiles/_main"
fi

# Locate the WASM artifacts in runfiles (workspace name is _main, not stackb_centrl)
WASM_DIR="$RUNFILES/app/api/centrl_api_wasm"

# Create temporary build directory for deployment
BUILD_DIR="$(mktemp -d)"
trap "rm -rf '$BUILD_DIR'" EXIT

echo "📦 Preparing deployment artifacts..."

# Copy WASM files from runfiles
# Note: With target="web", wasm-bindgen only generates:
#   - centrl_api_wasm.js (contains all JS code)
#   - centrl_api_wasm_bg.wasm (the WASM binary)
#   - No separate _bg.js file
cp "$WASM_DIR/centrl_api_wasm_bg.wasm" "$BUILD_DIR/"
cp "$WASM_DIR/centrl_api_wasm.js" "$BUILD_DIR/"

# Copy snippets directory if it exists
if [ -d "$WASM_DIR/snippets" ]; then
    cp -r "$WASM_DIR/snippets" "$BUILD_DIR/"
fi

# Copy wrangler.toml configuration
cp "$RUNFILES/app/api/wrangler.toml" "$BUILD_DIR/"

# Create the main entry point that Cloudflare Workers expects
# With target="web", wasm-bindgen generates an init function we need to call
cat > "$BUILD_DIR/index.mjs" << 'EOF'
// Entry point for Cloudflare Workers
import init, { fetch as wasmFetch } from './centrl_api_wasm.js';
import wasm from './centrl_api_wasm_bg.wasm';

// Initialize WASM on first load
let initialized = false;
async function ensureInit() {
  if (!initialized) {
    await init(wasm);
    initialized = true;
  }
}

// Export the fetch handler for Cloudflare Workers
export default {
  async fetch(request, env, ctx) {
    await ensureInit();
    return wasmFetch(request, env, ctx);
  }
};
EOF

echo "📂 Deployment artifacts:"
ls -lh "$BUILD_DIR"

echo "🚀 Deploying to Cloudflare..."
cd "$BUILD_DIR"
npx wrangler deploy "$@"

echo "✅ Deployment complete!"
