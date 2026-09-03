#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
CONFIG_DIR=$(config_dir)
ENGINE=$(container_engine)
CONFIG_FILE="$CONFIG_DIR/config.json"
[[ -r "$CONFIG_FILE" ]] || { echo "Missing $CONFIG_FILE" >&2; exit 1; }
for command in curl jq; do command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }; done
[[ -s "$CONFIG_DIR/api-token" ]] || { echo "Missing API token" >&2; exit 1; }
API_URL=$(jq -r '.hindsight.apiUrl' "$CONFIG_FILE")
BANK_ID=$(jq -r '.hindsight.bankId' "$CONFIG_FILE")
API_PORT=${API_URL##*:}
API_PORT=${API_PORT%%/*}
UI_URL=$(jq -r '.hindsight.uiUrl // empty' "$CONFIG_FILE")
UI_PORT=${UI_URL##*:}
UI_PORT=${UI_PORT%%/*}
if [[ -z "$UI_URL" ]]; then
  UI_PORT=$(awk -F= '/^HINDSIGHT_UI_HOST_PORT=/{print $2}' "$ROOT/deploy/compose/.env")
  UI_PORT=${UI_PORT:-9999}
fi

curl -fsS "$API_URL/health" >/dev/null
curl -fsS "$API_URL/version" >/dev/null
status=$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/v1/default/banks")
[[ "$status" == 401 ]] || { echo "Expected unauthenticated API request to return 401, got $status" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $(<"$CONFIG_DIR/api-token")" "$API_URL/v1/default/banks" >/dev/null
"$ENGINE" inspect hindsight-db hindsight-app >/dev/null
[[ -z "$("$ENGINE" port hindsight-db 2>/dev/null)" ]] || { echo "PostgreSQL must not expose a host port" >&2; exit 1; }
"$ENGINE" port hindsight-app 8888/tcp | grep -Eq "^127\\.0\\.0\\.1:${API_PORT}$" || { echo "Hindsight API is not bound only to 127.0.0.1:$API_PORT" >&2; exit 1; }
"$ENGINE" port hindsight-app 9999/tcp | grep -Eq "^127\\.0\\.0\\.1:${UI_PORT}$" || { echo "Hindsight UI is not bound only to 127.0.0.1:$UI_PORT" >&2; exit 1; }
"$ENGINE" exec hindsight-db psql -U hindsight_user -d hindsight -Atc "SELECT 1 FROM pg_extension WHERE extname='vector'" | grep -q '^1$'
signature_status=$(awk -F= '/^HINDSIGHT_SIGNATURE_STATUS=/{print $2}' "$ROOT/deploy/compose/versions.env" 2>/dev/null || true)
[[ "$signature_status" == verified ]] || echo "WARNING: Hindsight signature status is ${signature_status:-unknown}; image digests are still pinned." >&2
printf 'Deployment verification passed for bank %s using %s.\n' "$BANK_ID" "$ENGINE"
