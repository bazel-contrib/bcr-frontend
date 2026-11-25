#!/usr/bin/env bash
set -euo pipefail

crate=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$crate/../.." && pwd)
output=${1:-"$repo/app/bcr/iroh_wasm"}
target=${CARGO_TARGET_DIR:-"$crate/target"}
if [[ "$(wasm-bindgen --version)" != "wasm-bindgen 0.2.130" ]]; then
  echo 'Install wasm-bindgen-cli 0.2.130 before building the viewer.' >&2
  exit 1
fi

cargo build --locked --manifest-path "$crate/Cargo.toml" \
  --target-dir "$target" --target wasm32-unknown-unknown --release --lib
wasm-bindgen --target web --no-typescript --out-dir "$output" \
  --out-name bcr_invocation_iroh "$target/wasm32-unknown-unknown/release/invocation_iroh.wasm"
