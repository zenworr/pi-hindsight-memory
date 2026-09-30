#!/usr/bin/env bash
set +x
set -euo pipefail
unset TF_LOG TF_LOG_PATH TF_LOG_PROVIDER TF_LOG_CORE
umask 077
module=$(cd "$(dirname "$0")/../deploy/telemetry/terraform" && pwd)
state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/pi-hindsight-memory/signoz
export TF_DATA_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/pi-hindsight-memory/signoz-terraform"
export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$state_dir" "$TF_DATA_DIR"
chmod 700 "$state_dir" "$TF_DATA_DIR"
command -v terraform >/dev/null || { echo 'Terraform 1.7 or later is required.' >&2; exit 1; }
case "${1-}" in
  validate)
    terraform -chdir="$module" fmt -check
    terraform -chdir="$module" init -backend=false -input=false -lockfile=readonly
    terraform -chdir="$module" validate
    exec terraform -chdir="$module" test
    ;;
  plan|apply|import|output) ;;
  *) echo 'Usage: telemetry-dashboard.sh validate|plan|apply|import|output [Terraform arguments]' >&2; exit 1 ;;
esac
if [[ -z ${SIGNOZ_ACCESS_TOKEN:-} ]]; then
  header_file="$HOME/.config/signoz/api-header"
  [[ -f $header_file ]] || { echo 'Configure protected SigNoz management access first.' >&2; exit 1; }
  IFS= read -r header < "$header_file"
  case "$header" in
    'SIGNOZ-API-KEY: '?*) export SIGNOZ_ACCESS_TOKEN="${header#SIGNOZ-API-KEY: }" ;;
    *) echo 'Invalid SigNoz header file format.' >&2; exit 1 ;;
  esac
  unset header
fi
terraform -chdir="$module" init -input=false -lockfile=readonly -backend-config="path=$state_dir/terraform.tfstate"
terraform -chdir="$module" "$@"
if [[ ${1-} == apply || ${1-} == import ]]; then
  cp "$state_dir/terraform.tfstate" "$state_dir/terraform.tfstate.verified-backup"
  chmod 600 "$state_dir/terraform.tfstate" "$state_dir/terraform.tfstate.verified-backup"
fi
