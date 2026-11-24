#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/importer-runtime.sh
source "$ROOT/scripts/lib/importer-runtime.sh"
[[ $# -eq 1 && $(uname -s) == Linux ]] || { echo "Usage (Linux): deploy-importer.sh REVISION" >&2; exit 1; }
ROLLOUT_TIMEOUT=${PI_HINDSIGHT_ROLLOUT_TIMEOUT_SECONDS-600}
[[ "$ROLLOUT_TIMEOUT" =~ ^[1-9][0-9]{0,8}$ ]] || {
  echo 'PI_HINDSIGHT_ROLLOUT_TIMEOUT_SECONDS must be a positive integer with at most nine digits' >&2; exit 1;
}
select_importer_node /usr/local/bin/node
CONFIG=${PI_HINDSIGHT_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/pi-hindsight-memory/config.json}
CONFIG=$(cd -- "$(dirname -- "$CONFIG")" && printf '%s/%s\n' "$(pwd -P)" "$(basename -- "$CONFIG")")
SNAPSHOTS="${XDG_DATA_HOME:-$HOME/.local/share}/pi-hindsight-memory-cutover"
UNIT=pi-hindsight-importer.service
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
DROP_DIR="$UNIT_DIR/$UNIT.d"
DROP="$DROP_DIR/90-runtime.conf"
svc() { systemctl --user "$@"; }

mkdir -p -- "$SNAPSHOTS"
exec 9> "$SNAPSHOTS/.deploy-lock"
flock -n 9 || { echo 'Another importer rollout is in progress' >&2; exit 1; }
[[ $(svc show -p LoadState --value "$UNIT") == loaded ]] || {
  echo 'Install the importer unit before running a rollout' >&2; exit 1;
}
REVISION=$(git -C "$ROOT" rev-parse --verify --end-of-options "$1^{commit}")
RUNTIME=$(prepare_importer_runtime "$ROOT" "$REVISION" "$SNAPSHOTS" "$CONFIG")
PATH="$(dirname -- "$NODE"):$PATH"
export PATH
CLI="$RUNTIME/dist/src/importer/cli.js"
[[ -x "$RUNTIME/scripts/backup.sh" ]] || { echo 'Target revision has no backup script' >&2; exit 1; }
START=$(importer_exec_start "$RUNTIME" "$CONFIG")

probe() {
  "$NODE" --input-type=module - "$RUNTIME" "$CONFIG" "$@" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
const [runtime, file, mode, pid, since] = process.argv.slice(2);
const { loadConfig } = await import(pathToFileURL(path.join(runtime, 'dist/src/common/config.js')));
const config = loadConfig(file);
function read(database, query) {
  const db = new DatabaseSync(database, { readOnly: true, timeout: 1000 });
  try { return query(db); } finally { db.close(); }
}
if (mode === 'schema') {
  const signature = (database, migrations) => read(database, (db) => [
    db.prepare('PRAGMA schema_version').get(),
    migrations ? db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() : [],
  ]);
  console.log(JSON.stringify([signature(config.stateDatabase, true), signature(config.evidenceDatabase, false)]));
} else {
  if (!/^[1-9][0-9]*$/.test(pid)) process.exit(1);
  const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  if (mode === 'previous') {
    const index = args.indexOf('--config');
    if (index < 0 || !path.isAbsolute(args[index + 1]) || fs.realpathSync(args[index + 1]) !== fs.realpathSync(file)) process.exit(1);
  } else if (args[1] !== path.join(runtime, 'dist/src/importer/cli.js') || args[2] !== 'daemon') process.exit(1);
  const heartbeat = read(config.stateDatabase, (db) => db.prepare('SELECT pid, heartbeat_at, phase FROM daemon_status WHERE id=1').get());
  if (heartbeat?.pid !== Number(pid) || (mode !== 'previous' && !(Date.parse(heartbeat.heartbeat_at) >= Number(since) && heartbeat.phase === 'idle'))) process.exit(1);
}
JS
}

inventory() {
  local dir references current
  current=$(svc show -p ExecStart --value "$UNIT") || current=''
  echo "Runtime snapshot inventory: $SNAPSHOTS"
  for dir in "$SNAPSHOTS"/*; do
    [[ -d "$dir" ]] || continue
    printf '  %s\n' "$dir"
    if [[ "$current" == *"$dir/"* ]]; then printf '    effective ExecStart: %s\n' "$UNIT"; fi
    references=$(grep -rFl -- "$dir" "$UNIT_DIR" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json" "$HOME/.local/libexec" 2>/dev/null) || true
    if [[ -n "$references" ]]; then printf '%s\n' "$references" | awk '{print "    " $0}'; fi
  done
  echo 'No snapshots were removed. Check other hosts and external scripts for references.'
}

WAS_ACTIVE=0
case $(svc show -p ActiveState --value "$UNIT") in
  active)
    WAS_ACTIVE=1
    PID=$(svc show -p MainPID --value "$UNIT")
    probe previous "$PID" || { echo 'Running importer does not match the selected config and state; nothing was stopped' >&2; exit 1; }
    ;;
  inactive|failed) ;;
  *) echo 'Importer unit is not in a stable state; retry after it settles' >&2; exit 1 ;;
esac
NODE_ENV=production PI_HINDSIGHT_CONFIG="$CONFIG" timeout -k 2 60 "$RUNTIME/scripts/backup.sh" --check
mkdir -p -- "$DROP_DIR"
TEMP=$(mktemp -d "$DROP_DIR/.rollout.XXXXXX")
QUIESCING=0
SWITCHED=0
finish() {
  local result=$? current_schema
  trap - EXIT
  trap '' INT TERM
  if [[ "$result" -ne 0 && "$QUIESCING" -eq 1 ]]; then
    if [[ "$SWITCHED" -eq 1 ]]; then
      if ! svc stop "$UNIT"; then
        echo "Cannot stop the new importer; inspect the unit before rollback. Saved drop-in: $TEMP" >&2
        return "$result"
      fi
      if ! restore_runtime; then
        echo "Could not restore the previous runtime configuration. Importer left stopped. Rollout files: $TEMP" >&2
        return "$result"
      fi
      if ! current_schema=$(probe schema) || [[ "$current_schema" != "$SCHEMA" ]]; then
        echo 'Previous runtime configuration restored. Importer left stopped: SQLite schema changed or could not be read. Check runtime compatibility before starting.' >&2
        WAS_ACTIVE=0
      fi
    fi
    if [[ "$WAS_ACTIVE" -eq 1 ]]; then
      if svc start "$UNIT"; then
        echo 'Requested start of the previous importer runtime. No database was restored.' >&2
      else
        echo 'Could not restart the previous importer. No database was restored.' >&2
      fi
    fi
  fi
  rm -rf -- "$TEMP"
  inventory
  return "$result"
}
restore_runtime() {
  if [[ -e "$TEMP/previous" || -L "$TEMP/previous" ]]; then
    mv -fT -- "$TEMP/previous" "$DROP" || return 1
  else
    rm -f -- "$DROP" || return 1
  fi
  svc daemon-reload
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -e "$DROP" || -L "$DROP" ]]; then cp -Pp -- "$DROP" "$TEMP/previous"; fi
printf '[Service]\nExecStart=\n%s\n' "$START" > "$TEMP/next"
QUIESCING=1
svc stop "$UNIT"
NODE_ENV=production PI_HINDSIGHT_CONFIG="$CONFIG" "$RUNTIME/scripts/backup.sh" --coordinated
SCHEMA=$(probe schema)
SWITCHED=1
mv -fT -- "$TEMP/next" "$DROP"
svc daemon-reload
STARTED=$("$NODE" -p 'Date.now()')
DEADLINE=$((SECONDS + ROLLOUT_TIMEOUT))
svc start "$UNIT"
PID=$(svc show -p MainPID --value "$UNIT")
check_main_pid() {
  if ! [[ "$PID" =~ ^[1-9][0-9]*$ ]] || [[ $(svc show -p MainPID --value "$UNIT") != "$PID" ]] || ! kill -0 "$PID" 2>/dev/null; then
    echo 'New importer exited or its main PID changed' >&2
    exit 1
  fi
}
while true; do
  check_main_pid
  if probe heartbeat "$PID" "$STARTED" 2>/dev/null; then break; fi
  (( SECONDS < DEADLINE )) || { echo 'Timed out waiting for a fresh heartbeat from the new importer' >&2; exit 1; }
  sleep 1
done

verify_accounting() {
  local status=0
  NODE_ENV=production timeout -k 2 "${1}s" "$NODE" "$CLI" verify-import --config "$CONFIG" > "$TEMP/verify.json" || status=$?
  # verify-import can exit 1 for readiness conditions unrelated to document accounting.
  (( status <= 1 )) || return 1
  "$NODE" -e '
    let report;
    try { report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
    if (!report) process.exit(1);
    if (report.failedGenerations > 0) {
      console.error("New importer did not pass document verification: " + report.failedGenerations + " failed updates");
      process.exit(2);
    }
    if (report.failedGenerations !== 0 || report.pendingWork !== 0 || report.activeHindsightOperations !== 0) process.exit(1);
    const discrepancies = [report.missingDocumentCount, report.unexpectedDocumentCount, report.excludedDocumentsPresentCount, report.documentHashMismatchCount];
    if (discrepancies.some(count => count > 0)) process.exit(3);
    if (report.documentAccountingReady !== true) process.exit(1);
  ' "$TEMP/verify.json"
}
VERIFY_STATUS=1
QUIET_DISCREPANCY=0
while (( (REMAINING = DEADLINE - SECONDS) > 0 )); do
  check_main_pid
  VERIFY_STATUS=0
  verify_accounting "$REMAINING" || VERIFY_STATUS=$?
  check_main_pid
  case "$VERIFY_STATUS" in
    0) break ;;
    2) exit 1 ;;
    3)
      if (( QUIET_DISCREPANCY )); then
        echo 'New importer did not pass document verification in two consecutive idle checks' >&2
        exit 1
      fi
      QUIET_DISCREPANCY=1
      ;;
    *) QUIET_DISCREPANCY=0 ;;
  esac
  if (( SECONDS < DEADLINE )); then sleep 1; fi
done
if (( VERIFY_STATUS != 0 )); then
  echo 'Timed out waiting for the new importer to pass document accounting' >&2
  exit 1
fi
echo "Deployed importer revision $REVISION"
