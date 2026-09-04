#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$AGENT_DIR/settings.json"
BACKUP_ROOT="${PI_HINDSIGHT_BACKUP_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/pi-hindsight-memory/backups}"
BACKUP_DIR="$BACKUP_ROOT/pi-install"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$BACKUP_DIR/settings-$stamp.json"
success=0

for command in jq node npm pi; do command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }; done
[[ -r "$SETTINGS" ]] || { echo "Missing Pi settings: $SETTINGS" >&2; exit 1; }
cd "$ROOT"
npm run build >/dev/null
node dist/src/importer/cli.js scan --force >/dev/null
node dist/src/importer/cli.js verify-ready >/dev/null || {
  echo "Pi installation readiness failed. Run 'node dist/src/importer/cli.js verify-ready' for details." >&2
  exit 1
}

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_ROOT" "$BACKUP_DIR"
cp -p "$SETTINGS" "$backup"
chmod 600 "$backup"
pi list > "$BACKUP_DIR/packages-$stamp.txt"
chmod 600 "$BACKUP_DIR/packages-$stamp.txt"

restore_on_failure() {
  status=$?
  if [[ $success -eq 0 ]]; then
    cp -p "$backup" "$SETTINGS"
    chmod 600 "$SETTINGS"
    echo "Pi installation failed; restored $SETTINGS from $backup" >&2
  fi
  return "$status"
}
trap restore_on_failure EXIT

pi install "$ROOT"
package_source=$(node -e 'console.log(require("node:path").relative(process.argv[1], process.argv[2]))' "$AGENT_DIR" "$ROOT")
if ! jq -e --arg root "$ROOT" --arg source "$package_source" '.packages[]? | select((type == "string" and (. == $root or . == $source)) or (type == "object" and ((.source? // "") == $root or (.source? // "") == $source)))' "$SETTINGS" >/dev/null; then
  echo "The Hindsight package was not registered in $SETTINGS" >&2
  exit 1
fi

success=1
trap - EXIT
echo "Pi extension installation complete. Restart Pi or run /reload in each existing Pi process."
echo "Settings backup: $backup"
