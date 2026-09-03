#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
ACTION=${1:?Usage: stack.sh up|stop|down|status|logs}
case "$ACTION" in
  up) compose_project up -d ;;
  stop) compose_project stop ;;
  down) compose_project down ;;
  status) compose_project ps ;;
  logs) shift; compose_project logs "$@" ;;
  *) echo "Unknown action: $ACTION" >&2; exit 1 ;;
esac
