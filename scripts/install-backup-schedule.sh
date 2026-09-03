#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ "$(uname -s)" == Darwin ]]; then
  # shellcheck source=scripts/lib/runtime.sh
  source "$ROOT/scripts/lib/runtime.sh"
  LABEL=dev.pi-hindsight-memory.backup
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
  STATE_HOME=${XDG_STATE_HOME:-$HOME/.local/state}
  LOG_DIR="$STATE_HOME/pi-hindsight-memory"
  BACKUP_DIR=$(backup_dir)
  ENGINE=$(container_engine)
  command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }
  ENGINE_DIR=$(dirname "$(command -v "$ENGINE")")
  SQLITE_DIR=$(dirname "$(command -v sqlite3)")
  PATH_VALUE="$ENGINE_DIR:$SQLITE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
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
  cat > "$UNIT_DIR/pi-hindsight-backup.service" <<EOF
[Unit]
Description=Back up Hindsight and importer state
After=pi-hindsight-stack.service

[Service]
Type=oneshot
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
