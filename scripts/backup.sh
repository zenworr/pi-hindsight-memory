#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
STATE_DIR=$(state_dir)
BACKUP_DIR=$(backup_dir)
REMOTE_HOST="${PI_HINDSIGHT_SSH_HOST:-}"
ENGINE=""
[[ -n "$REMOTE_HOST" ]] || ENGINE=$(container_engine)
REMOTE_ENGINE="${PI_HINDSIGHT_REMOTE_ENGINE:-docker}"
POSTGRES_USER="${PI_HINDSIGHT_DB_USER:-hindsight_user}"
POSTGRES_DB="${PI_HINDSIGHT_DB_NAME:-hindsight}"
if [[ -n "$REMOTE_HOST" && ( ! "$REMOTE_HOST" =~ ^[A-Za-z0-9_.:@-]+$ || "$REMOTE_HOST" == -* ) ]]; then echo "Invalid PI_HINDSIGHT_SSH_HOST" >&2; exit 1; fi
[[ "$REMOTE_ENGINE" == docker || "$REMOTE_ENGINE" == podman ]] || { echo "PI_HINDSIGHT_REMOTE_ENGINE must be docker or podman" >&2; exit 1; }
[[ "$POSTGRES_USER" =~ ^[A-Za-z0-9_]+$ && "$POSTGRES_DB" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Invalid PostgreSQL user or database name" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
command -v sqlite3 >/dev/null || { echo "sqlite3 is required for a consistent state backup" >&2; exit 1; }
[[ -s "$STATE_DIR/state.sqlite3" ]] || { echo "Importer state database does not exist yet" >&2; exit 1; }
if [[ -n "$REMOTE_HOST" ]]; then
  command -v ssh >/dev/null || { echo "ssh is required for a remote Hindsight backup" >&2; exit 1; }
  ssh -o BatchMode=yes "$REMOTE_HOST" "$REMOTE_ENGINE ps --format '{{.Names}}'" | grep -qx hindsight-db || { echo "Remote hindsight-db is not running" >&2; exit 1; }
else
  "$ENGINE" ps --format '{{.Names}}' | grep -qx hindsight-db || { echo "hindsight-db is not running" >&2; exit 1; }
fi
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump_file="$BACKUP_DIR/hindsight-$stamp.dump"
state_file="$BACKUP_DIR/state-$stamp.sqlite3"
manifest_file="$BACKUP_DIR/SHA256SUMS-$stamp"
cleanup_partial() { rm -f "$pg_dump_file" "$state_file" "$manifest_file"; }
trap cleanup_partial ERR
trap 'cleanup_partial; exit 130' INT
trap 'cleanup_partial; exit 143' TERM
if [[ -n "$REMOTE_HOST" ]]; then
  ssh -o BatchMode=yes "$REMOTE_HOST" "$REMOTE_ENGINE exec hindsight-db pg_dump -U $POSTGRES_USER -d $POSTGRES_DB -Fc" > "$pg_dump_file"
else
  "$ENGINE" exec hindsight-db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$pg_dump_file"
fi
sqlite3 "$STATE_DIR/state.sqlite3" ".backup '$state_file'"
(
  cd "$BACKUP_DIR"
  file_sha256 "$(basename "$pg_dump_file")" "$(basename "$state_file")" > "$(basename "$manifest_file")"
  verify_sha256_manifest "$(basename "$manifest_file")" >/dev/null
)
trap - ERR INT TERM

for pattern in 'hindsight-*.dump' 'state-*.sqlite3' 'SHA256SUMS-*'; do
  count=0
  while IFS= read -r file; do
    count=$((count + 1))
    [[ "$count" -le 4 ]] || rm -f "$file"
  done <<EOF
$(ls -1t "$BACKUP_DIR"/$pattern 2>/dev/null || true)
EOF
done

echo "Created $pg_dump_file and $state_file"
