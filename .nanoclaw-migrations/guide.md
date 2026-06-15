# NanoClaw Fork Migration Guide — v2 (refreshed)

**Generated:** 2026-04-17 · **Refreshed:** 2026-06-15
**Base (merge-base with upstream):** `3db66c0` — NanoClaw v2.0.0
**Fork HEAD at refresh:** `9a5f345`
**Upstream tip at refresh:** v2.0.64 line (`acbb114`)

> This refresh **re-extracts** the fork's 31 commits on top of `3db66c0`
> (`git diff 3db66c0..HEAD`). It supersedes the previous guide, whose Telegram
> sections described the now-removed legacy adapter. The recorded fork tip in
> the old guide (`43d3248`) is orphaned — history was reset onto v2.0.0 during
> the last migration, so the merge-base `3db66c0` is the only correct base.

## How to use this guide

On upgrade: check out clean `upstream/main` in a worktree, then for each
customization below apply the "How to apply" instructions. Sections are tagged:

- **[COPY]** — net-new files; copy wholesale from the fork tree. Zero conflict.
- **[SUBSUMED]** — upstream already did this independently. Do **not** replay;
  verify upstream's version and move on.
- **[MERGE]** — both sides changed the same file. Start from upstream's version,
  then re-apply the fork's intent as a targeted edit. Conflict risk noted.

Data directories (`groups/`, `data/`, `store/`, `.env`) are **never touched** —
per-group `container.json` (Surf MCP allowlist), per-group `settings.json`, and
personas survive automatically.

---

## Migration Plan (order of operations)

1. **[COPY] blocks first** — drop in the telegram-grammy island, openclaw-markdown
   vendor, transcription, media-download skill, setup/pair-telegram.ts, tsconfig,
   eslint. These can't conflict.
2. **Dependencies** — layer fork deps onto upstream's `package.json`; resolve the
   agent-runner SDK version decision (see §C1). Regenerate lockfiles.
3. **[MERGE] host source** — container-runner, typing, group-init, register.
4. **[MERGE] container source** — claude.ts, poll-loop.ts, formatter, core, Dockerfile.
5. **[MERGE] docs/config** — both CLAUDE.md files, .gitignore.
6. **Validate** — host build/test + container typecheck/test.
7. **Breaking changes** — OneCLI /v1, upgrade marker, service rename (see §E).

**Risk areas (heaviest merges):** `container-runner.ts`, `typing/index.ts`,
`group-init.ts`, `poll-loop.ts`, `claude.ts`, both `CLAUDE.md`, `Dockerfile`,
`package.json`. The agent-runner SDK jump (`0.2.123` → upstream `0.3.170`) is the
single biggest correctness risk — the `translateSdkMessages` rewrite was built
against the 0.2.x message shape.

---

## Applied skills / channels

The fork installs no channel via the upstream skill-merge mechanism — Telegram is
a **vendored in-tree island** (see §A1), not an `/add-telegram` Chat-SDK install.
So there are no `upstream/skill/*` branches to re-merge. Everything is either a
[COPY] or a [MERGE] below.

Custom container skill: `container/skills/media-download/` (§D5) — copy as-is.

---

# A. Telegram + markdown rendering

## A1. [COPY] Telegram grammY + Effect-TS v4 island

**Intent:** Replace the legacy `@chat-adapter/telegram` Chat-SDK bridge with a
native **grammY** adapter inside an **Effect-TS v4** island. Motivation: upstream's
bridge sent `parse_mode: 'MarkdownV2'`, which crashes on any unescaped `_`/`*`
(GH tokens, URLs). The grammY adapter sends `{ text, entities }` directly —
Telegram never parses when entities are supplied. Adds: 👀 seen-reactions, voice
transcription, media-group albums, per-table width gating, self-hosted Bot API
(`--local`) support for >20 MB files, inline-keyboard ask-question.

**Files (all net-new — copy the whole directory from the fork tree):**
```
src/channels/telegram-grammy/   (ask-question, attachments, errors, formatter,
  inbound, index, layers, media-meta, outbound, pairing-interceptor, reactions,
  runtime, services, supervise — plus their .test.ts)
src/channels/telegram.ts            (legacy adapter, kept commented-out as fallback)
src/channels/telegram-render.ts     (used only by the legacy path)
src/channels/telegram-pairing.ts + .test.ts
src/transcription.ts                (OpenAI Whisper wrapper; used by both paths)
```

