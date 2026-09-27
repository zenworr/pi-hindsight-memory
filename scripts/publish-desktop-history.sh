#!/usr/bin/env bash
set -euo pipefail

if (($#)); then
  printf 'Usage: %s\n' "$0" >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
state="$HOME/.local/state/pi-hindsight-memory/publisher"
remote_base="/home/shawor/.local/state/pi-hindsight-memory/desktop-feed"
install -d -m 700 "$state"
exec 9>"$state/lock"
flock -n 9 || { printf 'Another history publication is running\n' >&2; exit 1; }
chmod 600 "$state/lock"

generation="desktop-$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
local_capture="$state/$generation"
cleanup() {
  rm -rf -- "$local_capture"
  # Never remove the published generation, even if the SSH reply was lost.
  ssh -o BatchMode=yes dev "rm -rf -- '$remote_base/incoming/$generation'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

python3 "$script_dir/publish-desktop-history.py" capture --output "$local_capture" --generation "$generation"
ssh -o BatchMode=yes dev "install -d -m 700 '$remote_base' '$remote_base/incoming'"
rsync -a --chmod=Du=rwx,Dgo=,Fu=rw,Fgo= \
  "$script_dir/publish-desktop-history.py" "dev:$remote_base/.publisher.py"
rsync_options=(-a --checksum "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=")
if ssh -o BatchMode=yes dev "test -f '$remote_base/current/manifest.json'"; then
  rsync_options+=("--link-dest=$remote_base/current")
fi
rsync "${rsync_options[@]}" "$local_capture/" "dev:$remote_base/incoming/$generation/"
ssh -o BatchMode=yes dev \
  "python3 '$remote_base/.publisher.py' promote --base '$remote_base' --generation '$generation'"
printf 'Published desktop history generation: %s\n' "$generation"
