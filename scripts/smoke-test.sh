#!/usr/bin/env bash
# Image smoke test (run by CI; needs Docker).
# Usage: scripts/smoke-test.sh <image>
# Starts the image as an arbitrary non-root UID/GID with a temp folder as a read-only Mount,
# waits for the image HEALTHCHECK to report healthy, checks the :ro Mount logged no warning,
# then runs smoke-check.sh.
set -euo pipefail

image="${1:?usage: $0 <image>}"
here="$(cd "$(dirname "$0")" && pwd)"

fail() { echo "smoke: FAIL: $*" >&2; exit 1; }

# The image's default user must not be root.
default_user="$(docker image inspect -f '{{.Config.User}}' "$image")"
case "$default_user" in
  "" | root | 0 | 0:* | root:*) fail "image default user is root (\"$default_user\")" ;;
esac
echo "smoke: ok: image default user is \"$default_user\""

root_dir="$(mktemp -d)"
echo "hello from the smoke test" > "$root_dir/smoke-hello.txt"
chmod 755 "$root_dir"
chmod 644 "$root_dir/smoke-hello.txt"

token="$(openssl rand -hex 32)"
uid=12345
gid=12345

cid="$(docker run -d \
  --platform linux/amd64 \
  --user "$uid:$gid" \
  -e NAS_MCP_TOKEN="$token" \
  -v "$root_dir:/data/smoke:ro" \
  -p 127.0.0.1::8080 \
  "$image")"

cleanup() {
  status=$?
  if [[ $status -ne 0 ]]; then
    echo "--- container logs ---" >&2
    docker logs "$cid" >&2 || true
  fi
  docker rm -f "$cid" > /dev/null 2>&1 || true
  rm -rf "$root_dir"
  exit $status
}
trap cleanup EXIT

# Runs as the UID/GID we passed, not root.
ids="$(docker exec "$cid" sh -c 'echo "$(id -u):$(id -g)"')"
[[ "$ids" == "$uid:$gid" ]] || fail "container runs as $ids, want $uid:$gid"
echo "smoke: ok: container runs as $ids"

health=""
for _ in $(seq 1 60); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$cid")"
  [[ "$health" == "healthy" ]] && break
  [[ "$(docker inspect -f '{{.State.Running}}' "$cid")" == "true" ]] || fail "container exited"
  sleep 1
done
[[ "$health" == "healthy" ]] || fail "container health is \"$health\" after 60 s"
echo "smoke: ok: container healthcheck is healthy"

# A :ro Mount is read-only by intent and must not log a warning (only an unwritable rw Mount does).
logs="$(docker logs "$cid" 2>&1)"
[[ "$logs" != *'"type":"warning"'* ]] || fail "container logged a warning for the :ro Mount: $(grep '"type":"warning"' <<< "$logs")"
echo "smoke: ok: no startup warning for the :ro Mount"

port="$(docker port "$cid" 8080/tcp | head -n1 | sed 's/.*://')"
SMOKE_TOKEN="$token" "$here/smoke-check.sh" "http://127.0.0.1:$port"
echo "smoke: all checks passed"
