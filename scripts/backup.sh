#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
REMOTE_HOST="${PI_HINDSIGHT_SSH_HOST:-}"
REMOTE_ENGINE="${PI_HINDSIGHT_REMOTE_ENGINE:-docker}"
POSTGRES_USER="${PI_HINDSIGHT_DB_USER:-hindsight_user}"
POSTGRES_DB="${PI_HINDSIGHT_DB_NAME:-hindsight}"
usage() { echo "Usage: backup.sh [--check|--coordinated|--uncoordinated]" >&2; exit 1; }
[[ $# -le 1 ]] || usage
case "${1:-}" in
  --check) mode=check ;;
  --coordinated) mode=coordinated ;;
  --uncoordinated) mode=uncoordinated ;;
  '') if [[ -n "$REMOTE_HOST" ]]; then mode=uncoordinated; else mode=coordinated; fi ;;
  *) usage ;;
esac
if [[ -n "$REMOTE_HOST" && ( ! "$REMOTE_HOST" =~ ^[A-Za-z0-9_.:@-]+$ || "$REMOTE_HOST" == -* ) ]]; then echo "Invalid PI_HINDSIGHT_SSH_HOST" >&2; exit 1; fi
[[ "$REMOTE_ENGINE" == docker || "$REMOTE_ENGINE" == podman ]] || { echo "PI_HINDSIGHT_REMOTE_ENGINE must be docker or podman" >&2; exit 1; }
[[ "$POSTGRES_USER" =~ ^[A-Za-z0-9_]+$ && "$POSTGRES_DB" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Invalid PostgreSQL user or database name" >&2; exit 1; }
if [[ -n "$REMOTE_HOST" ]]; then ENGINE=$REMOTE_ENGINE; else ENGINE=$(container_engine); fi
umask 077
if [[ "$mode" == check ]]; then
  exec node "$ROOT/scripts/lib/backup.mjs" check "$ENGINE" "$REMOTE_HOST" "$POSTGRES_USER" "$POSTGRES_DB"
fi
if [[ -f "$ROOT/.snapshot-revision" ]]; then
  revision=$(<"$ROOT/.snapshot-revision")
  [[ "$revision" =~ ^[a-f0-9]{40}$ || "$revision" =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid snapshot revision' >&2; exit 1; }
else
  revision=$(git -C "$ROOT" rev-parse --verify HEAD)
fi
exec node "$ROOT/scripts/lib/backup.mjs" capture "$mode" "$(backup_dir)" "$revision" "$ENGINE" "$REMOTE_HOST" "$POSTGRES_USER" "$POSTGRES_DB"
