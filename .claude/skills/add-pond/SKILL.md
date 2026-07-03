---
name: add-pond
description: Add pond cross-session recall — agents search their own past sessions (and, if granted, other corpora) via read-only MCP tools. Use when the user wants agents to remember past conversations, search session history, or recover context after compaction.
---

# Add Pond — Cross-Session Recall

Installs [pond](https://github.com/tenequm/pond) so agents can search their own past sessions. pond ingests the Claude Agent SDK transcripts each group already writes (`data/v2-sessions/<group>/.claude-shared/projects/**/*.jsonl`) into per-group Lance stores on the host, and each container gets a read-only stdio MCP server (`pond_search`, `pond_get`, `pond_sql_query`) over its own store. Transcripts NanoClaw rotates away stay recallable — pond is the durable copy.

Isolation is enforced by the mount table, never by query filters:

- **Per-group store (always, automatic):** `data/pond/groups/<agent_group_id>` holds only that group's transcripts and is only ever mounted into that group's containers. Exactly as private as `.claude-shared` itself.
- **Shared store (opt-in):** `data/pond/shared` is the union of every group's transcripts. Mounted only into groups the operator grants in `data/pond/access.json` — a host-only file no container can reach.
- **Operator store (opt-in):** an external pond (e.g. your personal coding-session pond), granted the same way.

Only the Claude provider writes these JSONL transcripts; groups on Codex/OpenCode get no recall corpus from this skill (their history is server-side or markdown archives — a future pond adapter concern).

## Phase 1: Pre-flight

### Check if already applied

Check if `src/pond-mounts.ts` exists. If it does, re-run Phase 2 anyway — every step is idempotent — then continue to Phase 3 (Configure).

### Install pond on the host

The host runs `pond sync` (ingest + embedding); the container only reads.

```bash
command -v pond && pond --version || echo "Not installed"
```

If not installed, download the release binary for the host platform (pin the same version used for `POND_VERSION` in Phase 2 — host writes and container reads the same store format, and pond is pre-release with no compat shims):

```bash
# macOS arm64 example; targets: aarch64-apple-darwin, aarch64-unknown-linux-gnu, x86_64-unknown-linux-gnu
curl -fsSL https://github.com/tenequm/pond/releases/download/v0.11.2/pond-aarch64-apple-darwin.tar.xz \
  | tar -xJ -C ~/.local/bin pond && chmod +x ~/.local/bin/pond
```

### Check there is something to ingest

```bash
ls -d data/v2-sessions/*/.claude-shared/projects 2>/dev/null || echo "No transcripts yet"
```

"No transcripts yet" is fine on a fresh install — stores fill up as agents run; continue.

## Phase 2: Apply Code Changes

### Copy the skill's source and tests into both trees

```bash
S=.claude/skills/add-pond
# Host (Node) tree — mount policy and its tests
cp $S/pond-mounts.ts        src/pond-mounts.ts
cp $S/pond-mounts.test.ts   src/pond-mounts.test.ts
cp $S/pond-dockerfile.test.ts src/pond-dockerfile.test.ts
# Container (Bun) tree — MCP registration and its test
cp $S/pond-mcp.ts               container/agent-runner/src/pond-mcp.ts
cp $S/pond-registration.test.ts container/agent-runner/src/pond-registration.test.ts
# Host sync loop + container recall skill
cp $S/pond-sync.sh scripts/pond-sync.sh && chmod +x scripts/pond-sync.sh
mkdir -p container/skills/pond-recall
cp $S/pond-recall-container-skill.md container/skills/pond-recall/SKILL.md
```

### Mount pond stores in the host container runner

Edit `src/container-runner.ts`. Add the import alongside the other local imports:

```ts
import { pondMounts } from './pond-mounts.js';
```

Then in `buildMounts`, find the provider-contributed mounts block at the end:

```ts
  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
```

Insert the pond call before `return mounts;`:

```ts
  // Pond recall stores (.claude/skills/add-pond) — read-only, host-decided.
  mounts.push(...pondMounts(agentGroup.id, DATA_DIR));

  return mounts;
```

`pond-mounts.test.ts` asserts this `mounts.push(...pondMounts(` call exists and tests the mount policy itself (own store always, shared/operator only with an `access.json` grant).

### Register the pond MCP servers in the agent-runner

Edit `container/agent-runner/src/index.ts`. Add the import alongside the other local imports:

```ts
import { pondMcpServers } from './pond-mcp.js';
```

Then find the loop that merges `container.json` MCP servers:

```ts
  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
  }
```

Add the pond registration right after it:

```ts
  Object.assign(mcpServers, pondMcpServers());
```

`pond-registration.test.ts` asserts this call is present and that `pondMcpServers` maps each mounted store to a stdio server. Registering is sufficient — the agent's allow-pattern is derived from the server name.

### Dockerfile — install the pond binary

Insert immediately above the `# ---- Bun runtime` section of `container/Dockerfile` (skip if `grep -q 'POND_VERSION' container/Dockerfile` already matches):

```dockerfile
# ---- pond — cross-session recall (read-only MCP over mounted stores) ---------
ARG POND_VERSION=0.11.2
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends xz-utils && \
    ARCH=$(dpkg --print-architecture) && case "$ARCH" in \
      arm64) POND_TARGET=aarch64-unknown-linux-gnu ;; \
      amd64) POND_TARGET=x86_64-unknown-linux-gnu ;; \
      *) echo "unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/tenequm/pond/releases/download/v${POND_VERSION}/pond-${POND_TARGET}.tar.xz" \
    | tar -xJ -C /usr/local/bin pond && \
    chmod +x /usr/local/bin/pond
```

Pin `POND_VERSION` to the exact version installed on the host in Phase 1; never `latest`. `pond-dockerfile.test.ts` asserts the pinned ARG and download line (red if the layer is dropped on an upgrade).

### Validate code changes

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec vitest run src/pond-mounts.test.ts src/pond-dockerfile.test.ts
(cd container/agent-runner && bun test src/pond-registration.test.ts)
./container/build.sh
docker run --rm --entrypoint pond "$(docker images --format '{{.Repository}}:{{.Tag}}' | grep nanoclaw-agent | head -1)" --version
```

All must be clean before proceeding.

## Phase 3: Configure

### Run the first sync

```bash
bash scripts/pond-sync.sh
```

The first run downloads the embedding model (~500 MB one-time, cached under `~/.cache/huggingface`) and builds one store per group under `data/pond/groups/`. Containers mount that model cache read-only so in-container vector search works offline; without it pond still serves full-text search.

### Schedule the sync

Every 15 minutes, via the OS scheduler (not NanoClaw's per-session task machinery — ingest is a host concern). The sync is idempotent and single-flight per store, so overlapping runs are safe.

macOS (launchd):

```bash
source setup/lib/install-slug.sh
LABEL="$(launchd_label).pond-sync"
cat > ~/Library/LaunchAgents/$LABEL.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$PWD/scripts/pond-sync.sh</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>POND_BIN</key><string>$(command -v pond)</string>
  </dict>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardErrorPath</key><string>$PWD/logs/pond-sync.log</string>
  <key>StandardOutPath</key><string>$PWD/logs/pond-sync.log</string>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/$LABEL.plist
```

Linux (systemd user timer):

```bash
source setup/lib/install-slug.sh
UNIT="$(systemd_unit)-pond-sync"
mkdir -p ~/.config/systemd/user
printf '[Unit]\nDescription=NanoClaw pond sync\n[Service]\nType=oneshot\nEnvironment=POND_BIN=%s\nExecStart=/bin/bash %s/scripts/pond-sync.sh\n' "$(command -v pond)" "$PWD" > ~/.config/systemd/user/$UNIT.service
printf '[Unit]\nDescription=NanoClaw pond sync timer\n[Timer]\nOnUnitActiveSec=15min\nOnBootSec=2min\n[Install]\nWantedBy=timers.target\n' > ~/.config/systemd/user/$UNIT.timer
systemctl --user daemon-reload && systemctl --user enable --now $UNIT.timer
```

### Optional: shared store (cross-group recall)

Skip this unless the user explicitly wants one agent to search *other* groups' history. It crosses the group-isolation boundary: a prompt-injected agent with this grant can read every group's conversations, including chats with other people. Grant it only to groups that serve the operator alone.

```bash
mkdir -p data/pond/shared           # existence enables the shared sync leg
ncl groups list                      # find the ids of the groups to grant
```

Write `data/pond/access.json` (create, or extend if present):

```json
{ "shared": { "groups": ["<agent_group_id>"] } }
```

Then re-run `bash scripts/pond-sync.sh` to populate the shared store. Note: in the shared store, sessions from different groups are not yet distinguishable by pond's `project` field (all containers share a working directory) — group-level attribution arrives with pond's native NanoClaw adapter.

### Optional: operator store (your personal pond)

Same caution as the shared store — this exposes your own coding-session history to the granted groups. Add to `data/pond/access.json`:

```json
{ "operator": { "path": "~/.local/share/pond", "groups": ["<agent_group_id>"] } }
```

The path is your existing personal pond store (check with `pond status` outside this project); this skill never syncs it — your own pond schedule does.

### Restart the service

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
# systemctl --user restart $(systemd_unit)             # Linux
```

## Phase 4: Verify

Ask an agent something from an earlier conversation:

> Send a message like: "search your past sessions — what did we talk about last week?"

The agent should call `mcp__pond__pond_search` and answer from the hits. Check the store directly if needed:

```bash
POND_CONFIG_FILE=/dev/null POND_STORAGE_PATH=data/pond/groups/<agent_group_id> pond status
```

## Security notes

- Store mounts are read-only and pond's MCP surface is read-only by design; `pond erase` (deletion) exists only on the host CLI.
- The shared/operator grants live in `data/pond/access.json` on the host — outside every container mount, so an agent cannot grant itself access.
- Never mount the whole `~/.cache/huggingface` into a container (it can hold an HF auth token); `pond-mounts.ts` mounts only the one model directory.
- `ncl groups delete` does not delete the group's pond store — recall corpora are deliberately durable. To purge one: `rm -rf data/pond/groups/<agent_group_id>` (or `pond erase <session-id>` per session).

## Troubleshooting

### Agent has no `pond_search` tool

The store must exist before the container spawns: run `bash scripts/pond-sync.sh`, confirm `data/pond/groups/<agent_group_id>` exists, then `ncl groups restart --id <agent_group_id>`. Also confirm the image was rebuilt (`docker run --rm --entrypoint pond <image> --version`).

### Vector search errors with "embedder load failed"

The embedding-model cache mount is missing — the host hasn't downloaded the model yet. Run `bash scripts/pond-sync.sh` once on the host (it downloads the model), then restart the group. Full-text mode works regardless.

### A group's store stays empty

Only Claude-provider groups produce JSONL transcripts. Check `ls data/v2-sessions/<agent_group_id>/.claude-shared/projects/` — if empty, the group hasn't completed a session since the skill was installed, or runs a non-Claude provider.

### Sync log shows a lock wait

Two syncs hit the same store concurrently (e.g. manual + scheduled). Harmless — pond serializes them; the second run proceeds when the first finishes.
