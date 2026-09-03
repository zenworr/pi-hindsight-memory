#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/pi-hindsight-memory/hindsight.env"
if grep -q '^HINDSIGHT_API_LLM_PROVIDER=none$' "$ENV_FILE"; then
  echo "Configure and approve a real extraction provider before finalizing the memory bank." >&2
  exit 1
fi
cd "$ROOT"
npm run build >/dev/null
node dist/src/importer/cli.js configure-bank --file "$ROOT/deploy/compose/bank-config.json" >/dev/null
node dist/src/importer/cli.js enable-auto-consolidation
