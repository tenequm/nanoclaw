#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
k() { kubectl --kubeconfig "$SCRIPT_DIR/.kubeconfig" --context kind-nanoclaw-dev --request-timeout=15s "$@"; }
case "${1:-}" in
  create)
    SUFFIX="$(printf '%s' "${2:-$(date +%s)-$RANDOM}" | LC_ALL=C tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g; s/^-*//; s/-*$//' | cut -c1-49 | sed 's/-*$//')"
    [[ -n "$SUFFIX" ]] || { echo "Empty sanitized suffix" >&2; exit 2; }
    NAME="nanoclaw-test-$SUFFIX"
    k create namespace "$NAME" >&2
    printf '%s\n' "$NAME"
    ;;
  delete)
    [[ "${2:-}" =~ ^nanoclaw-test-[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#2} -le 63 ]] || { echo "Expected nanoclaw-test-<suffix>" >&2; exit 2; }
    k delete namespace "$2" --wait=false --ignore-not-found=true
    ;;
  *) echo "Usage: $0 create [suffix] | delete nanoclaw-test-<suffix>"; [[ "${1:-}" == --help || "${1:-}" == -h ]] || exit 2 ;;
esac
