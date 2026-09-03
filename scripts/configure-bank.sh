#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
npm run build >/dev/null
if [[ "${1:-}" == "" ]] && grep -q '^HINDSIGHT_API_LLM_PROVIDER=none$' "${XDG_CONFIG_HOME:-$HOME/.config}/pi-hindsight-memory/hindsight.env" 2>/dev/null; then
  node dist/src/importer/cli.js configure-bank --file "$ROOT/deploy/compose/bank-config.no-llm.json"
else
  node dist/src/importer/cli.js configure-bank "${@}"
fi
