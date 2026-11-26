#!/usr/bin/env bash
set -euo pipefail

crate=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$crate/../.." && pwd)
output=${1:-"$repo/app/bcr/iroh_wasm"}
bazel=${BAZEL:-bazel}

(cd "$repo" && "$bazel" build -c opt --action_env=PATH //tools/invocation-iroh:iroh_browser)
bazel_bin=$(cd "$repo" && "$bazel" info -c opt bazel-bin)
assets="$bazel_bin/tools/invocation-iroh/iroh_browser"
test -s "$assets/bcr_invocation_iroh.js"
test -s "$assets/bcr_invocation_iroh_bg.wasm"
mkdir -p "$output"
install -m 0644 "$assets/bcr_invocation_iroh.js" "$assets/bcr_invocation_iroh_bg.wasm" "$output/"
