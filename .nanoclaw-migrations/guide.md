# NanoClaw Fork Migration Guide — v2

**Generated:** 2026-04-17
**Base:** `upstream/v2` @ `bd659fd`
**Fork tip at generation:** `dbd45ed` (pre-migration main) → `d0e7563` (v2-port)

This guide captures every fork-specific customization re-applied on top of
upstream v2. Use it to **replay the customizations on the next upstream pull**
instead of re-deriving them: merge upstream, then re-apply each section below.

The migration was performed by the `/migrate-nanoclaw` skill and produced four
commits on the `v2-port` branch. Each commit is self-contained and can be
cherry-picked independently if you're only pulling a subset.

---

## Commit log

```
d0e7563 chore(migrate): stage 4 - drop upstream skills we're not using
2171ba9 feat(migrate): stage 3 - Dockerfile media stack + media-download container skill
e9fce62 feat(migrate): stage 2 - Telegram port with feature wrapper + Surf MCP + ONECLI_API_KEY
2322f0b chore(migrate): stage 1 - port group CLAUDE.md and opt out of diagnostics
```

---

## Stage 1 — Group CLAUDE.md + diagnostics opt-out

**Why:** the fork runs a "John" persona (thinking-partner-for-Misha) with
specific writing-style rules (no emdashes), and opts out of the setup/update
diagnostics report.

**Files:**
- `groups/main/CLAUDE.md` — full John persona; keep the first line
  `@./.claude-global.md` (v2 include directive).
- `groups/global/CLAUDE.md` — simpler shared baseline (send_file, send_media_group).
- `.claude/skills/setup/SKILL.md` — delete the "Diagnostics" step; renumber
  subsequent sections.
- `.claude/skills/update-nanoclaw/SKILL.md` — delete the trailing "Diagnostics"
  step.
- `.claude/skills/setup/diagnostics.md` and
  `.claude/skills/update-nanoclaw/diagnostics.md` — replace contents with a
  single line: `# Diagnostics — opted out`.

**Reapply on next upstream pull:** content files (`groups/*/CLAUDE.md`) rarely
conflict. If upstream edits the diagnostics flow, re-strip the steps from the
SKILL.md files and stub the diagnostics.md files again.

## Stage 2 — Telegram port + Surf MCP + ONECLI_API_KEY

### Telegram adapter architecture

v2 uses `@chat-adapter/telegram` (Chat SDK bridge). The fork wants:
- 👀 reaction on seen (acknowledge message before Whisper/long agent work).
- Voice transcription via OpenAI Whisper (so the agent sees `[voice: …] transcript: "…"` inline).
- Attachments materialized to `groups/<folder>/attachments/<safe-name>` with
  container path `/workspace/agent/attachments/<name>` injected as `att.localPath`.
- `send_media_group` MCP tool (2–10 files as gallery/album).
- Single-file `.mp4/.mov/.mkv/.webm` sends via Telegram `sendVideo` with
  `supports_streaming: true` (inline playable video).
- Forum topic / `message_thread_id` support.
- Reply context passed through as `<reply-to>` in the prompt.

**Approach:** install v2's Telegram base (pairing + markdown sanitization +
bridge), then wrap the adapter. No full rewrite.

1. Copy from `upstream/channels`:
   - `src/channels/telegram.ts` — base (copied, then extended — see below)
   - `src/channels/telegram-pairing.ts` + `.test.ts`
   - `src/channels/telegram-markdown-sanitize.ts` + `.test.ts`
   - `setup/pair-telegram.ts`