**Registration:** in `src/channels/index.ts`, exactly one Telegram import is
active. Append (legacy commented, grammy active):
```typescript
// Telegram — two impls, one channel_type ('telegram'). Keep exactly one active.
// import './telegram.js';            // legacy Chat-SDK bridge (fallback)
import './telegram-grammy/index.js';  // grammY + Effect-TS v4 — ACTIVE
```

**npm deps (exact pins — see §C1 for how to add):** `grammy@1.42.0`,
`@grammyjs/auto-retry@2.0.2`, `@grammyjs/files@1.2.0`, `@grammyjs/parse-mode@2.3.0`,
`effect@4.0.0-beta.52` (pin exactly — v4 beta APIs), `mediabunny@1.40.1`,
`openai@^6.34.0`, `chat@^4.24.0` (mdast helpers used by formatter), plus
`markdown-it@^14.1.1` + `@types/markdown-it@^14.1.2` (vendor pipeline, §A2).

**Conflict:** none — upstream has none of these files.

## A2. [COPY] Vendored openclaw-markdown pipeline

**Intent:** `src/vendor/openclaw-markdown/` is a pinned vendor (commit
`fb7bfb41…`, 2026-04-21) of openclaw's markdown→Telegram-HTML pipeline, consumed
by `telegram-render.ts` (the **legacy** path's renderer). Four deliberate
deviations (search `DEVIATION` in the files): `*x*`→bold/`_x_`→italic;
`**x**`→bold/`__x__`→underline; headings→bold; tables drop outer `|` delimiters.

**Files:** copy the whole `src/vendor/openclaw-markdown/` directory wholesale.

**Conflict:** none — net-new.

## A3. [MERGE] chat-sdk-bridge.ts — approval-text sanitization

**Intent:** Apply `transformText()` to ask-question title/question so an approval
question containing `GH_TOKEN` etc. doesn't crash Telegram's legacy Markdown
parser; plus a DM-sender log type-safety tidy. Protects the legacy bridge path
(`cli.ts` and legacy telegram).

**Conflict — HIGH.** Upstream substantially rewrote `chat-sdk-bridge.ts` (added
`instance` field, `send_card`/`LinkButton`, index-based button encoding, group
flag, backoff). Start from upstream's version; in the new `ask_question` delivery
branch, wrap the title/question through `transformText()` before send:
```typescript
const title = transformText(rawTitle);
const question = transformText(rawQuestion || '');
```
Lower urgency if only the grammy adapter is used in production (its `outbound.ts`
is entities-based and parser-immune). Also re-apply the one-line `cli.ts` log tidy
(`{ line, err }`) — upstream did not touch `cli.ts`, so that one is clean.

---

# B. Core host source

## B1. [MERGE] container-runner.ts — GH token injection + heartbeat clear

**Intent (two changes):**
1. **GH token:** read the host's `gh auth token` at spawn and inject `GH_TOKEN`
   into the container so in-container `gh` works. Probe brew/linuxbrew/`~/.local/bin`
   because the systemd/launchd PATH is minimal.
2. **Heartbeat clear:** `fs.rmSync(heartbeatPath(...), { force: true })` immediately
   before `spawn(...)`, so a stale heartbeat from a crashed container doesn't trip
   the sweep's SLA kill before the new container touches the file.

**How to apply:** add `import os from 'os'`; add `GH_PATH_EXTRAS` + `getHostGhToken()`
helper; in `buildContainerArgs`, after the `providerContribution.env` injection loop,
push `-e GH_TOKEN=<token>` when a token is found; in `spawnContainer`, `rmSync` the
heartbeat path just before the `spawn(...)` call. (Verbatim blocks in the extraction
report — both are additive.)

**Conflict — HIGH.** Upstream heavily refactored `buildContainerArgs`/`spawnContainer`
(provider resolution moved, `materializeContainerJson` replaces `readContainerConfig`,
egress lockdown). Insert both blocks in the new structure; the logic is additive.

## B2. [MERGE] typing/index.ts — gate on processing_ack, not heartbeat

**Intent:** Heartbeat goes stale during long pure-thinking gaps (`effortLevel:
xhigh`), causing typing to stop while the agent is alive. Replace the heartbeat
freshness gate with a `processing_ack` DB check (`getProcessingClaims(outDb).length
> 0`), cache the `outbound.db` handle per target, add a `TYPING_TTL_MS` (10 min)
ceiling, close the handle on stop.

**Conflict — HIGH.** Upstream's change to this file is *additive* (`instance?`
param propagation, heartbeat gate kept). Merge both: take upstream's version,
then **remove** `HEARTBEAT_FRESH_MS`/`isHeartbeatFresh()`, swap imports to
`openOutboundDb`/`getProcessingClaims`/`isContainerRunning`, add the `outDb` field
+ `hasInflightWork(entry, sessionId)` helper, add the TTL ceiling, close `outDb`
in `stopTypingRefresh`. Drop the fork's `TYPING_DEBUG` logs (debug artifacts).

