#!/usr/bin/env bash
# Sync every agent group's Claude transcripts into its pond store
# (.claude/skills/add-pond). Run from anywhere; resolves the project root
# from its own location (scripts/pond-sync.sh).
#
# Stores:
# - data/pond/groups/<agent_group_id>  — always, one per group with transcripts
# - data/pond/shared                   — additionally, iff the directory exists
#   (created by the skill when the operator opts in; union of all groups)
#
# pond guarantees make this loop safe to re-run and to overlap with a manual
# run: ingest is idempotent (merge on deterministic keys), freshness state is
# per-store, and a per-store single-flight lock serializes concurrent syncs.
set -euo pipefail

cd "$(dirname "$0")/.."

POND_BIN="${POND_BIN:-$(command -v pond)}"
[ -x "$POND_BIN" ] || { echo "pond binary not found (set POND_BIN or install pond)" >&2; exit 1; }

# Never read the operator's personal pond config: these stores are selected
# per invocation and must not inherit [storage] or [adapters] from it.
export POND_CONFIG_FILE="${POND_CONFIG_FILE:-/dev/null}"

synced=0
for gdir in data/v2-sessions/*/; do
  [ -d "$gdir" ] || continue
  gid="$(basename "$gdir")"
  projects="$gdir.claude-shared/projects"
  [ -d "$projects" ] || continue

  POND_STORAGE_PATH="data/pond/groups/$gid" \
    "$POND_BIN" sync claude-code --path "$projects" -q

  if [ -d data/pond/shared ]; then
    POND_STORAGE_PATH="data/pond/shared" \
      "$POND_BIN" sync claude-code --path "$projects" -q
  fi
  synced=$((synced + 1))
done

echo "pond-sync: $synced group(s) synced"
