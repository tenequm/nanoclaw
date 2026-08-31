# NanoClaw Fork Migration Guide - v3

**Generated:** 2026-08-31
**Base (merge-base with upstream):** `879835bf` (2026-07-26, v2.1.53 line)
**Fork HEAD at extraction:** `fe64f73f`
**Upstream target:** `858421af` (v2.3.0 + unreleased tip, 2026-08-30)

Supersedes the v2 guide (base `3db66c0`). Re-extracted from the 54 fork commits on top of
`879835bf`. Sections are tagged:

- **[COPY]** - net-new files; copy from the fork tree (`git show fe64f73f:<path>`). Zero conflict.
- **[MERGE]** - both sides changed the file. Start from upstream, re-apply the fork's intent.
- **[DROPPED]** - deliberately not reapplied this round (with the replacement).

Data directories (`groups/`, `data/`, `.env`) are never touched.

## Migration plan (order of operations)

1. Deps: fork host deps layered onto upstream `package.json` (done before reapply; lockfile
   regenerated). Agent-runner deps: take upstream's pins as-is.
2. **B** Dockerfile blocks -> **D** container skills, tools, house style -> **A** telegram-grammy
   island -> **C** pond. One conventional commit per area.
3. Upstream migration detectors, full validation (see Validation).

Risk areas: A (adapter must conform to the `ChannelDefaults` contract and the async central DB +
mailbox APIs), C (hook sites moved into the driver spec / MCP registration).

---

# A. Telegram grammY + Effect-TS island

## A1. [COPY] The adapter island

**Intent:** native grammY adapter inside an Effect-TS v4 island, sending `{text, entities}`
(never `parse_mode`), with voice transcription, media-group albums, self-hosted Bot API support,
inline-keyboard ask-question cards that reflect the chosen option, forum topics as first-class
per-topic messaging groups (`platformId = telegram:<chatId>:<topicId>`), and a bounded topic map
so reactions resolve to the right topic. No automatic "seen" reactions.

**Files (copy from `fe64f73f`):**
```
src/channels/telegram-grammy/   ask-question, attachments, errors, formatter, inbound, index,
                                layers, media-meta, outbound, pairing-interceptor, reactions,
                                runtime, services, supervise, topic-map (+ .test.ts)
src/channels/telegram-pairing.ts (+ .test.ts)
src/transcription.ts
src/modules/topic-autowire/index.ts (+ .test.ts)
```
**Do NOT copy** `src/channels/telegram-grammy/commands/**` (host chat commands, dropped) - remove
every import of it from `index.ts`, and delete any dead helpers that only served it.
Also excise from the island: `TELEGRAM_NO_SEEN_CHATS` / seen-reaction remnants, and any call into
`src/modules/typing` beyond what upstream's typing module exports.

**Registration:** append `import './telegram-grammy/index.js';` to `src/channels/index.ts`
(with the two-line comment from the fork). Append `import './topic-autowire/index.js';` to
`src/modules/index.ts`.