2. Extend `src/channels/telegram.ts`:
   - Add a **feature interceptor** layered after `createPairingInterceptor`:
     - Fires `setMessageReaction` (`👀`) via raw HTTPS `fetch`.
     - Walks `content.attachments[]`; for each base64 `data`, writes the buffer
       to `resolveGroupFolderPath(folder)/attachments/<safe>` where `folder`
       is found via `getMessagingGroupByPlatform('telegram', platformId)` →
       primary `messaging_group_agents` row → `getAgentGroup()`.
     - Sets `att.localPath = "agent/attachments/<name>"`; deletes `att.data`.
     - For `voice`/`audio` or `.ogg/.m4a/.mp3/.wav/.webm`, runs
       `transcribeAudio(hostPath)` and sets `att.transcript`.
   - Wrap the bridge's `deliver()`:
     - `content.operation === 'send_media_group'` → POST `sendMediaGroup` with
       `InputMedia{Photo,Video,Document}` + `attach://` refs (raw `fetch` +
       FormData). Preserves `message_thread_id` when threadId parses to a number.
     - Single-file video (`.mp4/.mov/.mkv/.webm`, `files.length === 1`) → POST
       `sendVideo` with `supports_streaming: true`.
     - Otherwise → `bridge.deliver(...)` unchanged.
   - All side-channel calls use raw `fetch('https://api.telegram.org/bot<token>/…')`
     so we **don't** take a second dep on `grammy`.

3. Register the adapter: append `import './telegram.js';` to
   `src/channels/index.ts`.

4. Wire the pairing setup step: append `'pair-telegram': () => import('./pair-telegram.js')`
   to the `STEPS` map in `setup/index.ts`.

