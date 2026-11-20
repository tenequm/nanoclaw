#!/usr/bin/env bash
# Scans new changes for secrets and private data with Betterleaks: .betterleaks.toml, then the
# private rule set when $BETTERLEAKS_PRIVATE_CONFIG or ~/.config/betterleaks/private.toml exists.
#   scripts/leaks.sh              staged changes (pre-commit)
#   scripts/leaks.sh A..B         the first-parent commits of a range (CI)
#   scripts/leaks.sh --pre-push   the ranges git's pre-push hook names on stdin
# First-parent only: upstream history merged into this fork is not scanned again.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if ! command -v betterleaks >/dev/null; then
  echo 'leaks: Betterleaks 1.10 is required (brew install betterleaks)' >&2
  exit 1
fi
configs=(.betterleaks.toml)
private="${BETTERLEAKS_PRIVATE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/betterleaks/private.toml}"
if [[ -f "$private" ]]; then configs+=("$private"); fi

scan() {
  local config
  for config in "${configs[@]}"; do
    if [[ $# -eq 0 ]]; then
      betterleaks git --pre-commit --staged --no-banner --redact --config "$config" .
    else
      betterleaks git --log-opts "--first-parent $1" --no-banner --redact --config "$config" .
    fi
  done
}

if [[ "${1:-}" == --pre-push ]]; then
  while read -r _ local _ remote; do
    [[ "$local" == *[!0]* ]] || continue
    if [[ "$remote" == *[!0]* ]]; then scan "$remote..$local"; else scan "$local --not --remotes"; fi
  done
else
  scan "$@"
fi
