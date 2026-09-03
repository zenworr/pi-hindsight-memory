#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
COUNT=${1:-20}
MAX_BYTES=${2:-1048576}
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pi-hindsight-memory"
REPORT_DIR="$STATE_DIR/reports"
mkdir -p "$REPORT_DIR"
chmod 700 "$REPORT_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
inventory="$REPORT_DIR/inventory-$stamp.json"
pilot="$REPORT_DIR/pilot-$stamp.json"
results="$REPORT_DIR/pilot-results-$stamp.json"
cd "$ROOT"
npm run build >/dev/null
node dist/src/importer/cli.js inventory --output "$inventory"
node dist/src/importer/cli.js select-pilot "$inventory" --count "$COUNT" --max-bytes "$MAX_BYTES" > "$pilot"
chmod 600 "$inventory" "$pilot"
node dist/src/importer/cli.js run-pilot "$pilot" "$results"
errors=$(jq '[.[] | select(.error)] | length' "$results")
printf 'Pilot complete: %s sessions, %s errors.\n' "$COUNT" "$errors"
printf 'Inventory: %s\nPilot: %s\nResults: %s\n' "$inventory" "$pilot" "$results"
[[ "$errors" -eq 0 ]] || exit 1
