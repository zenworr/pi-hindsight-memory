#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=scripts/lib/runtime.sh
source "$ROOT/scripts/lib/runtime.sh"
DEPLOY="$ROOT/deploy/compose"
CONFIG_DIR=$(config_dir)
STATE_DIR=$(state_dir)
BACKUP_DIR=$(backup_dir)
ENGINE=$(container_engine)
HINDSIGHT_TAG=${HINDSIGHT_TAG:-ghcr.io/vectorize-io/hindsight:0.9.2}
POSTGRES_TAG=${POSTGRES_TAG:-docker.io/pgvector/pgvector:pg18}
existing_value() { awk -F= -v key="$1" '$1==key {print $2; exit}' "$DEPLOY/.env" 2>/dev/null || true; }
existing_project=$(existing_value COMPOSE_PROJECT_NAME)
existing_api_port=$(existing_value HINDSIGHT_API_HOST_PORT)
existing_ui_port=$(existing_value HINDSIGHT_UI_HOST_PORT)
CONFIG_FILE="$CONFIG_DIR/config.json"
configured_api_port=
configured_ui_port=
if [[ -r "$CONFIG_FILE" ]] && command -v jq >/dev/null; then
  configured_api_url=$(jq -r '.hindsight.apiUrl // empty' "$CONFIG_FILE")
  configured_ui_url=$(jq -r '.hindsight.uiUrl // empty' "$CONFIG_FILE")
  configured_api_port=${configured_api_url##*:}; configured_api_port=${configured_api_port%%/*}
  configured_ui_port=${configured_ui_url##*:}; configured_ui_port=${configured_ui_port%%/*}
fi
COMPOSE_PROJECT_NAME=${PI_HINDSIGHT_COMPOSE_PROJECT:-${existing_project:-pi-hindsight-memory}}
API_HOST_PORT=${PI_HINDSIGHT_API_PORT:-${configured_api_port:-${existing_api_port:-8888}}}
UI_HOST_PORT=${PI_HINDSIGHT_UI_PORT:-${configured_ui_port:-${existing_ui_port:-9999}}}
WORKER_ID=${PI_HINDSIGHT_WORKER_ID:-pi-hindsight-worker}
CONCURRENCY=${PI_HINDSIGHT_CONCURRENCY:-4}

for command in openssl jq; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ "$CONCURRENCY" =~ ^[1-9][0-9]*$ ]] || { echo "PI_HINDSIGHT_CONCURRENCY must be a positive integer" >&2; exit 1; }

mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$BACKUP_DIR"
chmod 700 "$CONFIG_DIR" "$STATE_DIR" "$BACKUP_DIR"

echo "Pulling Hindsight and PostgreSQL for $ENGINE/$(uname -m)..."
"$ENGINE" pull "$HINDSIGHT_TAG"
"$ENGINE" pull "$POSTGRES_TAG"
case "$(uname -m)" in arm64|aarch64) expected_arch=arm64 ;; x86_64|amd64) expected_arch=amd64 ;; *) expected_arch=unknown ;; esac
for image in "$HINDSIGHT_TAG" "$POSTGRES_TAG"; do
  actual_arch=$(image_architecture "$ENGINE" "$image")
  if [[ "$expected_arch" != unknown && "$actual_arch" != "$expected_arch" && "${PI_HINDSIGHT_ALLOW_EMULATION:-0}" != 1 ]]; then
    echo "Image $image is $actual_arch but this host is $expected_arch; refusing emulation" >&2
    exit 1
  fi
done
HINDSIGHT_DIGEST=$(image_digest "$ENGINE" "$HINDSIGHT_TAG")
POSTGRES_DIGEST=$(image_digest "$ENGINE" "$POSTGRES_TAG")
[[ "$HINDSIGHT_DIGEST" == sha256:* && "$POSTGRES_DIGEST" == sha256:* ]] || {
  echo "Could not resolve immutable image digests" >&2
  exit 1
}

signature_status=not-checked
if [[ "${VERIFY_HINDSIGHT_SIGNATURE:-0}" == 1 ]]; then
  command -v cosign >/dev/null || { echo "cosign is required for signature verification" >&2; exit 1; }
  cosign verify "$HINDSIGHT_TAG" \
    --certificate-identity-regexp '^https://github\.com/vectorize-io/hindsight/\.github/workflows/(sign-images|release)\.yml@.*' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com >/dev/null
  signature_status=verified
fi

if [[ ! -s "$CONFIG_DIR/api-token" ]]; then
  umask 077
  openssl rand -hex 32 > "$CONFIG_DIR/api-token"
fi
created_environment=0
if [[ ! -s "$CONFIG_DIR/hindsight.env" ]]; then
  created_environment=1
  umask 077
  DB_PASSWORD=$(openssl rand -hex 32)
  API_TOKEN=$(<"$CONFIG_DIR/api-token")
  cat > "$CONFIG_DIR/hindsight.env" <<EOF
