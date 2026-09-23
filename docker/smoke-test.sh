#!/usr/bin/env bash
set -euo pipefail

image="${1:-patchpaw:smoke}"
suffix="$(date +%s)-$$"
volume="patchpaw-smoke-${suffix}"
container="patchpaw-smoke-${suffix}"
recreated_container="${container}-recreated"
derived_image="patchpaw-smoke-python:${suffix}"
temp_dir="$(mktemp -d)"
success=0

cleanup() {
  for name in "$container" "$recreated_container"; do
    if docker container inspect "$name" >/dev/null 2>&1; then
      if [[ "$success" != 1 ]]; then
        docker logs "$name" >&2 || true
      fi
      docker rm -f "$name" >/dev/null 2>&1 || true
    fi
  done
  docker image rm "$derived_image" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
}
trap cleanup EXIT

docker volume create "$volume" >/dev/null

# Exercise the real image entrypoint on an empty named volume. It must skip migration,
# run as UID 10001, and create durable files without a container /app/.env.
docker run --rm --volume "$volume:/var/lib/patchpaw" "$image" /bin/sh -ec '
  test "$(id -u)" = 10001
  test ! -e /app/.env
  mkdir -p "$PATCHPAW_HOME/data" "$PATCHPAW_HOME/locks" "$PATCHPAW_HOME/repos"
  printf persistent-state > "$PATCHPAW_HOME/docker-smoke-marker"
  test -w "$PATCHPAW_HOME/data"
  git --version
  node --version
  npm --version
'

# Model an existing runtime so startup must apply builtin migrations before the server.
docker run --rm --volume "$volume:/var/lib/patchpaw" --entrypoint /bin/sh "$image" -ec \
  'touch /var/lib/patchpaw/data/control-plane.db'

# Exercise the operator CLIs with only process environment and no /app/.env.
docker run --rm --volume "$volume:/var/lib/patchpaw" "$image" \
  npm run bootstrap:control-plane -- docker-smoke/fixture > "$temp_dir/bootstrap.json"
grep -Fq '"control_plane": "initialized"' "$temp_dir/bootstrap.json"
docker run --rm --volume "$volume:/var/lib/patchpaw" --entrypoint npm "$image" \
  run migrate:builtin-assets > "$temp_dir/migration.json"
grep -Fq '"mode": "dry-run"' "$temp_dir/migration.json"
docker run --rm --volume "$volume:/var/lib/patchpaw" --entrypoint npm "$image" \
  run sync:operation -- --check > "$temp_dir/sync-check.json"
docker run --rm --volume "$volume:/var/lib/patchpaw" "$image" \
  npm run backup-runtime > "$temp_dir/backup.json"

start_service() {
  local name="$1"
  docker run --detach --name "$name" \
    --volume "$volume:/var/lib/patchpaw" \
    --publish 127.0.0.1::3000 \
    --env PATCHPAW_HOME=/var/lib/patchpaw \
    --env PATCHPAW_PUBLIC_ORIGIN=http://127.0.0.1:3000 \
    --env PATCHPAW_PORT=3000 \
    --env PATCHPAW_LISTEN_HOST=0.0.0.0 \
    "$image" >/dev/null
}

wait_healthy() {
  local name="$1"
  local status=''
  for _ in $(seq 1 60); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null || true)"
    if [[ "$status" == healthy ]]; then
      return 0
    fi
    if [[ "$status" == unhealthy ]]; then
      docker logs "$name" >&2
      return 1
    fi
    sleep 2
  done
  docker logs "$name" >&2
  echo "Container $name did not become healthy (last state: ${status:-unknown})." >&2
  return 1
}

verify_service() {
  local name="$1"
  local host_port version
  wait_healthy "$name"
  host_port="$(docker port "$name" 3000/tcp | awk -F: 'END { print $NF }')"
  version="$(docker exec "$name" node -p "require('/app/package.json').version")"
  curl --fail --silent --show-error "http://127.0.0.1:${host_port}/health" > "$temp_dir/health.json"
  grep -Fq '"service":"patchpaw"' "$temp_dir/health.json"
  grep -Fq '"status":"ok"' "$temp_dir/health.json"
  grep -Fq "\"version\":\"${version}\"" "$temp_dir/health.json"
  curl --fail --silent --show-error "http://127.0.0.1:${host_port}/" > "$temp_dir/index.html"
  grep -Eiq '<html([ >])' "$temp_dir/index.html"
  docker exec "$name" sh -ec 'test "$(id -u)" = 10001; test ! -e /app/.env; test -f "$PATCHPAW_HOME/data/control-plane.db"; test "$(cat "$PATCHPAW_HOME/docker-smoke-marker")" = persistent-state'

  docker exec "$name" sh -ec '
    root="$(mktemp -d)"
    git -c init.defaultBranch=main init --bare "$root/origin.git" >/dev/null
    git clone "$root/origin.git" "$root/work" >/dev/null 2>&1
    git -C "$root/work" config user.name "PatchPaw Docker smoke"
    git -C "$root/work" config user.email "docker-smoke@example.invalid"
    printf fixture > "$root/work/fixture.txt"
    git -C "$root/work" add fixture.txt
    git -C "$root/work" commit -m "docker smoke fixture" >/dev/null
    git -C "$root/work" push origin HEAD:refs/heads/main >/dev/null
    git --git-dir="$root/origin.git" rev-parse --verify refs/heads/main >/dev/null
    rm -rf "$root"
  '
}

start_service "$container"
verify_service "$container"

docker stop --time 30 "$container" >/dev/null
exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container")"
if [[ "$exit_code" != 0 ]]; then
  docker logs "$container" >&2
  echo "PatchPaw did not stop cleanly (exit code: $exit_code)." >&2
  exit 1
fi
docker rm "$container" >/dev/null

# Recreate the container against the same volume and prove runtime state survived.
container="$recreated_container"
start_service "$container"
verify_service "$container"
docker stop --time 30 "$container" >/dev/null
exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container")"
if [[ "$exit_code" != 0 ]]; then
  docker logs "$container" >&2
  echo "Recreated PatchPaw did not stop cleanly (exit code: $exit_code)." >&2
  exit 1
fi

docker build --build-arg "PATCHPAW_BASE_IMAGE=$image" --tag "$derived_image" \
  --file docker/examples/Dockerfile.extend .
docker run --rm --entrypoint /bin/sh "$derived_image" -ec \
  'test "$(id -u)" = 10001; python3 --version'

success=1
echo "Docker image smoke passed: non-root, env-only, migration, bootstrap, backup, health, frontend, git, persistence, SIGTERM, extension image."
