#!/usr/bin/env bash
set -euo pipefail

BACKUP=${1:?Usage: restore-test.sh POSTGRES_DUMP [QUERY]}
QUERY=${2:-PostgreSQL}
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
CONFIG_DIR=$(config_dir)
ENGINE=$(container_engine)
COMPOSE_ENV="$ROOT/deploy/compose/.env"
RUNTIME_ENV="$CONFIG_DIR/hindsight.env"
CONFIG_FILE="$CONFIG_DIR/config.json"
for command in curl jq sqlite3; do command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }; done
backup_name=$(basename "$BACKUP")
case "$backup_name" in
  hindsight-*.dump) stamp=${backup_name#hindsight-}; stamp=${stamp%.dump} ;;
  *) echo "Backup name must be hindsight-TIMESTAMP.dump" >&2; exit 1 ;;
esac
backup_directory=$(cd -- "$(dirname -- "$BACKUP")" && pwd)
BACKUP="$backup_directory/$backup_name"
STATE_BACKUP="$backup_directory/state-$stamp.sqlite3"
CHECKSUMS="$backup_directory/SHA256SUMS-$stamp"
for file in "$BACKUP" "$STATE_BACKUP" "$CHECKSUMS" "$COMPOSE_ENV" "$RUNTIME_ENV" "$CONFIG_FILE"; do [[ -r "$file" ]] || { echo "Missing readable file: $file" >&2; exit 1; }; done
(
  cd "$backup_directory"
  verify_sha256_manifest "$(basename "$CHECKSUMS")" >/dev/null
)
[[ "$(sqlite3 -readonly "$STATE_BACKUP" 'PRAGMA integrity_check;')" == ok ]] || { echo "State backup integrity check failed" >&2; exit 1; }
expected_documents=$(sqlite3 -readonly -noheader "$STATE_BACKUP" "SELECT count(DISTINCT s.document_id) FROM sessions s JOIN generations g ON g.source=s.source AND g.native_session_id=s.native_session_id WHERE g.state='completed';")
[[ "$expected_documents" =~ ^[1-9][0-9]*$ ]] || { echo "State backup has no completed documents" >&2; exit 1; }
value() { awk -F= -v key="$1" '$1==key {sub(/^[^=]*=/, ""); print; exit}' "$2"; }
POSTGRES_IMAGE=$(value POSTGRES_IMAGE "$COMPOSE_ENV")
HINDSIGHT_IMAGE=$(value HINDSIGHT_IMAGE "$COMPOSE_ENV")
DB_VERSION=$(value HINDSIGHT_DB_VERSION "$COMPOSE_ENV")
POSTGRES_USER=$(value POSTGRES_USER "$RUNTIME_ENV")
POSTGRES_PASSWORD=$(value POSTGRES_PASSWORD "$RUNTIME_ENV")
POSTGRES_DB=$(value POSTGRES_DB "$RUNTIME_ENV")
BANK_ID=$(jq -r '.hindsight.bankId' "$CONFIG_FILE")
API_TOKEN=$(<"$CONFIG_DIR/api-token")
name="pi-hm-restore-$$"
network="$name-net"
volume="$name-volume"
tmpenv=$(mktemp "${TMPDIR:-/tmp}/$name.XXXXXX")
cleanup() {
  "$ENGINE" rm -f "$name-db" "$name-app" >/dev/null 2>&1 || true
  "$ENGINE" volume rm "$volume" >/dev/null 2>&1 || true
  "$ENGINE" network rm "$network" >/dev/null 2>&1 || true
  rm -f "$tmpenv"
}
trap cleanup EXIT
"$ENGINE" network create "$network" >/dev/null
"$ENGINE" volume create "$volume" >/dev/null
"$ENGINE" run -d --name "$name-db" --network "$network" \
  -e POSTGRES_USER="$POSTGRES_USER" -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -e POSTGRES_DB="$POSTGRES_DB" \
  -v "$volume:/var/lib/postgresql/${DB_VERSION:-18}/docker" "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 60); do "$ENGINE" exec "$name-db" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && break; sleep 2; done
"$ENGINE" exec "$name-db" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null
"$ENGINE" cp "$BACKUP" "$name-db:/restore.dump"
"$ENGINE" exec "$name-db" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists /restore.dump
awk -v url="postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@$name-db:5432/$POSTGRES_DB" '
  /^HINDSIGHT_API_DATABASE_URL=/ {print "HINDSIGHT_API_DATABASE_URL=" url; next}
  /^HINDSIGHT_API_LLM_PROVIDER=/ {print "HINDSIGHT_API_LLM_PROVIDER=none"; next}
  /^HINDSIGHT_API_LLM_(API_KEY|MODEL|BASE_URL|REASONING_EFFORT)=/ {next}
  {print}
' "$RUNTIME_ENV" > "$tmpenv"
chmod 600 "$tmpenv"
"$ENGINE" run -d --name "$name-app" --network "$network" -p 127.0.0.1:18888:8888 --env-file "$tmpenv" "$HINDSIGHT_IMAGE" >/dev/null
for _ in $(seq 1 120); do curl -fsS http://127.0.0.1:18888/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:18888/health >/dev/null
actual_documents=$("$ENGINE" exec "$name-db" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM documents WHERE bank_id='$BANK_ID';")
[[ "$actual_documents" == "$expected_documents" ]] || { echo "Restored document count $actual_documents does not match state count $expected_documents" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d "{\"query\":$(jq -Rn --arg q "$QUERY" '$q'),\"max_tokens\":200}" \
  "http://127.0.0.1:18888/v1/default/banks/$BANK_ID/memories/recall" >/dev/null
echo "Isolated PostgreSQL and SQLite restore verification passed for $actual_documents documents."
