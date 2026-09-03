#!/usr/bin/env bash

project_root() {
  cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd
}

config_dir() {
  printf '%s/pi-hindsight-memory\n' "${XDG_CONFIG_HOME:-$HOME/.config}"
}

state_dir() {
  printf '%s/pi-hindsight-memory\n' "${XDG_STATE_HOME:-$HOME/.local/state}"
}

backup_dir() {
  printf '%s\n' "${PI_HINDSIGHT_BACKUP_DIR:-$(state_dir)/backups}"
}

container_engine() {
  if [[ -n "${PI_HINDSIGHT_CONTAINER_ENGINE:-}" ]]; then
    command -v "$PI_HINDSIGHT_CONTAINER_ENGINE" >/dev/null || {
      echo "Container engine not found: $PI_HINDSIGHT_CONTAINER_ENGINE" >&2
      return 1
    }
    printf '%s\n' "$PI_HINDSIGHT_CONTAINER_ENGINE"
  elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    printf '%s\n' docker
  elif command -v podman >/dev/null && podman info >/dev/null 2>&1; then
    printf '%s\n' podman
  else
    echo "A running Docker or Podman engine is required" >&2
    return 1
  fi
}

compose() {
  local engine
  engine=$(container_engine)
  if [[ "$engine" == docker ]]; then
    docker compose "$@"
  elif podman compose version >/dev/null 2>&1; then
    podman compose "$@"
  elif command -v podman-compose >/dev/null; then
    podman-compose "$@"
  else
    echo "Podman Compose is required" >&2
    return 1
  fi
}

compose_project() {
  local root local_override
  root=$(project_root)
  local_override="$root/deploy/compose/compose.local.yaml"
  if [[ -f "$local_override" ]]; then
    compose --env-file "$root/deploy/compose/.env" -f "$root/deploy/compose/compose.yaml" -f "$local_override" "$@"
  else
    compose --env-file "$root/deploy/compose/.env" -f "$root/deploy/compose/compose.yaml" "$@"
  fi
}

file_sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

verify_sha256_manifest() {
  if command -v sha256sum >/dev/null; then
    sha256sum -c "$1"
  else
    shasum -a 256 -c "$1"
  fi
}

image_architecture() {
  "$1" image inspect "$2" --format '{{.Architecture}}'
}

image_digest() {
  local engine=$1 image=$2 ref
  ref=$($engine image inspect "$image" --format '{{index .RepoDigests 0}}')
  [[ "$ref" == *@sha256:* ]] || return 1
  printf '%s\n' "${ref##*@}"
}