5. New helper: `src/transcription.ts` — OpenAI Whisper client, reads
   `OPENAI_API_KEY`, logs via `src/log.ts` (not the fork's pino `logger`).

6. Deps: `pnpm add @chat-adapter/telegram@^4.24.0 openai` (resolves to 4.26.0 and 6.x).

**Container side:**
- `container/agent-runner/src/mcp-tools/core.ts` gets a new `sendMediaGroup`
  tool (exported, added to `coreTools`). Contract: `{ to?, items: [{path, caption?}] }`
  (2–10), copies files to `/workspace/outbox/<id>/` and writes a
  `messages_out` row with `content = { operation: 'send_media_group', items, files }`.
- `container/agent-runner/src/formatter.ts::formatAttachments` — renders
  ` transcript: "…"` suffix when `att.transcript` is present. Everything else
  was already in place (v2 formatter supports `localPath`).

### Surf MCP

- `container/agent-runner/src/index.ts` — when `ENABLE_SURF_MCP === 'true'`
  is set, register `mcpServers.surf = { command: 'npx', args: ['x402-proxy',
  'mcp', 'https://surf.cascade.fyi/mcp'], env: {} }`.
- `src/container-runner.ts`:
  - Mount `~/.config/x402-proxy` → `/home/node/.config/x402-proxy` (rw) when
    the host dir exists.
  - Pass `-e ENABLE_SURF_MCP=true` when the host dir exists.
- `src/group-init.ts` — `DEFAULT_SETTINGS_JSON` adds
  `permissions: { allow: ['mcp__surf__*'] }`. Existing groups need their
  `data/v2-sessions/<id>/.claude-shared/settings.json` updated manually (or
  write a one-shot sweep script).

### ONECLI_API_KEY

- `src/config.ts` — add `ONECLI_API_KEY` to `readEnvFile` and export it.
- `src/container-runner.ts` — `new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY })`.

**Reapply on next upstream pull:** most conflicts will be in
`src/channels/telegram.ts`. Strategy:
1. Copy upstream's `src/channels/telegram.ts` verbatim.
2. Re-apply the feature-interceptor (`createFeatureInterceptor`,
   `materializeAttachment`, reaction + video helpers) and the `deliver()`
   wrapper from the committed version under `v2-port`.
3. If `@chat-adapter/telegram` minor-bumps, pin the new version; if it
   major-bumps, verify raw API shapes (sendMediaGroup, sendVideo) still match
   Telegram Bot API (6.x+).

## Stage 3 — Dockerfile media stack + x402-proxy

Container tools added:
- **apt:** `ffmpeg`, `atomicparsley`, `python3-pip` (yt-dlp prereqs). `unzip` was already present.
- **pip (via `--break-system-packages --no-cache-dir`):** `yt-dlp yt-dlp-ejs
  instaloader mutagen pycryptodomex brotli websockets requests certifi
  curl_cffi secretstorage xattr`.
- **deno:** official installer to `/usr/local`, needed for yt-dlp's modern
  YouTube signature extractors.
- **x402-proxy:** installed via `npm install -g "x402-proxy@${X402_PROXY_VERSION}"`.
  Uses npm (not pnpm) to bypass the host's `minimumReleaseAge` supply-chain
  policy, since the install happens inside the image build, not against the
  host workspace. New `ARG X402_PROXY_VERSION=latest`.

Container skill added:
- `container/skills/media-download/SKILL.md` — documents the yt-dlp/instaloader
  workflow for agents.

**Reapply on next upstream pull:** if upstream restructures the Dockerfile,
re-insert the media `RUN` block after the base apt layer and keep deno as its
own layer. Put the `x402-proxy` line next to the pnpm global-install block.

## Stage 4 — drop unused upstream skills

Deleted directories (instruction-only skills, no runtime impact):
- `.claude/skills/add-emacs` — not porting Emacs channel.
- `.claude/skills/add-ollama-tool` — not using Ollama MCP.
- `.claude/skills/channel-formatting` — fork bakes per-channel formatting
  rules directly into `groups/main/CLAUDE.md` + `groups/global/CLAUDE.md`.

If upstream adds more opinion-heavy skills the user doesn't want, delete them
here too and update this list.

---

## Deferred / follow-up

### `/compact` skill

The fork had the `/compact` skill applied on v1. The v2 agent-runner already
recognizes `/compact` as an admin command in
`container/agent-runner/src/formatter.ts::ADMIN_COMMANDS`, and `poll-loop.ts`
passes admin commands through to the Claude SDK as messages. The
full SDK-passthrough implementation (emitting a `compact_boundary` event and
archiving the transcript via the `PreCompact` hook) was **not** re-ported on
v2 — `upstream/skill/compact` conflicts with v2's rewritten
`container/agent-runner/src/index.ts` and host `src/index.ts`.

**What currently works:** `/compact` from an admin user is forwarded to the
agent as a normal instruction; the agent can choose to summarize and discard
history manually.

**What's missing vs. the fork:** no SDK-level compaction boundary, no
automatic transcript archive-before-compaction via a `PreCompact` hook.

**To re-port after upstream stabilizes:** inspect `upstream/skill/compact`,
port the hook into `container/agent-runner/src/poll-loop.ts` where admin
commands are handled, verify via the add-compact SKILL.md's verification
checklist.

### Existing-group Surf allowlist sweep

Groups initialized before this migration don't have `mcp__surf__*` in their
`data/v2-sessions/<id>/.claude-shared/settings.json`. New groups will pick it
up via `DEFAULT_SETTINGS_JSON` in `src/group-init.ts`. For existing groups,
append `mcp__surf__*` to each settings.json manually or write a one-shot
sweep.

---

## Validation

Run in the worktree (or repo root post-swap) to confirm a clean state:

```bash
pnpm install
pnpm run build
pnpm test                 # host (vitest)
cd container/agent-runner
bun install
bun test                  # container (bun:test)
bun run typecheck
cd ../..
./container/build.sh      # refresh image
```

Container binary sanity check:
```bash
docker run --rm --entrypoint sh nanoclaw-agent:latest -c \
  'yt-dlp --version; instaloader --version; deno --version; \
   ffmpeg -version | head -1; which x402-proxy'
```

End-to-end (post-swap, via `/debug` skill):
1. Service starts, Telegram polling connects, pairing unchanged.
2. Voice message → 👀 reaction within ~1s; agent prompt shows
   `[voice: … — saved to /workspace/agent/attachments/…] transcript: "…"`.
3. Reply to an agent message → agent prompt shows `<reply-to sender="…">`.
4. `send_file(path='x.mp4')` → Telegram renders inline playable video.
5. `send_media_group(items=[…3 photos…])` → Telegram renders as gallery.
6. Forum topic → agent receives + replies in the same topic.
7. Agent MCP tool list includes `mcp__surf__*` and a Surf call returns a
   Twitter search result.
8. `ONECLI_API_KEY` from `.env` flows into container; credential-proxy works.

Rollback: `git reset --hard backup/pre-migrate-*` (tag and branch created at
start of migration).
