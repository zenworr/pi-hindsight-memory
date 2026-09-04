#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
REMOTE_HOST="${PI_HINDSIGHT_SSH_HOST:-}"
REMOTE_ENGINE="${PI_HINDSIGHT_REMOTE_ENGINE:-docker}"
if [[ -n "$REMOTE_HOST" && ( ! "$REMOTE_HOST" =~ ^[A-Za-z0-9_.:@-]+$ || "$REMOTE_HOST" == -* ) ]]; then echo "Invalid PI_HINDSIGHT_SSH_HOST" >&2; exit 1; fi
[[ "$REMOTE_ENGINE" == docker || "$REMOTE_ENGINE" == podman ]] || { echo "PI_HINDSIGHT_REMOTE_ENGINE must be docker or podman" >&2; exit 1; }
if [[ "$(uname -s)" == Darwin ]]; then
  # shellcheck source=scripts/lib/runtime.sh
  source "$ROOT/scripts/lib/runtime.sh"
  LABEL=dev.pi-hindsight-memory.backup
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
  STATE_HOME=${XDG_STATE_HOME:-$HOME/.local/state}
  LOG_DIR="$STATE_HOME/pi-hindsight-memory"
  BACKUP_DIR=$(backup_dir)
  ENGINE=""
  if [[ -z "$REMOTE_HOST" ]]; then ENGINE=$(container_engine); fi
  command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }
  command -v ssh >/dev/null || { echo "ssh is required" >&2; exit 1; }
  TOOL_DIR=$(dirname "$(command -v "${ENGINE:-ssh}")")
  SQLITE_DIR=$(dirname "$(command -v sqlite3)")
  PATH_VALUE="$TOOL_DIR:$SQLITE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$BACKUP_DIR"
  chmod 700 "$LOG_DIR"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$ROOT/scripts/backup.sh</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH_VALUE</string>
    <key>XDG_CONFIG_HOME</key><string>$CONFIG_HOME</string>
    <key>XDG_STATE_HOME</key><string>$STATE_HOME</string>
    <key>PI_HINDSIGHT_BACKUP_DIR</key><string>$BACKUP_DIR</string>
    <key>PI_HINDSIGHT_CONTAINER_ENGINE</key><string>$ENGINE</string>
    <key>PI_HINDSIGHT_SSH_HOST</key><string>$REMOTE_HOST</string>
    <key>PI_HINDSIGHT_REMOTE_ENGINE</key><string>$REMOTE_ENGINE</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$LOG_DIR/backup.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/backup-error.log</string>
  <key>Umask</key><integer>63</integer>
</dict></plist>
EOF
  plutil -lint "$PLIST" >/dev/null
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Installed weekly backup schedule: $PLIST"
else
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  backup_after="pi-hindsight-stack.service"
  backup_environment=""
  if [[ -n "$REMOTE_HOST" ]]; then
    backup_after="network-online.target"
    backup_environment="Environment=PI_HINDSIGHT_SSH_HOST=$REMOTE_HOST
Environment=PI_HINDSIGHT_REMOTE_ENGINE=$REMOTE_ENGINE"
  fi
  cat > "$UNIT_DIR/pi-hindsight-backup.service" <<EOF
[Unit]
Description=Back up Hindsight and importer state
Wants=network-online.target
After=$backup_after

[Service]
Type=oneshot
$backup_environment
ExecStart=$ROOT/scripts/backup.sh
UMask=0077
EOF
  cat > "$UNIT_DIR/pi-hindsight-backup.timer" <<'EOF'
[Unit]
Description=Weekly Hindsight backup

[Timer]
OnCalendar=Sun *-*-* 03:00:00
Persistent=true
RandomizedDelaySec=30m

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now pi-hindsight-backup.timer
  echo "Installed weekly pi-hindsight-backup.timer"
fi
