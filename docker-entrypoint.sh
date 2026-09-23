#!/bin/sh
set -eu

export PATCHPAW_HOME="${PATCHPAW_HOME:-/var/lib/patchpaw}"
control_plane_db="$PATCHPAW_HOME/data/control-plane.db"

is_patchpaw_server_start() {
  [ "$#" -eq 4 ] \
    && [ "$1" = "node" ] \
    && [ "$2" = "--import" ] \
    && [ "$3" = "tsx" ] \
    && [ "$4" = "src/index.ts" ]
}

if is_patchpaw_server_start "$@" && [ -f "$control_plane_db" ]; then
  echo "PatchPaw: applying versioned builtin asset migrations"
  if ! node --import tsx /app/scripts/migrate-builtin-assets.ts --apply; then
    echo "PatchPaw: versioned builtin asset migration failed; refusing to start the PatchPaw service." >&2
    exit 1
  fi
fi

exec "$@"
