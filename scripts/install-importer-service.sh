#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
NODE=$(command -v node || true)
[[ -n "$NODE" ]] || { echo "node is required" >&2; exit 1; }
cd "$ROOT"
npm run build
START=0
[[ "${1:-}" == "--start" ]] && START=1
CONFIG_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/pi-hindsight-memory/config.json"
[[ -r "$CONFIG_FILE" ]] || { echo "Missing $CONFIG_FILE" >&2; exit 1; }
DEPENDENCY="${PI_HINDSIGHT_IMPORTER_DEPENDENCY:-pi-hindsight-stack.service}"
[[ -z "$DEPENDENCY" || "$DEPENDENCY" =~ ^[A-Za-z0-9@_.:-]+\.service$ ]] || { echo "Invalid PI_HINDSIGHT_IMPORTER_DEPENDENCY" >&2; exit 1; }

if [[ "$(uname -s)" == Darwin ]]; then
  LABEL=dev.pi-hindsight-memory.importer
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  STAGED_PLIST="${XDG_CONFIG_HOME:-$HOME/.config}/pi-hindsight-memory/$LABEL.plist"
  TARGET_PLIST="$STAGED_PLIST"
  [[ "$START" -eq 1 ]] && TARGET_PLIST="$PLIST"
  LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pi-hindsight-memory"
  mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$STAGED_PLIST")" "$LOG_DIR"
  chmod 700 "$LOG_DIR"
  cat > "$TARGET_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/dist/src/importer/cli.js</string><string>daemon</string><string>--config</string><string>$CONFIG_FILE</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/importer.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/importer-error.log</string>
  <key>Umask</key><integer>63</integer>
</dict></plist>
EOF
  plutil -lint "$TARGET_PLIST" >/dev/null
  if [[ "$START" -eq 1 ]]; then
    launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi
  echo "Installed $TARGET_PLIST"
  [[ "$START" -eq 1 ]] || echo "Staged only; it will not start at login. After Pi activation, run: scripts/install-importer-service.sh --start"
else
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT="$UNIT_DIR/pi-hindsight-importer.service"
  mkdir -p "$UNIT_DIR"
  dependency_wants=""
  dependency_after=""
  if [[ -n "$DEPENDENCY" ]]; then
    dependency_wants=" $DEPENDENCY"
    dependency_after=" $DEPENDENCY"
  fi
  cat > "$UNIT" <<EOF
[Unit]
Description=Global coding-agent session importer for Hindsight
Wants=network-online.target$dependency_wants
After=network-online.target$dependency_after

[Service]
Type=simple
ExecStart=$NODE $ROOT/dist/src/importer/cli.js daemon --config $CONFIG_FILE
Restart=on-failure
RestartSec=10
Nice=10
IOSchedulingClass=idle
UMask=0077
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  [[ "$START" -eq 1 ]] && systemctl --user enable --now pi-hindsight-importer.service
  echo "Installed $UNIT"
  [[ "$START" -eq 1 ]] || echo "Not started. After Pi activation, run: scripts/install-importer-service.sh --start"
fi