**Adapt to upstream:**
- `src/channels/adapter.ts` now has `ChannelDefaults` / `ChannelContextDefaults`; declare
  `TELEGRAM_DEFAULTS` (DM: engage pattern `.`, threads false; group: mention-sticky, threads
  false - topics are separate messaging groups, not threads; unknown-sender policies matching the
  fork's behaviour) and export it from the adapter module like `slack.ts` on the channels branch.
- Central DB reads/writes are async (`await`). `getMessagingGroupByPlatform`, `getAgentGroup`,
  `getMessagingGroupAgents`, `createMessagingGroupAgent`, user lookups: await them.
- Session/mailbox access goes through `src/mailbox/` (not `src/db/session-db.ts`).
- `resolveGroupFolderForPlatformId(channelType, platformId)` helper (fork added to
  `src/group-folder.ts`) is used by attachments to stream bytes into the group folder - re-add
  it as an async function.
- Shutdown: register through the host lifecycle API, not `response-registry.ts`.
- `.env` keys stay: `TELEGRAM_BOT_TOKEN` (+ `_SUFFIX` per instance), `TELEGRAM_API_ROOT`,
  `TELEGRAM_LOCAL_FILES_DIR`, `OPENAI_API_KEY` (transcription).

## A2. [MERGE] Build config for the island

- `eslint.config.js`: `no-catch-all/no-catch-all: 'off'` with the fork's rationale comment; the
  telegram-grammy override block (`projectService: true`, `no-floating-promises` /
  `no-misused-promises: 'error'`).
- `tsconfig.json`: `target` + `lib` `ES2023` (Effect v4 needs it).
- `.gitignore`: add `.claude/scheduled_tasks.lock`.
- `package.json` deps: `grammy 1.44.0`, `@grammyjs/auto-retry 2.0.2`, `@grammyjs/files 1.2.0`,
  `@grammyjs/parse-mode 2.3.0`, `effect 4.0.0-beta.52`, `markdown-it ^14.1.1`,
  `mediabunny 1.40.1`, `openai ^6.34.0`; dev `@types/markdown-it ^14.1.2`.
  (`@grammyjs/commands`, `@grammyjs/menu` dropped with the chat commands.)

## A3. [DROPPED] Host chat commands
`src/commands/**`, `src/db/telegram-command-scopes.ts`, migration
`023-telegram-command-scopes`, `command-gate.ts` `classifyHostCommand`, router hook,
`interactive/index.ts` `hcmd-` skip, `docs/chat-commands.md`, telegram-grammy `commands/`.
Replacement: `ncl groups config update --model/--effort`, `ncl groups restart`,
`NANOCLAW_DEFAULT_MODEL` / `NANOCLAW_FAST_MODE`.

## A4. [DROPPED] Typing indicator on processing_ack
`src/modules/typing/**`, `src/host-sweep.ts`, `src/modules/agent-to-agent/*`,
`src/db/session-db.ts` changes. Redesign later against `outDb.getProcessingClaims()`.

---

# B. Container image

## B1. [MERGE] Dockerfile blocks (append-only, in this order after upstream's tool installs)
Copy the blocks verbatim from `git show fe64f73f:container/Dockerfile`:
1. apt: `git-lfs`, `openssh-client` added to upstream's base apt list.
2. Media stack: ffmpeg, atomicparsley, python3-pip; pip `yt-dlp yt-dlp-ejs instaloader mutagen
   pycryptodomex brotli websockets requests certifi curl_cffi secretstorage xattr`; Deno via
   `deno.land/install.sh`.
3. uv / uvx: `ARG UV_VERSION=<pinned>` + `COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION} /uv /uvx /usr/local/bin/`.
4. GitHub CLI `gh` from the official apt repo; `ENV GH_TOKEN=onecli-managed`;
   `ENV GIT_SSL_CAINFO=/tmp/onecli-combined-ca.pem`;
   `RUN git config --system credential.helper '!gh auth git-credential'`.
5. pond binary: `ARG POND_VERSION=<pinned>` block (see C).
Keep upstream's `PNPM_VERSION` / `NPM_VERSION` pins, `USER node`, `ENTRYPOINT`, and the
provenance `ARG`/`LABEL` block LAST. Do not reintroduce the fork's stale `PNPM_VERSION`.

## B2. [SUBSUMED] `container/cli-tools.json`
Upstream pins `@anthropic-ai/claude-code 2.1.238` (> fork 2.1.220). Take upstream.

---

# C. Pond cross-session recall (`/add-pond`)

## C1. [COPY] Skill folder and payload
```
.claude/skills/add-pond/**        (SKILL.md, REMOVE.md, pond-stores.ts + test,
                                   pond-mcp.ts, pond-registration.test.ts,
                                   pond-dockerfile.test.ts, pond-sync.sh,
                                   pond-recall-container-skill.md)
src/pond-stores.ts (+ .test.ts)   host mount policy
src/pond-dockerfile.test.ts
container/agent-runner/src/pond-mcp.ts (+ pond-registration.test.ts)
container/skills/pond-recall/SKILL.md
scripts/pond-sync.sh
```
`.gitignore` already ignores `data/`; nothing else.

## C2. [MERGE] Host hook - mount pond stores
Fork: `import { pondStoreMounts } from './pond-stores.js'` and
`mounts.push(...pondStoreMounts(agentGroup.id, DATA_DIR));` in `src/container-runner.ts`.
Upstream composes mounts into a `SessionSpec` (`src/drivers/types.ts` `MountSpec`, mount
classes) before the driver realizes them. Add the pond mounts where the other read-only
group-state mounts are composed, with the correct `MountClass` and `readOnly: true`; make
`pondStoreMounts` return the upstream mount shape. Keep the "host-decided, read-only" rule.
Store model (fork HEAD): one host-only `data/pond/stores.json` declaring named stores with
independent `ingest` (host sync loop) and `read` (mount) group lists; local stores live at
`data/pond/stores/<name>` and mount read-only at `/workspace/extra/pond/<name>`; remote
backends are never mounted. Mount class: `allowlisted-extra` (the only class whose policy
admits `data/pond/...` and the HF model-cache dir).

## C3. [MERGE] Agent-runner hook - register MCP servers
Fork: `import { pondMcpServers } from './pond-mcp.js'` and
`Object.assign(mcpServers, pondMcpServers());` in `container/agent-runner/src/index.ts`.
Upstream still builds an `mcpServers` map there; re-add at the equivalent spot.

## C4. Update the skill's own apply prose (`SKILL.md`) so its "Mount pond stores" and
"Register pond MCP servers" steps describe the upstream locations. The skill must remain
re-runnable on upstream trunk.

---

# D. Container skills, tools, house style

## D1. [COPY] Skill directories
`container/skills/meta-ads/`, `container/skills/gemini-image/`, `container/skills/tts/`,
`container/skills/media-download/` - copy wholesale. Check each SKILL.md's `send_file` /
`send_message` examples pass an explicit `to` (one-door rule).

## D2. [MERGE] `container/agent-runner/src/mcp-tools/core.ts`
Add the `send_media_group` tool (2-10 files as one album; requires `to`; copies files into
`/workspace/outbox/<id>/`; writes a `chat` message_out with
`content = JSON.stringify({operation:'send_media_group', items, files})`) and register it.
Expand `add_reaction`'s `emoji` description (slug translation). Upstream's outbound writer is
now the mailbox registry - use the same write path `send_file` uses there.

## D3. [MERGE] `container/agent-runner/src/formatter.ts` (+ test)
Attachment rendering: append ` transcript: "..."` when `a.transcript` is set; render
`[type: name — failed: <error>]` when `a.error` is set. (Keep upstream's em-dash here: it is
the machine format the agents parse, not prose.)

## D4. [MERGE] `container/CLAUDE.md`
Upstream is a 25-line platform doc. Prepend the fork's house-style banner (no em-dash / en-dash
ever, applies to every agent) and add the fork's sections: "Cite sources with clickable links",
"Don't speculate, look it up", "Prefer `glim` MCP tools for research", "GitHub and git"
(gh + git-over-HTTPS via the gateway, HTTPS remotes only). Rewrite upstream's own prose
em-dashes in this file to periods/colons so the file does not contradict its banner. Keep
upstream's Memory / Conversation history sections verbatim.

