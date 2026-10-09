#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  echo "Usage: $0 (build/load src+skills; stdout is the digest reference)"
  exit 0
fi
IMAGE="nanoclaw-source-dev:build-$$-$RANDOM"
trap 'docker image rm "$IMAGE" >/dev/null 2>&1 || true' EXIT
docker build --target source --provenance=false -t "$IMAGE" -f "$PROJECT_ROOT/container/Dockerfile.k8s" "$PROJECT_ROOT/container" >&2
DIGEST="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
PINNED="nanoclaw-source-dev:sha256-${DIGEST#sha256:}"
docker tag "$DIGEST" "$PINNED"
if ! docker exec nanoclaw-dev-control-plane ctr -n k8s.io images ls | awk -v digest="$DIGEST" '$1 ~ /nanoclaw-source-dev:/ && $3 == digest { found = 1 } END { exit !found }'; then
  kind load docker-image "$PINNED" --name nanoclaw-dev >&2
fi
# CRI resolves digest references by name, so register that alias after side-loading.
REF="docker.io/library/nanoclaw-source-dev@$DIGEST"
if ! docker exec nanoclaw-dev-control-plane ctr -n k8s.io images ls -q | grep -Fxq "$REF"; then
  docker exec nanoclaw-dev-control-plane ctr -n k8s.io images tag --force "docker.io/library/$PINNED" "$REF" >&2
fi
printf '%s\n' "$REF"
