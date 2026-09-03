#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ "$(uname -s)" == Darwin ]]; then
  cat <<'EOF'
Docker Desktop manages container startup on macOS.
Enable “Start Docker Desktop when you sign in”. The Compose services use restart: unless-stopped.
EOF
  exit 0
fi
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/pi-hindsight-stack.service"
mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=Pi Hindsight memory stack
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$ROOT
ExecStart=$ROOT/scripts/stack.sh up
ExecStop=$ROOT/scripts/stack.sh stop
TimeoutStartSec=900
TimeoutStopSec=120

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now pi-hindsight-stack.service
echo "Installed and started $UNIT"
