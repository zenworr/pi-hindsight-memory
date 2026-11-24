#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
ENV_FILE="$(config_dir)/hindsight.env"
PROVIDER=openai-responses
MODEL=
REASONING=
BASE_URL=
KEY_ENV=

usage() {
  cat <<'EOF'
Usage: configure-provider.sh [options]

Options:
  --provider NAME       Hindsight provider (default: openai-responses)
  --model NAME          Model ID (required)
  --reasoning LEVEL     Optional: none, low, medium, high, or xhigh
  --base-url URL        Optional OpenAI-compatible endpoint
  --api-key-env NAME    Read the key from this environment variable

Without --api-key-env, the script securely prompts for the API key.
The old provider is restored automatically if restart or extraction verification fails.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER=${2:?}; shift 2 ;;
    --model) MODEL=${2:?}; shift 2 ;;
    --reasoning) REASONING=${2:?}; shift 2 ;;
    --base-url) BASE_URL=${2:?}; shift 2 ;;
    --api-key-env) KEY_ENV=${2:?}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -r "$ENV_FILE" ]] || { echo "Missing $ENV_FILE; run scripts/prepare-deployment.sh first" >&2; exit 1; }
for command in jq curl node; do command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }; done
[[ -n "$MODEL" ]] || { echo "--model is required" >&2; exit 1; }
case "$REASONING" in ""|none|low|medium|high|xhigh) ;; *) echo "Invalid reasoning level: $REASONING" >&2; exit 1;; esac
if [[ -n "$KEY_ENV" ]]; then
  API_KEY=${!KEY_ENV:-}
  [[ -n "$API_KEY" ]] || { echo "$KEY_ENV is empty" >&2; exit 1; }
elif [[ -n "${HINDSIGHT_LLM_API_KEY:-}" ]]; then
  API_KEY=$HINDSIGHT_LLM_API_KEY
elif [[ -t 0 ]]; then
  printf 'OpenAI API key: ' >&2
  IFS= read -r -s API_KEY
  printf '\n' >&2
else
  echo "Use --api-key-env NAME or set HINDSIGHT_LLM_API_KEY" >&2
  exit 1
fi
[[ -n "$API_KEY" && "$API_KEY" != *$'\n'* && "$API_KEY" != *$'\r'* ]] || { echo "Invalid API key" >&2; exit 1; }

config_file=${PI_HINDSIGHT_CONFIG:-$(config_dir)/config.json}
api_url=${PI_HINDSIGHT_API_URL:-$(jq -er '.hindsight.apiUrl | strings | select(length > 0)' "$config_file")}
wait_for_health() {
  for _ in $(seq 1 120); do
    if curl -fsS --max-time 5 "${api_url%/}/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

umask 077
mkdir -p "$(state_dir)"
chmod 700 "$(state_dir)"
previous=$(mktemp "$ENV_FILE.previous.XXXXXX")
cp "$ENV_FILE" "$previous"
tmp=$(mktemp "$ENV_FILE.XXXXXX")
verification=$(mktemp "$(state_dir)/provider-verification.XXXXXX")
rollback=0
cleanup() {
  local status=$?
  if [[ "$rollback" -eq 1 ]]; then
    if cp "$previous" "$tmp" && chmod 600 "$tmp" && mv "$tmp" "$ENV_FILE" \
      && compose_project up -d --force-recreate --no-deps hindsight-app >/dev/null 2>&1 && wait_for_health; then
      echo "Provider verification failed; restored the previous Hindsight environment." >&2
      rm -f "$previous"
    else
      echo "Provider verification failed and rollback could not be verified. Previous environment saved at $previous." >&2
    fi
  else
    rm -f "$previous"
  fi
  rm -f "$tmp" "$verification"
  return "$status"
}
trap cleanup EXIT

awk '!/^HINDSIGHT_API_LLM_(PROVIDER|API_KEY|MODEL|BASE_URL|REASONING_EFFORT|TEMPERATURE|STRICT_SCHEMA)=/' "$ENV_FILE" > "$tmp"
{
  printf 'HINDSIGHT_API_LLM_PROVIDER=%s\n' "$PROVIDER"
  printf 'HINDSIGHT_API_LLM_API_KEY=%s\n' "$API_KEY"
  printf 'HINDSIGHT_API_LLM_MODEL=%s\n' "$MODEL"
  [[ -z "$BASE_URL" ]] || printf 'HINDSIGHT_API_LLM_BASE_URL=%s\n' "$BASE_URL"
  [[ -z "$REASONING" ]] || printf 'HINDSIGHT_API_LLM_REASONING_EFFORT=%s\n' "$REASONING"
  printf 'HINDSIGHT_API_LLM_TEMPERATURE=none\n'
  printf 'HINDSIGHT_API_LLM_STRICT_SCHEMA=true\n'
} >> "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"
rollback=1
unset API_KEY

compose_project up -d --force-recreate --no-deps hindsight-app
wait_for_health || { echo "Hindsight did not become healthy" >&2; exit 1; }
printf '%s\n' '{"role":"user","content":"On January 1, 2026, I selected PostgreSQL as the database for the synthetic Acorn inventory project after its transaction recovery test passed.","timestamp":"2026-01-01T00:00:00.000Z"}' > "$verification"
if ! node "$ROOT/dist/src/importer/cli.js" dry-run-extract "$verification" --mode concise --config "$config_file" 2>/dev/null \
  | jq -es 'length == 1 and (.[0].facts | type == "array" and any(.[]; (.text | strings | test("\\S"))))' >/dev/null 2>&1; then
  echo "Provider dry run did not return an extracted fact." >&2
  exit 1
fi
rollback=0
echo "Configured and verified $PROVIDER / $MODEL${REASONING:+ with reasoning=$REASONING}."
