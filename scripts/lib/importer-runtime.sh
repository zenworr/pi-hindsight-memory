#!/usr/bin/env bash

select_importer_node() {
  NODE=${PI_HINDSIGHT_NODE:-$1}
  [[ -x "$NODE" ]] || { echo "Node executable not found: $NODE" >&2; return 1; }
  NODE=$("$NODE" -p 'require("node:fs").realpathSync(process.execPath)')
  "$NODE" -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<19))throw new Error("Node.js 22.19 or newer is required")'
}

prepare_importer_runtime() (
  set -euo pipefail
  umask 077
  local root=$1 revision=$2 snapshots=$3 config=$4 stage='' npm
  local runtime="$snapshots/$revision"
  mkdir -p -- "$snapshots"
  if [[ ! -e "$runtime" && ! -L "$runtime" ]]; then
    npm=$(command -v npm)
    stage=$(mktemp -d "$snapshots/.build-$revision.XXXXXX")
    trap 'if [[ -n "$stage" ]]; then chmod -R u+w -- "$stage"; rm -rf -- "$stage"; fi' EXIT
    git -C "$root" archive "$revision" | tar -x -C "$stage"
    # The package's prepare script builds dist. Keep build tools even when NODE_ENV is production.
    (cd -- "$stage"; PATH="$(dirname -- "$NODE"):$PATH" "$npm" ci --include=dev) >&2
    "$NODE" "$stage/dist/src/importer/cli.js" config --check --config "$config" >&2
    printf '%s\n' "$revision" > "$stage/.snapshot-revision"
    chmod -R a-w -- "$stage"
    # Do not replace an existing runtime, including one published by another builder.
    "$NODE" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$stage" "$runtime"
    stage=''
  else
    [[ -f "$runtime/.snapshot-revision" && ! -L "$runtime" && $(<"$runtime/.snapshot-revision") == "$revision" ]] || {
      echo "Refusing to overwrite an unmanaged snapshot: $runtime" >&2
      return 1
    }
    "$NODE" "$runtime/dist/src/importer/cli.js" config --check --config "$config" >&2
  fi
  printf '%s\n' "$runtime"
)

systemd_arg() {
  local value=$1
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  value=${value//\$/\$\$}
  printf '"%s"' "$value"
}

importer_exec_start() {
  local node cli config
  node=$(systemd_arg "$NODE") && cli=$(systemd_arg "$1/dist/src/importer/cli.js") && config=$(systemd_arg "$2") || return 1
  printf 'ExecStart=%s %s daemon --config %s\n' "$node" "$cli" "$config"
}
