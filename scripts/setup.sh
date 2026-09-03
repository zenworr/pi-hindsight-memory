#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
for command in node npm jq sqlite3 openssl curl git; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
ENGINE=$(container_engine)
"$ENGINE" info >/dev/null || { echo "$ENGINE is installed but not running" >&2; exit 1; }

cd "$ROOT"
npm ci
npm test
scripts/create-config.sh
scripts/prepare-deployment.sh
scripts/stack.sh up
API_URL=$(jq -r '.hindsight.apiUrl' "$(config_dir)/config.json")
echo "Waiting for the first Hindsight startup and model download..."
for _ in $(seq 1 450); do
  if curl -fsS "$API_URL/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "$API_URL/health" >/dev/null
scripts/verify-deployment.sh
scripts/configure-bank.sh
scripts/live-contract-smoke.sh
node dist/src/importer/cli.js doctor
cat <<'EOF'

Base setup passed. No real session was imported and no provider key was configured.
Next:
  1. Review ~/.config/pi-hindsight-memory/config.json.
  2. Run scripts/configure-provider.sh.
  3. Follow docs/SETUP-GUIDE.md from “Inventory and pilot”.
EOF
