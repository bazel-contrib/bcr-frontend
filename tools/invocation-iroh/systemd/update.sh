#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --help ]]; then
  printf 'Usage: %s\nBuild and install both user services from this checkout.\n' "${0##*/}"
  exit 0
fi
if (( $# != 0 )); then
  printf 'Usage: %s\n' "${0##*/}" >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "$script_dir/../../.."
manifest=tools/invocation-iroh/Cargo.toml
target_dir=${CARGO_TARGET_DIR:-tools/invocation-iroh/target}
host=$(rustc +1.95.0 -vV | awk '/^host: / { print $2 }')
[[ -n $host ]]

bazel build //cmd/besserver
bazel_bin=$(bazel info bazel-bin)
cargo +1.95.0 build --locked --release --manifest-path "$manifest" \
  --target-dir "$target_dir" --target "$host" --bin invocation-iroh

exec "$script_dir/install.sh" \
  "$bazel_bin/cmd/besserver/besserver_/besserver" \
  "$target_dir/$host/release/invocation-iroh"
