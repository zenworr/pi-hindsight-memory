#!/usr/bin/env bash
set -euo pipefail
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pi-hindsight-memory"
ENV_FILE="$CONFIG_DIR/hindsight.env"
OUTPUT="$CONFIG_DIR/import-approval.json"
USAGE='Usage: create-import-approval.sh MAX_INPUT_TOKENS_OR_NULL MAX_COST_USD PRIVACY [INPUT_USD_PER_MILLION] [OUTPUT_USD_PER_MILLION]'
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
tmp=$(mktemp "$CONFIG_DIR/.import-approval.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
jq -n --arg approvedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg provider "$provider" --arg model "$model" --arg privacy "$PRIVACY" --argjson tokens "$MAX_TOKENS" --argjson cost "$MAX_COST" --argjson inputRate "$INPUT_RATE" --argjson outputRate "$OUTPUT_RATE" '
  def nonnegative: type == "number" and isfinite and . >= 0;
  if ($tokens != null and ($tokens | nonnegative and . > 0 and . <= 9007199254740991 and . == floor | not)) then
    error("Token limit must be a positive safe integer or null")
  elif ([$cost, $inputRate, $outputRate] | all(nonnegative) | not) then
    error("Cost and prices must be finite non-negative numbers")
  else
    {approvedAt:$approvedAt,provider:$provider,model:$model,privacy:$privacy,maxEstimatedInputTokens:$tokens,maxEstimatedCostUsd:$cost,inputUsdPerMillionTokens:$inputRate,outputUsdPerMillionTokens:$outputRate,outputTokenMultiplier:0.25,maxFailureRate:0.05,minFreeBytes:10737418240}
  end' > "$tmp"
chmod 600 "$tmp"
[[ ! -d "$OUTPUT" ]] || { echo "Approval path is a directory: $OUTPUT" >&2; exit 1; }
mv -f -- "$tmp" "$OUTPUT"
echo "Wrote approval for $provider/$model to $OUTPUT. Review it before starting the importer."
