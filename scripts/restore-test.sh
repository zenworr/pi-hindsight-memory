#!/usr/bin/env bash
set -euo pipefail

mode=strict
if [[ ${1:-} == --allow-uncoordinated ]]; then mode=allow; shift; fi
if [[ $# -ne 3 || -z $2 || -z $3 ]]; then
  echo 'Usage: restore-test.sh [--allow-uncoordinated] MANIFEST KNOWN_QUERY EXPECTED_DOCUMENT_ID' >&2
  exit 1
fi
MANIFEST=$1
QUERY=$2
EXPECTED_DOCUMENT=$3
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
helper="$ROOT/scripts/lib/backup.mjs"
node "$helper" inspect "$MANIFEST" "$mode"
BACKUP="$(dirname -- "$MANIFEST")/hindsight.dump"
ENGINE=$(container_engine)
COMPOSE_ENV="$ROOT/deploy/compose/.env"
value() { awk -F= -v key="$1" '$1==key {sub(/^[^=]*=/, ""); print; exit}' "$2"; }
POSTGRES_IMAGE=${POSTGRES_IMAGE:-$(value POSTGRES_IMAGE "$COMPOSE_ENV")}
HINDSIGHT_IMAGE=${HINDSIGHT_IMAGE:-$(value HINDSIGHT_IMAGE "$COMPOSE_ENV")}
[[ -n "$POSTGRES_IMAGE" && -n "$HINDSIGHT_IMAGE" ]] || { echo 'Set the restore images in the Compose environment or export POSTGRES_IMAGE and HINDSIGHT_IMAGE.' >&2; exit 1; }
POSTGRES_USER=restore_user
POSTGRES_PASSWORD=$(openssl rand -hex 32)
POSTGRES_DB=restore_test
API_TOKEN=$(openssl rand -hex 32)
umask 077
temporary=$(mktemp -d "${TMPDIR:-/tmp}/pi-hm-restore-XXXXXXXX")
name=$(basename -- "$temporary")
network="$name-net"
volume="$name-volume"
tmpenv="$temporary/restore.env"
cleanup() {
  "$ENGINE" rm -f "$name-app" "$name-db" >/dev/null 2>&1 || true
  "$ENGINE" volume rm "$volume" >/dev/null 2>&1 || true
  "$ENGINE" network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$API_TOKEN" > "$temporary/api-token"
"$ENGINE" network create "$network" >/dev/null
"$ENGINE" volume create "$volume" >/dev/null
"$ENGINE" run -d --name "$name-db" --network "$network" \
  -e POSTGRES_USER="$POSTGRES_USER" -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -e POSTGRES_DB="$POSTGRES_DB" \
  -v "$volume:/var/lib/postgresql" "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 60); do "$ENGINE" exec "$name-db" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && break; sleep 2; done
"$ENGINE" exec "$name-db" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
"$ENGINE" exec -i "$name-db" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error --no-owner --no-privileges --clean --if-exists < "$BACKUP"
cat > "$tmpenv" <<EOF
HINDSIGHT_API_DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@$name-db:5432/$POSTGRES_DB
HINDSIGHT_API_HOST=0.0.0.0
HINDSIGHT_API_PORT=8888
HINDSIGHT_API_TENANT_EXTENSION=hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension
HINDSIGHT_API_TENANT_API_KEY=$API_TOKEN
HINDSIGHT_CP_DATAPLANE_API_URL=http://$name-app:8888
HINDSIGHT_CP_DATAPLANE_API_KEY=$API_TOKEN
HINDSIGHT_API_WORKER_ID=$name-worker
HINDSIGHT_API_MCP_ENABLED=false
HINDSIGHT_API_LLM_PROVIDER=none
HINDSIGHT_API_EMBEDDINGS_PROVIDER=local
HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL=BAAI/bge-small-en-v1.5
HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU=true
HINDSIGHT_API_RERANKER_PROVIDER=local
HINDSIGHT_API_RERANKER_LOCAL_MODEL=cross-encoder/ms-marco-MiniLM-L-6-v2
HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU=true
HINDSIGHT_API_RERANKER_LOCAL_MAX_CONCURRENT=1
HINDSIGHT_API_STORE_DOCUMENT_TEXT=true
HINDSIGHT_API_ENABLE_OBSERVATIONS=true
HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false
HINDSIGHT_API_WORKER_MAX_SLOTS=2
HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS=0
EOF
"$ENGINE" run -d --name "$name-app" --network "$network" -p 127.0.0.1::8888 --env-file "$tmpenv" "$HINDSIGHT_IMAGE" >/dev/null
binding=$("$ENGINE" port "$name-app" 8888/tcp)
[[ "$binding" =~ ^127\.0\.0\.1:[0-9]+$ ]] || { echo 'Expected an isolated loopback API port.' >&2; exit 1; }
api="http://$binding"
for _ in $(seq 1 120); do curl -fsS --max-time 2 "$api/health" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS --max-time 2 "$api/health" >/dev/null
node "$helper" verify "$MANIFEST" "$mode" "$api" "$temporary/api-token" "$QUERY" "$EXPECTED_DOCUMENT"
