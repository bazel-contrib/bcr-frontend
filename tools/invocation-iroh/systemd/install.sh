#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s /path/to/bazel_backend /path/to/invocation-iroh\n' "${0##*/}"
}

if [[ ${1:-} == --help ]]; then
  usage
  exit 0
fi
if (( $# != 2 )); then
  usage >&2
  exit 2
fi
for binary in "$@"; do
  if [[ ! -f $binary || ! -x $binary ]]; then
    printf 'Expected an executable binary at %s\n' "$binary" >&2
    exit 1
  fi
done
systemctl --user show-environment >/dev/null

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
app_dir="${XDG_DATA_HOME:-$HOME/.local/share}/bcr-invocation-observer"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
units=(bcr-bazel-backend.service bcr-invocation-iroh.service)
# Retire the pre-rename unit so it does not keep the configured listeners bound.
legacy_unit=bcr-besserver.service
install -d -- "$app_dir/releases" "$unit_dir"
exec {install_lock}>"$app_dir/install.lock"
flock "$install_lock"

previous=
if [[ -L $app_dir/current ]]; then
  previous=$(readlink -- "$app_dir/current")
elif [[ -e $app_dir/current ]]; then
  printf 'Expected %s/current to be a symlink.\n' "$app_dir" >&2
  exit 1
fi

stage=$(mktemp -d "$app_dir/releases/release.XXXXXXXXXX")
unit_tmp=
cleanup() {
  if [[ -n $unit_tmp ]]; then rm -f -- "$unit_tmp"; fi
  if [[ -n $stage && $(readlink -- "$app_dir/current" || true) != "releases/${stage##*/}" ]]; then
    rm -f -- "$stage/bazel_backend" "$stage/invocation-iroh" "$stage/current"
    rmdir -- "$stage"
  fi
}
trap cleanup EXIT
install -m 0755 -- "$1" "$stage/bazel_backend"
install -m 0755 -- "$2" "$stage/invocation-iroh"
if [[ -f $unit_dir/$legacy_unit ]]; then
  if [[ -d $unit_dir/$legacy_unit.d && ! -e $unit_dir/${units[0]}.d ]]; then
    cp -a -- "$unit_dir/$legacy_unit.d" "$unit_dir/${units[0]}.d"
  fi
  systemctl --user disable --now "$legacy_unit"
fi
for unit in "${units[@]}"; do
  unit_tmp=$(mktemp "$unit_dir/.$unit.XXXXXXXXXX")
  install -m 0644 -- "$script_dir/$unit" "$unit_tmp"
  mv -fT -- "$unit_tmp" "$unit_dir/$unit"
  unit_tmp=
done

release="releases/${stage##*/}"
ln -s -- "$release" "$stage/current"
mv -fT -- "$stage/current" "$app_dir/current"
stage=
systemctl --user daemon-reload
systemctl --user restart "${units[@]}"
systemctl --user enable "${units[@]}"

if [[ $previous =~ ^releases/release\.[[:alnum:]]{10}$ && $previous != "$release" &&
      -d $app_dir/$previous && ! -L $app_dir/$previous && -f $app_dir/$previous/bazel_backend ]]; then
  rm -f -- "$app_dir/$previous/bazel_backend" "$app_dir/$previous/invocation-iroh"
  rmdir --ignore-fail-on-non-empty -- "$app_dir/$previous"
fi
printf 'Installed bcr-bazel-backend.service and bcr-invocation-iroh.service.\n'
printf 'Run %s/ticket.sh after the companion connects to its relay.\n' "$script_dir"
