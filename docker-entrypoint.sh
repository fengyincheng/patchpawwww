#!/bin/sh
set -eu

export PATCHPAW_HOME="${PATCHPAW_HOME:-/var/lib/patchpaw}"
control_plane_db="$PATCHPAW_HOME/data/control-plane.db"

if [ -f "$control_plane_db" ]; then
  echo "PatchPaw: applying versioned builtin asset migrations"
  if ! node --import tsx /app/scripts/migrate-builtin-assets.ts --apply; then
    echo "PatchPaw: versioned builtin asset migration failed; refusing to start the requested command." >&2
    exit 1
  fi
fi

exec "$@"
