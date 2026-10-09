#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  echo "Usage: $0 (print Mac IPv4 reachable through the kind node)"
  exit 0
fi
ADDRESS="$(docker exec nanoclaw-dev-control-plane getent ahostsv4 host.docker.internal | awk 'NR == 1 { print $1 }')"
[[ "$ADDRESS" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "Could not resolve host IPv4" >&2; exit 1; }
printf '%s\n' "$ADDRESS"
