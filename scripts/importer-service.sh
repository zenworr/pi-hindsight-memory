#!/usr/bin/env bash
set -euo pipefail
ACTION=${1:?Usage: importer-service.sh start|stop|status}
LABEL=dev.pi-hindsight-memory.importer
if [[ "$(uname -s)" == Darwin ]]; then
  domain="gui/$(id -u)/$LABEL"
  plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  case "$ACTION" in
    start)
      if launchctl print "$domain" >/dev/null 2>&1; then launchctl kickstart -k "$domain"
      else launchctl bootstrap "gui/$(id -u)" "$plist"
      fi
      ;;
    stop) launchctl bootout "$domain" ;;
    status) launchctl print "$domain" ;;
    *) echo "Unknown action: $ACTION" >&2; exit 1 ;;
  esac
else
  case "$ACTION" in
    start|stop|status) systemctl --user "$ACTION" pi-hindsight-importer.service ;;
    *) echo "Unknown action: $ACTION" >&2; exit 1 ;;
  esac
fi
