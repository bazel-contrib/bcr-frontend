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
bazel build -c opt //cmd/bazel_backend //tools/invocation-iroh
bazel_bin=$(bazel info -c opt bazel-bin)

exec "$script_dir/install.sh" \
  "$bazel_bin/cmd/bazel_backend/bazel_backend_/bazel_backend" \
  "$bazel_bin/tools/invocation-iroh/invocation-iroh"
