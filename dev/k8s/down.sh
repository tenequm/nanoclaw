#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
kind delete cluster --name nanoclaw-dev --kubeconfig "$SCRIPT_DIR/.kubeconfig"
rm -f "$SCRIPT_DIR/.kubeconfig"
