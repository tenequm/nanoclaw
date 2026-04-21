---
name: debug
description: Debug NanoClaw v2 issues — host service not running, container fails, messages not reaching agents, DB inspection, channel auth. Uses systemd/launchctl, two-DB session split, Chat SDK bridge.
---

# NanoClaw v2 Debugging

## Architecture recap

```
Host (Node, pnpm)                       Container (Bun, one per session)
─────────────────────────────────────────────────────────────────────────
src/channels/*           polls           /workspace/inbound.db   (host writes)
src/router.ts        writes inbound    ▶ /workspace/outbound.db  (container writes)
src/delivery.ts     polls outbound   ◀ /workspace/outbox/        (outgoing files)
src/container-runner.ts                 /workspace/.heartbeat    (container touches)
```

**No IPC, no stdin piping** — the two session DBs are the sole IO surface between host and container. Exactly one writer per file.

## Service management

```bash
# Linux (systemd user)
systemctl --user status nanoclaw
systemctl --user restart nanoclaw
journalctl --user -u nanoclaw -n 50 --no-pager

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
launchctl list | grep nanoclaw
```

## Log locations

| Log | Where | What |
|-----|-------|------|
| Host main | `logs/nanoclaw.log` | Routing, container spawn, Chat SDK events |
| Host errors | `logs/nanoclaw.error.log` | Fatal + rolled-back agent errors |
| Container per-run | `groups/{folder}/logs/container-*.log` | One file per spawn: mounts, stderr, stdout |

Host unit uses `append:` redirection — both files grow until rotated manually.

Enable verbose logs:
```
# systemd user unit [Service] section:
Environment=LOG_LEVEL=debug
```

## Quick status

```bash
echo "=== service ==="
systemctl --user is-active nanoclaw

echo "=== agent containers ==="
docker ps --format '{{.Names}} {{.Status}}' | grep -i nanoclaw

echo "=== orphans ==="
docker ps -a --format '{{.Names}} {{.Status}}' | grep -i nanoclaw

echo "=== image present ==="
docker images nanoclaw-agent:latest --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}} {{.Size}}'

echo "=== recent errors ==="
grep -E 'ERROR|FATAL|WARN' logs/nanoclaw.log | tail -10

echo "=== channels connected ==="
grep -E 'Channel adapter started|polling started|Webhook server started' logs/nanoclaw.log | tail -5

echo "=== entity model populated ==="
sqlite3 data/v2.db "SELECT 'users:'||count(*) FROM users; \
  SELECT 'agent_groups:'||count(*) FROM agent_groups; \
  SELECT 'messaging_groups:'||count(*) FROM messaging_groups; \
  SELECT 'sessions:'||count(*) FROM sessions;"
```

## Central DB (`data/v2.db`)

Key tables:

| Table | What |
|-------|------|
| `users` | `id="<channel>:<handle>"`, display_name, kind |
| `user_roles` | owner / admin (global or scoped to an agent_group) |
| `agent_groups` | workspace + CLAUDE.md + provider. Container config lives on disk at `groups/<folder>/container.json`, not in the DB |
| `messaging_groups` | one chat/channel on one platform; `unknown_sender_policy` |
| `messaging_group_agents` | wire-up + `session_mode` + trigger rules |
| `sessions` | per-session container state; joins agent_group + messaging_group + thread_id |
| `pending_approvals` | queued approval prompts (OneCLI, self-mod, etc.) |
| `unregistered_senders` | cold DMs from unknown users |
| `chat_sdk_*` | Chat SDK bridge state per channel (kv, subs, locks, lists) |

Common queries:
```bash
# Who's wired where?
sqlite3 -header -column data/v2.db "
  SELECT mg.platform_id, mg.channel_type, ag.name AS agent, mga.session_mode
  FROM messaging_group_agents mga
  JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
  JOIN agent_groups ag ON ag.id = mga.agent_group_id;
"

# Active sessions
sqlite3 -header -column data/v2.db "
  SELECT id, agent_group_id, messaging_group_id, thread_id, created_at FROM sessions;
"

# Pending approvals
sqlite3 -header -column data/v2.db "SELECT id, reason, requested_at FROM pending_approvals LIMIT 10;"
```

## Session DBs (`data/v2-sessions/<session_id>/`)

Per-session there are **two** SQLite files:

