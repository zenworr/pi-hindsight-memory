#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
STATE_DIR=$(state_dir)
BACKUP_DIR=$(backup_dir)
ENGINE=$(container_engine)
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
command -v sqlite3 >/dev/null || { echo "sqlite3 is required for a consistent state backup" >&2; exit 1; }
[[ -s "$STATE_DIR/state.sqlite3" ]] || { echo "Importer state database does not exist yet" >&2; exit 1; }
"$ENGINE" ps --format '{{.Names}}' | grep -qx hindsight-db || { echo "hindsight-db is not running" >&2; exit 1; }
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump_file="$BACKUP_DIR/hindsight-$stamp.dump"
state_file="$BACKUP_DIR/state-$stamp.sqlite3"
"$ENGINE" exec hindsight-db pg_dump -U hindsight_user -d hindsight -Fc > "$pg_dump_file"
sqlite3 "$STATE_DIR/state.sqlite3" ".backup '$state_file'"
(
  cd "$BACKUP_DIR"
  file_sha256 "$(basename "$pg_dump_file")" "$(basename "$state_file")" > "SHA256SUMS-$stamp"
  verify_sha256_manifest "SHA256SUMS-$stamp" >/dev/null
)

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
