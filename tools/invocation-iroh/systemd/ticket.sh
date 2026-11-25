#!/usr/bin/env bash
set -euo pipefail

connection="${XDG_RUNTIME_DIR:?Run this in the service account login session}/bcr-invocation-iroh/connection"
if [[ ! -r $connection ]] || ! awk '
  /^Viewer ticket: bcr-iroh-v1:[A-Za-z0-9_-]+$/ { print $3; found = 1 }
  END { exit !found }
' "$connection"; then
  printf 'The Iroh ticket is unavailable. Check systemctl --user status bcr-invocation-iroh.service.\n' >&2
  exit 1
fi
