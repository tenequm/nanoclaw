---
name: add-pond
description: Add pond cross-session recall. Agents search their own past sessions (and any stores the operator grants) via read-only MCP tools, with write (ingest) and read permissions controlled independently per store. Use when the user wants agents to remember past conversations, search session history, or recover context after compaction.
---

# Add Pond: Cross-Session Recall

Installs [pond](https://github.com/tenequm/pond) so agents can search past sessions. pond ingests the Claude Agent SDK transcripts each group already writes (`data/v2-sessions/<group>/.claude-shared/projects/**/*.jsonl`) into **stores** on the host; each container gets a read-only stdio MCP server (`pond_search`, `pond_get_session`, `pond_get_message`, `pond_sql`) over the stores it was granted. Transcripts NanoClaw rotates away stay recallable: pond is the durable copy.

## The store model

One concept, declared in `data/pond/stores.json` (host-only, never mounted):

```json
{
  "stores": {
    "mychat": { "ingest": ["<agent_group_id>"], "read": ["<agent_group_id>"] },
    "team":   { "ingest": ["<gid-a>", "<gid-b>", "<gid-c>"], "read": ["<gid-c>"] },
    "corpus": { "backend": "s3+https://host/bucket/prefix", "ingest": ["<gid-a>"], "read": [] }
  }
}
```

- **`ingest`**: whose transcripts are written into the store. Enforced by the host sync loop (`scripts/pond-sync.sh`). Containers never write pond and hold no storage credentials.
- **`read`**: whose containers may search it. Enforced by the mount table (`src/pond-stores.ts`): a local store mounts read-only at `/workspace/extra/pond/<name>` only for granted groups.
- The lists are independent on purpose. `team` above is the librarian pattern: three groups feed a shared store that only one may search.
- **`backend`** absent or `"local"`: the store lives at `data/pond/stores/<name>`. A URL backend (`s3+https://`, `s3://`, `gs://`) syncs to that remote instead; remote stores are never mounted (see "Remote stores" below).

Isolation is enforced by the mount table, never by query filters. Everything mounted is read-only.

Only the Claude provider writes these JSONL transcripts; groups on Codex/OpenCode get no recall corpus from this skill (their history is server-side or markdown archives, a future pond adapter concern).

Known limitation: every group runs at `cwd=/workspace/agent`, so inside a multi-group store all groups share one pond `project`. Search works; per-group filtering inside a shared store does not (a native nanoclaw adapter in pond would fix attribution).

## Phase 1: Pre-flight

### Check if already applied

Check if `src/pond-stores.ts` exists. If it does, re-run Phase 2 anyway (every step is idempotent), then continue to Phase 3.

### Install pond on the host

The host runs `pond sync` (ingest + embedding); the container only reads. Pin the same version used for `POND_VERSION` in Phase 2: host writes and container reads the same store format, and pond is pre-release with no compat shims.

```bash
command -v pond && pond --version || echo "Not installed"
```

If not installed (or older than the pin), install the release binary for the host platform:

```bash
# Homebrew (macOS or Linuxbrew):
brew install tenequm/tap/pond && pond --version
# or a release binary (targets: aarch64-apple-darwin, aarch64-unknown-linux-gnu, x86_64-unknown-linux-gnu):
curl -fsSL https://github.com/tenequm/pond/releases/download/v0.16.3/pond-x86_64-unknown-linux-gnu.tar.xz \
  | tar -xJ -C ~/.local/bin && chmod +x ~/.local/bin/pond
```

### Check there is something to ingest

```bash
ls -d data/v2-sessions/*/.claude-shared/projects 2>/dev/null || echo "No transcripts yet"
```

"No transcripts yet" is fine on a fresh install; stores fill up as agents run.

## Phase 2: Apply Code Changes

### Copy the skill's source and tests into both trees

```bash
S=.claude/skills/add-pond
# Host (Node) tree: mount policy and its tests
cp $S/pond-stores.ts          src/pond-stores.ts
cp $S/pond-stores.test.ts     src/pond-stores.test.ts
cp $S/pond-dockerfile.test.ts src/pond-dockerfile.test.ts
# Container (Bun) tree: MCP registration and its test
cp $S/pond-mcp.ts               container/agent-runner/src/pond-mcp.ts
cp $S/pond-registration.test.ts container/agent-runner/src/pond-registration.test.ts
# Host sync loop + container recall skill
cp $S/pond-sync.sh scripts/pond-sync.sh && chmod +x scripts/pond-sync.sh
mkdir -p container/skills/pond-recall
cp $S/pond-recall-container-skill.md container/skills/pond-recall/SKILL.md
```

### Mount pond stores in the host container runner

The host composes a fully-resolved `SessionSpec` and hands it to a session driver
(`src/drivers/types.ts`); `buildMounts` in `src/container-runner.ts` is still where the
group's mounts are assembled, as `VolumeMount[]` that `toMountSpecs` later converts into
the seam's `MountSpec[]`. That is the one reach-in.

Edit `src/container-runner.ts`. Add the import alongside the other local imports (next to
`./modules/mount-security/index.js`):

```ts
import { pondStoreMounts } from './pond-stores.js';
```

Then in `buildMounts`, after the provider-contributed mounts block and before `return mounts;`, add:

```ts
  // Pond recall stores (.claude/skills/add-pond): read-only, host-decided.
  // The module classes them itself - see the rationale in pond-stores.ts.
  mounts.push(...pondStoreMounts(agentGroup.id, DATA_DIR));
```

`pondStoreMounts` returns mounts already carrying `mountClass: 'allowlisted-extra'`,
`scope: <agent group id>` and `readonly: true`, so nothing has to be re-classed at the call
site. The class is not a style choice: `validateSpec` pins `group-state` to
`data/v2-sessions/<group>` and the group folder, and `install-surface` to the enumerated
release surfaces (`mountPolicy` in `src/drivers/index.ts`). A pond store lives at
`data/pond/stores/<name>` and the query-side model cache under the host user's HuggingFace
cache, so both would be denied under either of those classes. `allowlisted-extra` is the
class for host paths vetted in-tree rather than by a path rule - the same lane the
provider-contributed mounts ride - and this module does that vetting (read-list membership,
local backend, directory exists) and never emits a writable mount.

### Register pond MCP servers in the agent-runner

Edit `container/agent-runner/src/index.ts`. Add the import alongside the other local imports
(next to `./plugin-mcp.js`):

```ts
import { pondMcpServers } from './pond-mcp.js';
```

Inside `main()`, `mcpServers` starts as the built-in `nanoclaw` entry and is then filled by a
loop over `config.mcpServers` that runs each entry through `resolvePluginServer`. Directly
after that loop, before the `createProvider(...)` call that consumes the map, add:

```ts
  // Pond recall (.claude/skills/add-pond): one read-only stdio server per
  // store the host mounted under /workspace/extra/pond. No mount, no server.
  Object.assign(mcpServers, pondMcpServers());
```

The entries are plain stdio `McpServerConfig` values (`command` / `args` / `env`), so they
need no plugin resolution - `resolvePluginServer` is for plugin-shipped servers with
`${PLUGIN_ROOT}` expansion, and pond ships in the image.

### Bake the pond binary into the agent image

Edit `container/Dockerfile`. Immediately before the `# ---- Bun runtime` section, add:

```dockerfile
# ---- pond: cross-session recall (read-only MCP over mounted stores) ----------
ARG POND_VERSION=0.16.3
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

### Build and verify

```bash
./container/build.sh
pnpm exec tsc --noEmit
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec vitest run src/pond-stores.test.ts src/pond-dockerfile.test.ts
cd container/agent-runner && bun test src/pond-registration.test.ts && cd ../..
```

## Phase 3: Configure stores

Write `data/pond/stores.json` (create the directory if needed). Get group ids from `ncl groups list`. The common starting point is one private store per group that should remember its own history:

```json
{
  "stores": {
    "<short-name>": { "ingest": ["<agent_group_id>"], "read": ["<agent_group_id>"] }
  }
}
```

Run the first sync and confirm the store appears:

```bash
./scripts/pond-sync.sh
ls data/pond/stores/
```

Schedule it. On Linux, a systemd user timer (macOS: a launchd interval job):

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/nanoclaw-pond-sync.service <<EOF
[Unit]
Description=NanoClaw pond store sync
[Service]
Type=oneshot
ExecStart=$(pwd)/scripts/pond-sync.sh
WorkingDirectory=$(pwd)
EOF
cat > ~/.config/systemd/user/nanoclaw-pond-sync.timer <<EOF
[Unit]
Description=NanoClaw pond store sync every 15 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload && systemctl --user enable --now nanoclaw-pond-sync.timer
```

Restart the NanoClaw service so running containers respawn with the new mounts on their next wake.

### Remote stores

A store with a URL `backend` syncs to remote object storage (the operator's pond credentials from `~/.config/pond/config.toml` are used by the sync loop; containers never see them). Remote stores cannot be mounted, so `read` on them is served by a host-side `pond serve` reached through the credential gateway (an injected bearer token per agent), not by this skill's mount path. Configure that separately if needed; for local stores this section does not apply.

## Phase 4: Verify recall end to end

Ask a granted agent (in its channel) something like "search your pond store for what we discussed about X". The agent should call `pond_search` and answer from history. If the tools are missing: the store directory didn't exist at container spawn (run the sync, then restart the group's container) or the group isn't on the store's `read` list.

## Troubleshooting

- **Agent has no pond tools**: `stores.json` missing, group not in `read`, store dir absent (sync never ran), or the container predates the config (kill it; next message respawns with mounts).
- **`pond_search` returns nothing on a fresh store**: embedding happens at sync time; check `./scripts/pond-sync.sh` output and that the group actually has transcripts under `.claude-shared/projects`.
- **Vector search fails offline**: the query-side embedding model mounts from the host HF cache (`models--intfloat--multilingual-e5-small`); it appears after the first host sync downloads it.
- **Version skew**: host `pond --version` must match the image's `POND_VERSION` (pre-release formats move together). Bump both, rebuild, re-sync.