## B3. [MERGE] group-init.ts — pin auto-memory dir + enable auto-dream

**Intent:** In `DEFAULT_SETTINGS_JSON` (written to each group's
`.claude-shared/settings.json` at scaffold), replace
`CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0'` with the typed SDK fields
`autoMemoryEnabled: true`, `autoMemoryDirectory: '~/.claude/memory'`,
`autoDreamEnabled: true`.

**Conflict — HIGH.** Upstream rewrote `group-init.ts` (provider surface, neutral
seeds, `ensureContainerConfig`, PreCompact hook). Take upstream's file, then in
`DEFAULT_SETTINGS_JSON` drop the env var and add the three SDK fields — keeping
upstream's `env`/hooks structure intact. Confirm the upstream SDK version
supports these fields before relying on them. Existing groups: unaffected
(their settings.json lives under `data/`, untouched). Only new groups need this.

## B4. [MERGE] setup/register.ts — auto-member grant on DM wiring

**Intent:** After wiring a 1:1 DM, call `addMember()` to insert the paired user
into `agent_group_members`, else messages drop with `accessReason="not_member"`.
(The schema-drift fix bundled in the same fork commit is **[SUBSUMED]** — upstream
made the identical `engage_mode`/`engage_pattern`/`sender_scope`/
`ignored_message_policy` fix independently.)

**Conflict — HIGH (but small surface).** Take upstream's `register.ts`; add
`import { addMember } from '../src/modules/permissions/db/agent-group-members.js'`
and, after `createMessagingGroupAgent`, the `if (messagingGroup.is_group === 0) {
addMember({...}) }` block. Use upstream's engage logic and `ensureContainerConfig`.

## B5. [COPY] group-folder.ts — resolveGroupFolderForPlatformId helper

**Intent:** Resolve a group's on-disk folder from a platform id via the
messaging_group→agent_group wiring; used by the grammy adapter to stream large
attachments. **Conflict: none** — upstream did not touch this file. Add the two
DB imports + the exported helper (verbatim in the extraction report).

## B6. [SUBSUMED] — apply nothing, use upstream as-is

- `host-sweep.ts` + `db/session-db.ts` — upstream independently shipped the
  wake-before-reset reorder and the `getMessageForRetry` field; its version is a
  superset (`justWoke`, `parseSqliteUtc`). Use upstream.
- `config.ts` — fork change was a prettier reformat already matching upstream.
- `session-manager.ts` — fork only removed the unused `findSession` import;
  upstream did the same.
- `modules/permissions/sender-approval.ts` — **do NOT replay** the fork's removal
  of `normalizeOptions`; upstream now uses it. Take upstream's version.

---

# C. Container agent-runner (Bun)

## C1. [DECISION + MERGE] claude-agent-sdk version

**Fork:** `@anthropic-ai/claude-agent-sdk@^0.2.123`. **Upstream:** `^0.3.170`.
The `translateSdkMessages` rewrite (§C2) was written against the 0.2.x message
shape (`SDKAssistantMessage`/`SDKResultMessage`). **Decision needed:** default to
**taking upstream's 0.3.170** and adapting `translateSdkMessages` to any shape
changes, validated by `claude.test.ts`. Do not blind-bump. (Surfaced to the
operator at validation time.)

