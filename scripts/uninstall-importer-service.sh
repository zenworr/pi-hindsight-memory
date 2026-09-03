#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" == Darwin ]]; then
  LABEL=dev.pi-hindsight-memory.importer
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  echo "Removed $PLIST"
else
  systemctl --user disable --now pi-hindsight-importer.service >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/pi-hindsight-importer.service"
  systemctl --user daemon-reload
  echo "Removed pi-hindsight-importer.service"
fi