- `inbound.db` — host writes, container reads: `messages_in`, `destinations`, `routing`, `pending_questions`, `processing_ack`
- `outbound.db` — container writes, host reads: `messages_out`, `session_state`

Heartbeat: container touches `/workspace/.heartbeat` (mapped to `<session_dir>/.heartbeat`). Stale = host sweep kills + respawns.

Inspect:
```bash
SESSION=$(ls -t data/v2-sessions | head -1)

# Inbound (host-written messages)
sqlite3 -header -column data/v2-sessions/$SESSION/inbound.db "
  SELECT seq, datetime(created_at/1000,'unixepoch') AS when_, kind, substr(content,1,80) AS content
  FROM messages_in ORDER BY seq DESC LIMIT 10;
"

# Outbound (container-written messages)
sqlite3 -header -column data/v2-sessions/$SESSION/outbound.db "
  SELECT seq, datetime(created_at/1000,'unixepoch') AS when_, kind, substr(content,1,80) AS content
  FROM messages_out ORDER BY seq DESC LIMIT 10;
"

# Session cursor/state
sqlite3 -header -column data/v2-sessions/$SESSION/outbound.db "SELECT * FROM session_state;"

# Heartbeat age (seconds ago)
stat -c %Y data/v2-sessions/$SESSION/.heartbeat 2>/dev/null | awk -v now=$(date +%s) '{print now-$1, "s ago"}'
```

`seq` parity invariant: host uses even numbers, container uses odd. If you see a row with wrong parity on the wrong side, something bypassed the writer.

## Container mounts (v2)

```
groups/<folder>/                   → /workspace/agent          (rw)
groups/global/                     → /workspace/global          (ro, optional)
data/v2-sessions/<id>/             → /workspace                 (rw)
data/v2-sessions/<id>/.claude-shared/ → /home/node/.claude      (rw)
data/v2-sessions/<id>/agent-runner-src/ → /app/src              (rw overlay)
```

Env vars set in the container:
- `SESSION_INBOUND_DB_PATH=/workspace/inbound.db`
- `SESSION_OUTBOUND_DB_PATH=/workspace/outbound.db`
- `SESSION_HEARTBEAT_PATH=/workspace/.heartbeat`
- `HOME=/home/node`
- `NANOCLAW_MCP_SERVERS=<json>` (per-group `container.json → mcpServers` passed through)

Inspect what actually got mounted on the last run:
```bash
grep "Container spawned\|mount" groups/<folder>/logs/container-*.log | tail -20
```

## Common issues

### 1. Service won't start — `EADDRINUSE 0.0.0.0:3000`
The Chat SDK bridge's local webhook server binds to 3000 by default. Host it next to another `:3000` service and it crashes.

Fix in the systemd unit (`~/.config/systemd/user/nanoclaw.service`):
```
Environment=WEBHOOK_PORT=3001
```
Then `systemctl --user daemon-reload && systemctl --user restart nanoclaw`.

### 2. `Container exited with code 125: pull access denied for nanoclaw-agent`
The image was deleted by Kubernetes/container runtime image GC. Rebuild:
```bash
./container/build.sh
```
Root cause on Rancher Desktop: Kubernetes kubelet GC. `rdctl set --kubernetes-enabled=false` if you don't need k8s.

### 3. Incoming message goes nowhere
Likely causes and queries:
```bash
# Is the sender known?
sqlite3 data/v2.db "SELECT * FROM users WHERE id LIKE '%<handle>%';"

# If unknown — check messaging_group's policy
sqlite3 data/v2.db "SELECT platform_id, unknown_sender_policy FROM messaging_groups;"

# Was it queued as an unregistered sender?
sqlite3 -header -column data/v2.db "SELECT * FROM unregistered_senders ORDER BY created_at DESC LIMIT 10;"

# Was it routed into an inbound.db? Check the most recent session
grep -E 'Routed|routing' logs/nanoclaw.log | tail -10
```

### 4. Container spawns but agent never replies
```bash
SESSION=$(ls -t data/v2-sessions | head -1)

# Did the container write anything?
sqlite3 data/v2-sessions/$SESSION/outbound.db "SELECT count(*) FROM messages_out;"

# Is it still heartbeating?
stat -c %y data/v2-sessions/$SESSION/.heartbeat

# Container logs
ls -lt groups/*/logs/container-*.log | head -3 | awk '{print $NF}' | xargs tail -40
```