## C2. [MERGE] claude.ts — emit AssistantMessage text every turn

**Intent:** Original translator only forwarded `result` events, so replies that
arrive as an `AssistantMessage` (text + tool_use) followed by an empty
`ResultMessage` were lost. The `translateSdkMessages()` exported generator
classifies AM events (text→result, text+tool_use→progress), skips subagent
narration, de-dupes `ResultMessage.result` vs last AM text, and surfaces terminal
errors (max-turns/budget/refusal/rate-limit) as user-visible `error` events with a
`classification`. New tests: `claude.test.ts`, fixture `__fixtures__/failing-turn.json`.

**Conflict — HIGH.** Upstream still has the old inline `translateEvents()`. Replace
it wholesale with `translateSdkMessages` + helpers (`extractAssistantText`,
`classifyResult`, `RESULT_ERROR_MESSAGES`); copy the two new test files. Reconcile
against the 0.3.x SDK types (§C1).

## C3. [MERGE] claude.ts — stop forcing 165k auto-compact window

**Intent:** Don't hardcode `CLAUDE_CODE_AUTO_COMPACT_WINDOW='165000'`; let the
per-agent `settings.json`/model ceiling win. **Conflict — MEDIUM:** upstream uses
`process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000'`. To keep fork behavior,
drop the `|| '165000'` fallback (or omit the env injection). Don't silently accept
upstream's hardcoded fallback.

## C4. [MERGE] poll-loop.ts — progress dispatch, error surfacing, /clear

**Intent:** Surface intermediate `progress` narration to the user
(`dispatchResultText`), surface non-retryable terminal `error` events as chat
messages, and route `/clear`/slash commands through the warm poller.

**Conflict — HIGH.** Upstream refactored poll-loop heavily (655 vs 464 lines, new
`processQuery` signature, already uses `formatMessagesWithCommands` +
`isRunnerCommand()` + `query.abort()`). Apply only the **targeted** intents:
(a) dispatch `progress` events in `handleEvent`; (b) write non-retryable `error`
events to `messages_out`. **Skip the /clear piece** — upstream's `isRunnerCommand()`
+ `query.abort()` already covers it. Do not copy the fork's function body wholesale.

## C5. [COPY-patch] formatter.ts — attachment error + transcript fields

**Intent:** Render `attachment.error` (e.g. >20 MB cap) and `attachment.transcript`
in the XML prompt. **Conflict — LOW:** upstream's `formatAttachments` is unchanged
from base; apply the additive patch + 3 new test cases (verbatim in the report).

## C6. [COPY-patch] mcp-tools/core.ts — send_media_group + add_reaction docs

**Intent:** New `send_media_group` MCP tool (2–10 files as a Telegram album, staged
in `/workspace/outbox/<id>/`, `operation: 'send_media_group'`); richer `add_reaction`
emoji description. **Conflict — LOW:** add the `sendMediaGroup` export, update the
`emoji` description, and register it: `registerTools([sendMessage, sendFile,
sendMediaGroup, editMessage, addReaction])`.

---

# D. Container image + skills

## D1. [MERGE] Dockerfile — git-lfs + openssh-client

Add `git-lfs` and `openssh-client` to the base apt block (after `git`, before
`tini`). **Conflict — HIGH** (Dockerfile restructured around `cli-tools.json`);
apply as a targeted apt-block edit only — don't touch the CLI-install mechanism.

## D2. [MERGE] Dockerfile — media stack

Add the media stack RUN blocks (ffmpeg, atomicparsley, python3-pip;
pip `yt-dlp yt-dlp-ejs instaloader mutagen pycryptodomex brotli websockets requests
certifi curl_cffi secretstorage xattr`; Deno via install.sh; GitHub CLI apt repo +
`ENV GH_TOKEN=placeholder`). Insert after the base apt block. Verbatim in the
extraction report. **Conflict:** none semantically (net-new blocks), but place them
carefully in the restructured upstream Dockerfile.

## D5. [COPY] media-download container skill

