#!/usr/bin/env bash
set -euo pipefail
BACKUP=${1:?Usage: restore-pi-settings.sh SETTINGS_BACKUP}
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$AGENT_DIR/settings.json"
[[ -r "$BACKUP" ]] || { echo "Backup is not readable: $BACKUP" >&2; exit 1; }
[[ -r "$SETTINGS" ]] || { echo "Pi settings are not readable: $SETTINGS" >&2; exit 1; }
before="$SETTINGS.before-restore.$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$SETTINGS" "$before"
chmod 600 "$before"
cp -p "$BACKUP" "$SETTINGS"
chmod 600 "$SETTINGS"
echo "Pi settings restored. Restart Pi or run /reload."