POSTGRES_USER=hindsight_user
POSTGRES_PASSWORD=$DB_PASSWORD
POSTGRES_DB=hindsight
HINDSIGHT_API_DATABASE_URL=postgresql://hindsight_user:$DB_PASSWORD@hindsight-db:5432/hindsight
HINDSIGHT_API_HOST=0.0.0.0
HINDSIGHT_API_PORT=8888
HINDSIGHT_API_TENANT_EXTENSION=hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension
HINDSIGHT_API_TENANT_API_KEY=$API_TOKEN
HINDSIGHT_CP_DATAPLANE_API_URL=http://hindsight-app:8888
HINDSIGHT_CP_DATAPLANE_API_KEY=$API_TOKEN
HINDSIGHT_API_WORKER_ID=$WORKER_ID
HINDSIGHT_API_MCP_ENABLED=false
HINDSIGHT_API_LLM_PROVIDER=none
HINDSIGHT_API_EMBEDDINGS_PROVIDER=local
HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL=BAAI/bge-small-en-v1.5
HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU=true
HINDSIGHT_API_RERANKER_PROVIDER=local
HINDSIGHT_API_RERANKER_LOCAL_MODEL=cross-encoder/ms-marco-MiniLM-L-6-v2
HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU=true
HINDSIGHT_API_RERANKER_LOCAL_MAX_CONCURRENT=1
HINDSIGHT_API_RERANKER_MAX_CANDIDATES=100
HINDSIGHT_API_RECALL_MAX_CONCURRENT=2
HINDSIGHT_API_RECALL_MAX_CANDIDATES_PER_SOURCE=100
HINDSIGHT_API_DB_POOL_MIN_SIZE=2
HINDSIGHT_API_DB_POOL_MAX_SIZE=$CONCURRENCY
HINDSIGHT_API_STORE_DOCUMENT_TEXT=true
HINDSIGHT_API_FAIL_ON_EXTRACTION_ERRORS=true
HINDSIGHT_API_RETAIN_WALL_TIMEOUT=86400
HINDSIGHT_API_RETAIN_MEMORY_BUDGET_MB=128
HINDSIGHT_API_RETAIN_CHUNK_BATCH_SIZE=10
HINDSIGHT_API_RETAIN_SUBBATCH_CONCURRENCY=1
HINDSIGHT_API_RETAIN_MAX_CONCURRENT=$CONCURRENCY
HINDSIGHT_API_RETAIN_LLM_MAX_CONCURRENT=$CONCURRENCY
HINDSIGHT_API_CONSOLIDATION_LLM_MAX_CONCURRENT=1
HINDSIGHT_API_LLM_MAX_CONCURRENT=$CONCURRENCY
HINDSIGHT_API_WORKER_MAX_SLOTS=$CONCURRENCY
HINDSIGHT_API_WORKER_CONSOLIDATION_RESERVED_SLOTS=0
HINDSIGHT_API_DB_MAX_PARALLEL_WORKERS_PER_GATHER=0
HINDSIGHT_API_ANN_MAX_SCAN_TUPLES=4000
HINDSIGHT_API_OPERATION_RETENTION_DAYS=14
HINDSIGHT_API_OPERATION_CLEANUP_BATCH_SIZE=1000
HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false
HINDSIGHT_API_ENABLE_OBSERVATIONS=true
HINDSIGHT_API_RETAIN_BATCH_ENABLED=false
EOF
  chmod 600 "$CONFIG_DIR/hindsight.env"
else
  echo "Keeping existing $CONFIG_DIR/hindsight.env"
fi

cat > "$DEPLOY/versions.env" <<EOF
# Generated locally by scripts/prepare-deployment.sh.
HINDSIGHT_VERSION=0.9.2
HINDSIGHT_IMAGE=$HINDSIGHT_TAG@$HINDSIGHT_DIGEST
POSTGRES_IMAGE=$POSTGRES_TAG@$POSTGRES_DIGEST
HINDSIGHT_SIGNATURE_STATUS=$signature_status
EOF
cat > "$DEPLOY/.env" <<EOF
COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME
HINDSIGHT_ENV_FILE="$CONFIG_DIR/hindsight.env"
HINDSIGHT_IMAGE=$HINDSIGHT_TAG@$HINDSIGHT_DIGEST
POSTGRES_IMAGE=$POSTGRES_TAG@$POSTGRES_DIGEST
HINDSIGHT_API_HOST_PORT=$API_HOST_PORT
HINDSIGHT_UI_HOST_PORT=$UI_HOST_PORT
EOF
chmod 600 "$DEPLOY/.env" "$DEPLOY/versions.env"
printf 'Prepared %s deployment for %s.\n' "$ENGINE" "$(uname -m)"
printf 'Hindsight: %s\nPostgreSQL: %s\n' "$HINDSIGHT_DIGEST" "$POSTGRES_DIGEST"
if [[ "$created_environment" -eq 1 ]]; then
  echo "The generated environment starts in no-LLM mode. Configure a provider only after the smoke test passes."
else
  echo "The existing Hindsight environment and provider settings were preserved."
fi