`container/skills/media-download/SKILL.md` — net-new, copy verbatim. yt-dlp +
instaloader playbook (Instagram reels/carousels), send via `send_file`/`send_media_group`.

## D6. [MERGE] container/CLAUDE.md — platform-layer agent guidance

**Intent:** Fork's `container/CLAUDE.md` (208 lines) is a platform-layer doc:
removes the persona (persona lives in `CLAUDE.local.md`), adds the **surf MCP
routing table**, "cite sources with clickable links", "don't speculate, look it up",
and a yt-dlp/Instagram **Video Downloads** playbook.

**Conflict — HIGH.** Upstream rewrote its `container/CLAUDE.md` (21 lines, minimal
identity + memory/conversation-history guidance). **Use the fork's version as the
base**, then graft in upstream's new memory/conversation-history lines. Preserve the
fork's surf table, citation/anti-speculation sections, and Video Downloads section.
(This is agent content, not code — runtime cpSync picks it up; no rebuild needed.)

---

# E. Config / build / behavior

## E1. [MERGE] package.json + lockfiles

Take upstream's `package.json` (it bumps `@onecli-sh/sdk`→`2.2.1`, adds `@clack/core`,
`bin.ncl`, version bump). **Layer on** the fork deps from §A1 — but do **not**
re-add `@chat-adapter/telegram` (upstream already dropped it). Then regenerate
`pnpm-lock.yaml` (root) and `container/agent-runner/bun.lock` (`bun install`).
Honor the supply-chain policy (`minimumReleaseAge`, `--frozen-lockfile` in CI/container).

## E2. [COPY] tsconfig.json — ES2023

`target: ES2023`, `lib: ["ES2023"]` (needed by the Effect v4 island). Upstream
unchanged — apply directly.

## E3. [COPY] eslint.config.js — disable no-catch-all + grammy island rules

Set `no-catch-all/no-catch-all` → `'off'`; append the
`src/channels/telegram-grammy/**/*.ts` block enabling type-aware
`no-floating-promises`/`no-misused-promises` (`projectService: true`). Upstream
unchanged — apply directly.

## E4. [MERGE] root CLAUDE.md

Take upstream's (it adds the migration banner + Admin CLI `ncl` section), then
graft the fork's additions: "Gating UX on container state" paragraph,
"Per-agent group file layout" section, "Per-agent Claude config via settings.json"
section, the `pnpm lint` paragraph. Use upstream's Key Files rows where both edited.

## E5. [COPY] setup/index.ts + setup/pair-telegram.ts

`pair-telegram.ts` — net-new, copy verbatim. `setup/index.ts` — verify the
`'pair-telegram'` STEP entry is present (upstream added it too); add only if missing.

## E6. [MERGE] .gitignore — untrack scheduled_tasks.lock

Append `.claude/scheduled_tasks.lock`; if still tracked, `git rm --cached
.claude/scheduled_tasks.lock`. Upstream rewrote the `groups/` section — different
area, append cleanly.

---

# Deferred / follow-up (carried from prior guide)

- **Dropped upstream skills (optional):** the fork previously deleted opinion-heavy
  skills it doesn't use (`add-emacs`, `add-ollama-tool`, `channel-formatting`).
  Optional cleanup — re-delete after upgrade if desired; not load-bearing.
- **`/compact`:** admin `/compact` is forwarded to the agent as an instruction
  (works); the SDK-level `compact_boundary` + PreCompact transcript archive was not
  re-ported. Note: upstream §B3/group-init now ships a PreCompact hook — re-evaluate
  whether the fork still needs anything here.
- **Existing-group Surf allowlist:** new groups get `mcp__surf__*` via
  `DEFAULT_SETTINGS_JSON`; existing groups' `data/.../settings.json` already have it
  (survives upgrade). No action.

---

# Validation

```bash
# Host (Node + pnpm)
pnpm install && pnpm run build && pnpm test
# Container (Bun)
cd container/agent-runner && bun install && bun test && bun run typecheck
# Lint
pnpm lint
```

Then the three breaking changes (§E1 OneCLI /v1 gateway, the `data/upgrade-state.json`
marker, and the per-install slugged service name) before restarting the service.
