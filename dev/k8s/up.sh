#!/usr/bin/env bash
# Converge the local cluster, controller and images; optionally run the playground.
# Safe to re-run. Every kubectl call goes through dev/k8s/.kubeconfig, never
# ~/.kube/config, so a stray command can not land on a real cluster.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CLUSTER=nanoclaw-dev
KUBECONFIG_FILE="$SCRIPT_DIR/.kubeconfig"
AGENT_SANDBOX_VERSION=v1.0.6
AGENT_SANDBOX_MANIFEST="https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/sandbox-with-extensions.yaml"

# Default to the tag ./container/build.sh produces for this checkout.
# shellcheck source=../../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
SOURCE_IMAGE="${NANOCLAW_K8S_IMAGE:-$(container_image_base):latest}"
case "${1:-}" in
  --help|-h) echo "Usage: $0 [--playground] (NANOCLAW_K8S_IMAGE selects a local base image)"; exit 0 ;;
  --playground|'') ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac
PLAYGROUND="${1:-}"

k() { kubectl --kubeconfig "$KUBECONFIG_FILE" --context "kind-$CLUSTER" "$@"; }
step() { printf '\n==> %s\n' "$*"; }

for bin in docker kind kubectl; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done
if ! docker image inspect "$SOURCE_IMAGE" >/dev/null 2>&1; then
  echo "Agent image '$SOURCE_IMAGE' is not in the local docker store." >&2
  echo "Build it with ./container/build.sh, or point NANOCLAW_K8S_IMAGE at one that exists." >&2
  exit 1
fi

IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$SOURCE_IMAGE")"
IMAGE="nanoclaw-agent-dev:sha256-${IMAGE_ID#sha256:}"
docker tag "$IMAGE_ID" "$IMAGE"

step "Cluster $CLUSTER"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "exists"
  kind export kubeconfig --name "$CLUSTER" --kubeconfig "$KUBECONFIG_FILE"
else
  kind create cluster --config "$SCRIPT_DIR/kind-config.yaml" --kubeconfig "$KUBECONFIG_FILE" --wait 120s
fi

step "agent-sandbox controller $AGENT_SANDBOX_VERSION"
# Server-side apply: the SandboxTemplate CRD is too large for the
# last-applied-configuration annotation client-side apply writes.
k apply --server-side --force-conflicts -f "$AGENT_SANDBOX_MANIFEST" >/dev/null
k wait --for=condition=Established --timeout=60s \
  crd/sandboxes.agents.x-k8s.io \
  crd/sandboxtemplates.extensions.agents.x-k8s.io \
  crd/sandboxwarmpools.extensions.agents.x-k8s.io \
  crd/sandboxclaims.extensions.agents.x-k8s.io
k -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s

step "Load $IMAGE into the node"
# kind's own skip check compares image IDs, which never match under Docker's
# containerd image store (OrbStack, recent Docker Desktop): docker reports the
# index digest, the node the config digest. Compare the index digest against
# the node's containerd target instead, and fall through to kind otherwise.
if docker exec "$CLUSTER-control-plane" ctr -n k8s.io images ls 2>/dev/null |
  awk -v ref="$IMAGE" -v id="$IMAGE_ID" '
    ($1 == ref || substr($1, length($1) - length(ref)) == "/" ref) && $3 == id { found = 1 }
    END { exit !found }'; then
  echo "already on the node ($IMAGE_ID)"
else
  kind load docker-image "$IMAGE" --name "$CLUSTER"
fi

printf '\nBase image reference: %s\n' "$IMAGE"
"$SCRIPT_DIR/build-source.sh"
if [[ "$PLAYGROUND" != --playground ]]; then
  exit 0
fi

step "SandboxTemplate + SandboxWarmPool"
sed "s|__NANOCLAW_K8S_IMAGE__|$IMAGE|" "$SCRIPT_DIR/sandbox-template.yaml" | k apply -f -
k apply -f "$SCRIPT_DIR/warm-pool.yaml"
# The claim goes in only once the pool is warm, so it adopts instead of cold-starting.
k wait --for=jsonpath='{.status.readyReplicas}'=1 swp/nanoclaw-agent-pool --timeout=180s

step "SandboxClaim nanoclaw-sample"
k apply -f "$SCRIPT_DIR/sample-claim.yaml"
k wait --for=condition=Ready sandboxclaim/nanoclaw-sample --timeout=180s
SANDBOX="$(k get sandboxclaim nanoclaw-sample -o jsonpath='{.status.sandbox.name}')"
k wait --for=condition=Ready "sandbox/$SANDBOX" --timeout=180s

step "Status"
k get sandboxtemplate,sandboxwarmpool,sandboxclaim,sandbox,pod -o wide

cat <<EOF

Ready. Claimed sandbox: $SANDBOX (its pod has the same name)

  export KUBECONFIG=$KUBECONFIG_FILE
  kubectl exec -it $SANDBOX -- bash
  kubectl patch sandbox $SANDBOX --type merge -p '{"spec":{"operatingMode":"Suspended"}}'
  kubectl patch sandbox $SANDBOX --type merge -p '{"spec":{"operatingMode":"Running"}}'
  kubectl -n agent-sandbox-system logs deploy/agent-sandbox-controller -f

Tear down: $SCRIPT_DIR/down.sh
EOF