### 5. Claude SDK `exit 1` / auth failure
OAuth/API key flows through OneCLI, not env vars. Check:
```bash
# OneCLI reachable?
curl -s "$ONECLI_URL/health" || echo "OneCLI not responding"

# Agent identity registered?
onecli agent list | grep <agent-group-folder>
```

Session continuity lives in `data/v2-sessions/<id>/.claude-shared/` (mounted to `/home/node/.claude`). To reset one session:
```bash
rm -rf data/v2-sessions/<session_id>/.claude-shared/
sqlite3 data/v2.db "DELETE FROM sessions WHERE id='<session_id>';"
```

### 6. MCP server missing from agent's tool list
Agent's `settings.json` (per session):
```bash
cat data/v2-sessions/<session_id>/.claude-shared/settings.json
```
Should have `permissions.allow` including the MCP name (e.g., `mcp__<name>__*`). Groups created before an MCP was added need their settings.json updated manually.

Per-group MCP servers live in `groups/<folder>/container.json → mcpServers`. The host passes the whole blob to the container via `NANOCLAW_MCP_SERVERS` env; the agent-runner merges it into the SDK's MCP config. Supported transports: stdio (`{command, args, env}`), HTTP (`{type: 'http', url, headers}`), SSE (`{type: 'sse', url, headers}`).

```bash
# What's actually declared for a group?
cat groups/<folder>/container.json | jq .mcpServers

# What did the container see at boot?
grep -E "Additional MCP server|mcpServers" groups/<folder>/logs/container-*.log | tail -10

# HTTP/SSE handshake issues? Hit the URL from host to rule out auth/network:
curl -i -H "Authorization: Bearer $TOKEN" <mcp-url>
```

### 7. Voice message stays silent (no transcript)
```bash
# OPENAI_API_KEY in env?
grep -c "^OPENAI_API_KEY=" .env

# Attachment materialized to host?
ls groups/<folder>/attachments/ 2>&1 | tail -5

# Whisper errors in logs?
grep -iE 'transcrib|whisper|openai' logs/nanoclaw.log logs/nanoclaw.error.log | tail -10
```

## Manual container run (v2 shape)

You **cannot** pipe JSON to stdin — v2 reads from DB. To exercise the image manually:

```bash
# Interactive shell in the image
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest

# Binary sanity
docker run --rm --entrypoint sh nanoclaw-agent:latest -c \
  'yt-dlp --version; instaloader --version; deno --version; \
   ffmpeg -version | head -1; claude --version; bun --version'

# Spawn a real session container against a fake session dir
SESS=/tmp/fake-session
mkdir -p $SESS/.claude-shared
sqlite3 $SESS/inbound.db  "CREATE TABLE messages_in(seq INT, kind TEXT, content TEXT, created_at INT);"
sqlite3 $SESS/outbound.db "CREATE TABLE messages_out(seq INT, kind TEXT, content TEXT, created_at INT);"
docker run --rm -it \
  -v $SESS:/workspace \
  -e SESSION_INBOUND_DB_PATH=/workspace/inbound.db \
  -e SESSION_OUTBOUND_DB_PATH=/workspace/outbound.db \
  -e SESSION_HEARTBEAT_PATH=/workspace/.heartbeat \
  nanoclaw-agent:latest
```

## Reset / nuke

```bash
# Stop service
systemctl --user stop nanoclaw

# Drop all session state (containers + session DBs + attachments stay in groups/)
docker ps -a --format '{{.Names}}' | grep -E '^nanoclaw-session-' | xargs -r docker rm -f
rm -rf data/v2-sessions/

# Nuke the whole central DB (USERS, GROUPS, WIRING all gone — re-run setup afterwards)
rm data/v2.db data/v2.db-shm data/v2.db-wal
```

## Rebuild

```bash
# Host code change
pnpm run build && systemctl --user restart nanoclaw

# Container change (agent-runner source, Dockerfile, skills)
./container/build.sh && systemctl --user restart nanoclaw

# Forced rebuild (clear layer cache)
docker builder prune -af && ./container/build.sh
```

## Container skills (`container/skills/*`)
These are copied into each session on spawn via `initGroupFilesystem` — **no rebuild needed** for markdown edits. Just restart the service (or wait for the next session spawn) and the new skill is live.
