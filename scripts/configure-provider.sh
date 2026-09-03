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

umask 077
mkdir -p "$(state_dir)"
chmod 700 "$(state_dir)"
previous="$ENV_FILE.previous"
tmp=$(mktemp "$ENV_FILE.XXXXXX")
verification=$(mktemp "$(state_dir)/provider-verification.XXXXXX")
cp "$ENV_FILE" "$previous"
chmod 600 "$previous"
committed=0
cleanup() {
  status=$?
  rm -f "$tmp" "$verification"
  if [[ "$committed" -ne 1 && -r "$previous" ]]; then
    cp "$previous" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    compose_project up -d --force-recreate --no-deps hindsight-app >/dev/null 2>&1 || true
    echo "Provider verification failed; restored the previous Hindsight environment." >&2
  fi
  rm -f "$previous"
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
unset API_KEY

compose_project up -d --force-recreate --no-deps hindsight-app
api_url=$(jq -r '.hindsight.apiUrl' "$(config_dir)/config.json")
healthy=0
for _ in $(seq 1 120); do
  if curl -fsS "$api_url/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" -eq 1 ]] || { echo "Hindsight did not become healthy" >&2; exit 1; }
printf '%s\n' '{"role":"user","content":"Provider verification sentinel.","timestamp":"2026-01-01T00:00:00.000Z"}' > "$verification"
chmod 600 "$verification"
node "$ROOT/dist/src/importer/cli.js" dry-run-extract "$verification" --mode concise >/dev/null
committed=1
rm -f "$previous"
echo "Configured and verified $PROVIDER / $MODEL${REASONING:+ with reasoning=$REASONING}."
