#!/usr/bin/env bash
set -euo pipefail

if (($#)); then
  printf 'Usage: %s\n' "$0" >&2
  exit 2
fi

unit=pi-hindsight-importer.service
base="$HOME/.local/state/pi-hindsight-memory/desktop-feed"
test -f "$base/.publisher.py" || { printf 'Verified feed publisher is not installed\n' >&2; exit 1; }
systemctl --user is-active --quiet "$unit" || { printf 'Importer is not active; refusing maintenance\n' >&2; exit 1; }

restart() {
  status=$?
  if ! systemctl --user start "$unit"; then
    printf 'CRITICAL: importer restart failed\n' >&2
    exit 1
  fi
  exit "$status"
}
trap restart EXIT
systemctl --user stop "$unit"
python3 "$base/.publisher.py" prune --base "$base" --keep 4
systemctl --user start "$unit"
systemctl --user is-active --quiet "$unit"
trap - EXIT
