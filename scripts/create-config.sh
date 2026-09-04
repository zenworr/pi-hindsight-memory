#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
CONFIG_DIR=$(config_dir)
STATE_DIR=$(state_dir)
CONFIG_FILE="$CONFIG_DIR/config.json"
BANK_ID=${PI_HINDSIGHT_BANK_ID:-coding-history}
MAX_INFLIGHT=${PI_HINDSIGHT_MAX_INFLIGHT:-4}
SETTLE_SECONDS=${PI_HINDSIGHT_SETTLE_SECONDS:-60}
API_PORT=${PI_HINDSIGHT_API_PORT:-8888}
PI_AGENT_DIR=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
CODEX_DIR=${CODEX_HOME:-$HOME/.codex}
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
DATA_DIR=${XDG_DATA_HOME:-$HOME/.local/share}
PI_SESSIONS=${PI_HINDSIGHT_PI_SESSIONS:-$PI_AGENT_DIR/sessions}
CODEX_SESSIONS=${PI_HINDSIGHT_CODEX_SESSIONS:-$CODEX_DIR/sessions}
CLAUDE_SESSIONS=${PI_HINDSIGHT_CLAUDE_SESSIONS:-$CLAUDE_DIR/projects}
OPENCODE_DIR=${PI_HINDSIGHT_OPENCODE_DIR:-$DATA_DIR/opencode}
CODEX_STATE_DB=${PI_HINDSIGHT_CODEX_STATE_DB:-$CODEX_DIR/state_5.sqlite}
OPENCODE_DB=${PI_HINDSIGHT_OPENCODE_DB:-$OPENCODE_DIR/opencode.db}
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$STATE_DIR/reports" "$STATE_DIR/canonical"
chmod 700 "$CONFIG_DIR" "$STATE_DIR" "$STATE_DIR/reports" "$STATE_DIR/canonical"
if [[ -e "$CONFIG_FILE" && "$FORCE" -ne 1 ]]; then
  echo "Keeping existing $CONFIG_FILE"
  exit 0
fi

umask 077
jq -n \
  --arg state "$STATE_DIR" \
  --arg config "$CONFIG_DIR" \
  --arg piSessions "$PI_SESSIONS" \
  --arg codexSessions "$CODEX_SESSIONS" \
  --arg claudeSessions "$CLAUDE_SESSIONS" \
  --arg opencodeDir "$OPENCODE_DIR" \
  --arg codexDb "$CODEX_STATE_DB" \
  --arg opencodeDb "$OPENCODE_DB" \
  --arg bank "$BANK_ID" \
  --arg api "http://127.0.0.1:$API_PORT" \
  --arg ui "http://127.0.0.1:${PI_HINDSIGHT_UI_PORT:-9999}" \
  --argjson maxInflight "$MAX_INFLIGHT" \
  --argjson settleSeconds "$SETTLE_SECONDS" \
  '{
    stateDirectory:$state,
    stateDatabase:($state + "/state.sqlite3"),
    reportDirectory:($state + "/reports"),
    spoolDirectory:($state + "/canonical"),
    approvalFile:($config + "/import-approval.json"),
    sessionExclusions:{exactLabels:[]},
    sessionSettleSeconds:$settleSeconds,
    maxInflightDocuments:$maxInflight,
    sourceRoots:{pi:$piSessions,codex:$codexSessions,claude:$claudeSessions,opencode:$opencodeDir},
    codexStateDatabase:$codexDb,
    opencodeDatabase:$opencodeDb,
    hindsight:{
      apiUrl:$api,
      uiUrl:$ui,
      bankId:$bank,
      minRelevanceScore:0.01,
      apiTokenFile:($config + "/api-token"),
      environmentFile:($config + "/hindsight.env")
    }
  }' > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"
echo "Created $CONFIG_FILE"
echo "Review sourceRoots and sessionExclusions.exactLabels before inventory."
