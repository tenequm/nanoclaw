#!/usr/bin/env bash
# Sync agent-group transcripts into pond stores per data/pond/stores.json
# (.claude/skills/add-pond). Run from anywhere; resolves the project root
# from its own location (scripts/pond-sync.sh).
#
# stores.json shape:
#   { "stores": { "<name>": { "backend"?: "local" | "<url>",
#       "ingest": ["<agent_group_id>", ...], "read": ["<agent_group_id>", ...] } } }
#
# - ingest: whose transcripts are written into the store: enforced HERE.
# - read:   who may query it: enforced by mounts (src/pond-stores.ts) for
#           local stores, by the credential gateway for remote ones.
# - backend absent or "local": the store lives at data/pond/stores/<name>;
#   a URL (s3+https://…, s3://…, gs://…) syncs straight to that remote.
#
# pond guarantees make this loop safe to re-run and to overlap with a manual
# run: ingest is idempotent (merge on deterministic keys), freshness state is
# per-store, and --no-wait skips a tick when a sync already holds the store's
# single-flight lock.
set -euo pipefail

cd "$(dirname "$0")/.."

POND_BIN="${POND_BIN:-$(command -v pond)}"
[ -x "$POND_BIN" ] || { echo "pond binary not found (set POND_BIN or install pond)" >&2; exit 1; }

CONF=data/pond/stores.json
[ -f "$CONF" ] || { echo "pond-sync: no $CONF: nothing to do"; exit 0; }

# The operator's pond config stays in effect ON PURPOSE: remote backends
# resolve their credentials from its [creds] section. The explicit
# --storage-path and adapter --path overrides keep its [storage] and
# [adapters] sections inert for this run.

runs=0
while IFS='|' read -r store storage gid; do
  [ -n "$store" ] || continue
  projects="data/v2-sessions/$gid/.claude-shared/projects"
  [ -d "$projects" ] || continue
  "$POND_BIN" sync claude-code --path "$projects" --storage-path "$storage" -q --no-wait
  runs=$((runs + 1))
done < <(node -e '
  const fs = require("fs");
  const conf = JSON.parse(fs.readFileSync("data/pond/stores.json", "utf8"));
  for (const [name, s] of Object.entries(conf.stores ?? {})) {
    const storage = s.backend && s.backend !== "local" ? s.backend : `data/pond/stores/${name}`;
    for (const gid of s.ingest ?? []) console.log(`${name}|${storage}|${gid}`);
  }
')

echo "pond-sync: $runs group-store sync(s) completed"