## D5. [DROPPED] Repo `CLAUDE.md` fork sections
Chat Commands, Per-agent group file layout (obsolete after the project-doc change), typing
gating note. Keep only: the "Per-agent Claude config (settings.json)" section and the
`pnpm lint` / `no-catch-all` note - re-add those two under Development.

---

# E. Dropped host/runner changes (for the record)
- `auto_compact_window`, `compact_notices` columns (migrations 022, 024, `container-configs.ts`,
  `container-config.ts`, `backfill`, `cli/resources/groups.ts`, `types.ts`, runner `config.ts`,
  `providers/claude.ts`) -> per-agent `settings.json` `autoCompactWindow`.
- Agent-runner delivery: notice event for compaction, native `/compact` notice, verbatim
  slash output, hold follow-up claims (`poll-loop.ts`, `providers/types.ts`, `db/messages-in.ts`).
- `pnpm-workspace.yaml` `packages: ["."]` (not reproducible on current pnpm).
- `src/channels/cli.ts` log tweak, `docs/build-and-runtime.md` wording, `upload-trace.test.ts`
  signal threading (check upstream's version of that test already threads a signal).

---

# Validation
```
pnpm install && pnpm build && pnpm lint && pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun install && bun test
./container/build.sh
bun scripts/detect-driver-migration.ts
grep -rn "claude-md-compose\|composeGroupClaudeMd\|claude-fragments" src/ setup/ scripts/
```
Plus the greps from `docs/agent-mailbox-seam-migration.md`, `docs/central-db-async-migration.md`,
`docs/host-lifecycle-migration.md`.
