#!/usr/bin/env bash
set -euo pipefail
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pi-hindsight-memory"
ENV_FILE="$CONFIG_DIR/hindsight.env"
OUTPUT="$CONFIG_DIR/import-approval.json"
USAGE='Usage: create-import-approval.sh MAX_INPUT_TOKENS MAX_COST_USD PRIVACY [INPUT_USD_PER_MILLION] [OUTPUT_USD_PER_MILLION]'
MAX_TOKENS=${1:?$USAGE}
MAX_COST=${2:?$USAGE}
PRIVACY=${3:?$USAGE}
INPUT_RATE=${4:-0}
OUTPUT_RATE=${5:-0}
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
[[ -r "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }
provider=$(awk -F= '/^HINDSIGHT_API_LLM_PROVIDER=/{print $2}' "$ENV_FILE")
model=$(awk -F= '/^HINDSIGHT_API_LLM_MODEL=/{print $2}' "$ENV_FILE")
[[ -n "$provider" && "$provider" != none && -n "$model" ]] || { echo "Configure a real Hindsight provider and model first" >&2; exit 1; }
[[ "$PRIVACY" == remote-redacted || "$PRIVACY" == local ]] || { echo "Privacy must be remote-redacted or local" >&2; exit 1; }
umask 077
jq -n --arg approvedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg provider "$provider" --arg model "$model" --arg privacy "$PRIVACY" --argjson tokens "$MAX_TOKENS" --argjson cost "$MAX_COST" --argjson inputRate "$INPUT_RATE" --argjson outputRate "$OUTPUT_RATE" '{approvedAt:$approvedAt,provider:$provider,model:$model,privacy:$privacy,maxEstimatedInputTokens:$tokens,maxEstimatedCostUsd:$cost,inputUsdPerMillionTokens:$inputRate,outputUsdPerMillionTokens:$outputRate,outputTokenMultiplier:0.25,maxFailureRate:0.05,minFreeBytes:10737418240}' > "$OUTPUT"
chmod 600 "$OUTPUT"
echo "Wrote approval for $provider/$model to $OUTPUT. Review it before starting the importer."
