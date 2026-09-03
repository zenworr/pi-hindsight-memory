#!/usr/bin/env bash
set -euo pipefail
N=${1:?Usage: configure-concurrency.sh POSITIVE_INTEGER}
[[ "$N" =~ ^[1-9][0-9]*$ ]] || { echo "Concurrency must be a positive integer" >&2; exit 1; }
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
CONFIG_FILE="$(config_dir)/config.json"
ENV_FILE="$(config_dir)/hindsight.env"
for file in "$CONFIG_FILE" "$ENV_FILE"; do [[ -r "$file" ]] || { echo "Missing $file" >&2; exit 1; }; done
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
umask 077
config_tmp=$(mktemp "$CONFIG_FILE.XXXXXX")
env_tmp=$(mktemp "$ENV_FILE.XXXXXX")
trap 'rm -f "$config_tmp" "$env_tmp"' EXIT
jq --argjson n "$N" '.maxInflightDocuments=$n' "$CONFIG_FILE" > "$config_tmp"
awk '!/^HINDSIGHT_API_(DB_POOL_MAX_SIZE|RETAIN_MAX_CONCURRENT|RETAIN_LLM_MAX_CONCURRENT|LLM_MAX_CONCURRENT|WORKER_MAX_SLOTS)=/' "$ENV_FILE" > "$env_tmp"
cat >> "$env_tmp" <<EOF
HINDSIGHT_API_DB_POOL_MAX_SIZE=$N
HINDSIGHT_API_RETAIN_MAX_CONCURRENT=$N
HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT=$N
HINDSIGHT_API_LLM_MAX_CONCURRENT=$N
HINDSIGHT_API_WORKER_MAX_SLOTS=$N
EOF
chmod 600 "$config_tmp" "$env_tmp"
mv "$config_tmp" "$CONFIG_FILE"
mv "$env_tmp" "$ENV_FILE"
trap - EXIT
compose_project up -d --force-recreate --no-deps hindsight-app
echo "Set importer and Hindsight retain concurrency to $N. Consolidation remains serial by design."
