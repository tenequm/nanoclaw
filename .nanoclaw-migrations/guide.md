# NanoClaw Fork Migration Guide — v2

**Generated:** 2026-04-17
**Updated:** 2026-04-22 — appended Stage 5 + Stage 6 (upstream v2.0.0 impact).
**Base:** `upstream/v2` @ `bd659fd` (merge-base, unchanged)
**Fork tip at update:** `43d3248` (was `d0e7563` at original generation)
**Upstream tip at update:** `3db66c0` (144 commits ahead of base — NanoClaw v2.0.0 release)

This guide captures every fork-specific customization re-applied on top of
upstream v2. Use it to **replay the customizations on the next upstream pull**
instead of re-deriving them: merge upstream, then re-apply each section below.

---

## Commit log

Stages 1–4 were produced by the original 2026-04-17 migration:

```
d0e7563 chore(migrate): stage 4 - drop upstream skills we're not using
2171ba9 feat(migrate): stage 3 - Dockerfile media stack + media-download container skill
e9fce62 feat(migrate): stage 2 - Telegram port with feature wrapper + Surf MCP + ONECLI_API_KEY
2322f0b chore(migrate): stage 1 - port group CLAUDE.md and opt out of diagnostics
```

Stage 5 (added 2026-04-22) bundles all customizations committed on the v2-port
branch between `d0e7563` and `43d3248`. Stage 6 lists corrections to Stages 2–4
forced by upstream v2.0.0's architectural shifts.

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

**Note (2026-04-22):** the original Stage 3 also shipped `x402-proxy` baked
into the image. Stage 5.4 supersedes that — Surf is now declared per-group
via `container.json → mcpServers` with HTTP transport, so x402-proxy no
longer needs to be in the image at all. Do not re-install it.

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

---

# Stage 5 — Customizations added 2026-04-17 → 2026-04-22

23 commits landed on `v2-port` after the original guide. Three categories:

| Category | Commits | Action |
|---|---|---|
| **Telegram HTML pipeline** (big) | aac10f9, 39a72a8, 41b04f4, 8d91153, a0e6a49, 85c25f6, 41f9ea5, 43d3248, 802b7f8, 0bd3c9c, c75b9c2, 4465a47 | Re-apply — replaces Stage 2 MarkdownV2 path |
| **Infra + behavior fixes** | 2c69d02, 2889651, a3f8724, e45374b, a2bddf8, 3331f5f, 5a9b76e | Re-apply (several are now redundant — see notes) |
| **Already-upstream** | 820d1ba, 57fe257 | **Skip — upstream v2 picked up equivalent commits** (`e93292d`, `27c5220`). Upstream wins when we reset to `upstream/v2`. |

## Stage 5.1 — Telegram HTML delivery pipeline

**Why:** The Chat SDK bridge's MarkdownV2 path has inherent ambiguity in
delimiter parsing (`*` and `_` both map to italic in strict CommonMark but
Telegram MarkdownV2 and LLM output both use `*bold` + `_italic` + `__underline`).
Telegram's native HTML `parse_mode` is unambiguous and allows finer control over
spacing, expandable blockquotes, and per-table width heuristics. This replaces
Stage 2's text delivery wholesale.

### 5.1.1 — Vendor the openclaw markdown → HTML pipeline

Copy the entire directory wholesale from `openclaw/openclaw@fb7bfb41`:

**New files (14):** `src/vendor/openclaw-markdown/`
- `ir.ts` — markdown tokenization + IR walk (DEVIATIONS: `*x*` → bold, `__x__` → underline, headings → bold)
- `render.ts` — IR → HTML tags
- `format.ts` — IR + chunker → HTML strings (per-table mode knob via `renderTableAsCode`)
- `render-aware-chunking.ts` — split HTML at block boundaries without cutting inline tags
- `fences.ts`, `code-spans.ts`, `tables.ts` — parse helpers
- `chunk.ts`, `text-chunking.ts` — text split helpers
- `auto-linked-file-ref.ts`, `string-coerce.ts` — utilities
- `types.ts` — `MarkdownTableMode` enum
- `LICENSE` (MIT), `README.md` (documents deviations + bump procedure)

**Dependency changes:**
- `package.json`: add `markdown-it@^14.1.1` (prod), `@types/markdown-it@^14.1.2` (dev)
- `tsconfig.json`: bump `target` + `lib` from ES2022 → ES2023 (`Array.toSorted()`, `Array.toReversed()` resolution)

**Telegram dialect deviations** (for future renderer bumps — grep `DEVIATION`):
- `*x*` → `<b>`, `_x_` → `<i>` (matches LLM + Telegram MarkdownV2, not strict CommonMark)
- `__x__` → underline (not double-bold)
- Headings → `<b>…</b>` (Telegram HTML has no `<h1>`)
- `renderTableAsCode` drops outer `|` delimiters (saves 4 chars/line, pushes mobile wrap threshold)

### 5.1.2 — Create `src/channels/telegram-render.ts`

New file. Orchestrates the vendored pipeline with:

1. **Segment-split + per-table width mode.** Scan markdown to find GFM pipe-tables, compute each table's rendered ASCII width (with outer-pipe fix applied), split source at table boundaries. Render:
   - Prose fragments → `tableMode: 'off'`
   - Narrow tables (≤ `TABLE_WIDTH_LIMIT` chars) → `tableMode: 'code'` (`<pre><code>` ASCII grid)
   - Wide tables (> limit) → `tableMode: 'bullets'` (openclaw's nested bullets)

2. **Width constant:** `export const TABLE_WIDTH_LIMIT = 38;` — empirically tuned for iPhone 14+ (lowered from 48 in `43d3248`). Lower to 37 for iPhone SE; retest with CJK fonts.

3. **Long blockquote expander:** post-processor that adds the `expandable` attribute to `<blockquote>` > ~300 chars of text.

4. **Safe chunking:** run combined HTML through `splitTelegramHtmlChunks` (from vendored renderer) which breaks at Telegram's 3800-char safe limit without cutting inline tags.

**Public export:**
```ts
export function renderTelegramHtmlChunks(markdown: string, safeLimit: number): string[];
```

### 5.1.3 — Wire HTML delivery into `src/channels/telegram.ts`

1. Add import:
   ```ts
   import { renderTelegramHtmlChunks } from './telegram-render.js';
   ```

2. Add constant and helper (uses raw `fetch` to avoid a `grammy` dep):
   ```ts
   const TELEGRAM_SAFE_LIMIT = 3800;

   async function sendMessageTextRaw(
     token: string,
     chatId: string,
     html: string,
     messageThreadId?: number,
   ): Promise<string | undefined> {
     const body: Record<string, unknown> = {
       chat_id: chatId,
       text: html,
       parse_mode: 'HTML',
       link_preview_options: { is_disabled: true },
     };
     if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
     const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify(body),
     });
     if (!res.ok) {
       const errText = await res.text().catch(() => '');
       throw new Error(`sendMessage failed: ${res.status} ${errText}`);
     }
     const json = (await res.json()) as { ok: boolean; result?: { message_id?: number } };
     return json.result?.message_id != null ? String(json.result.message_id) : undefined;
   }
   ```

3. In the wrapped `deliver()`, replace the text-only delivery path. After `send_media_group` and single-file-video short-circuits, **before** falling through to `bridge.deliver()`, insert:
   ```ts
   const rawText =
     typeof content.markdown === 'string' ? (content.markdown as string)
     : typeof content.text === 'string' ? (content.text as string)
     : '';
   const hasFiles = !!(message.files && message.files.length > 0);
   if (rawText && !hasFiles) {
     const chunks = renderTelegramHtmlChunks(rawText, TELEGRAM_SAFE_LIMIT);
     const chatId = chatIdFromPlatformId(platformId);
     const topicId = parseThreadId(threadId);
     let lastId: string | undefined;
     for (const html of chunks) {
       lastId = await sendMessageTextRaw(token, chatId, html, topicId);
     }
     clearPendingSeen(telegramAdapter, pendingSeen, reactionKey);
     return lastId;
   }
   ```

4. **Remove** the legacy markdown sanitizer (done in `8d91153`):
   - Delete `src/channels/telegram-markdown-sanitize.ts`
   - Delete `src/channels/telegram-markdown-sanitize.test.ts`
   - Remove its import from `telegram.ts`
   - Remove the `transformOutboundText: sanitizeTelegramLegacyMarkdown` option from the `createChatSdkBridge(…)` call

### 5.1.4 — 👀 seen-reaction add + clear (`4465a47`)

**Bug:** Stage 2's raw-fetch `setTelegramReaction` passed a compound message ID (`"chatId:messageId"`) to `Number()`, producing NaN → null in JSON → Telegram rejected the call.

**Fix:** Use the adapter's own `addReaction()` / `removeReaction()` (they decode the compound ID correctly). Track successful adds in a Map keyed by `chatId:messageId` and drain after each outbound delivery.

- Replace the raw `setTelegramReaction` helper with `createFeatureInterceptor(adapter, pendingSeen)` and `clearPendingSeen(adapter, pendingSeen, reactionKey)` helpers.
- Create `pendingSeen: Map<string, Set<string>>` at adapter-factory scope.
- Pass it to the feature interceptor **and** into the `deliver()` wrapper.
- Call `clearPendingSeen(...)` at the end of every deliver branch (text-HTML, sendMediaGroup, sendVideo, fallthrough).

**Commit `802b7f8` (prettier reformat of a nested ternary) is purely cosmetic — skip.**

## Stage 5.2 — gh CLI with host-sourced auth (`2c69d02` + `2889651` + `a3f8724`)

**Why:** Agent containers are ephemeral, so `~/.config/gh/` can't persist. The host's `gh auth token` is shelled out at spawn time and injected into the container as `GH_TOKEN`.

**Files:**
- `container/Dockerfile` — install `gh` via the official apt repo; set `ENV GH_TOKEN=placeholder` so `gh`'s local auth check passes even if the host isn't logged in.
- `src/container-runner.ts` — `getHostGhToken()` helper + injection at spawn.
- `groups/global/CLAUDE.md` — Mark persona + updated comms section (not covered here — see Stage 6 for CLAUDE.md composition impact).

**Dockerfile additions (between the Deno install and `AGENT_BROWSER_EXECUTABLE_PATH`):**
```dockerfile
# ---- GitHub CLI (gh) ---------------------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

ENV GH_TOKEN=placeholder
```

**`src/container-runner.ts` helper + spawn injection:**
```ts
// Known Homebrew / linuxbrew / user-local install dirs — systemd service PATH
// is minimal and .bashrc isn't sourced by login shells, so prepend them.
const GH_PATH_EXTRAS = [
  '/home/linuxbrew/.linuxbrew/bin',
  '/opt/homebrew/bin',
  `${os.homedir()}/.local/bin`,
];

function getHostGhToken(): string | null {
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: `${GH_PATH_EXTRAS.join(':')}:${process.env.PATH ?? ''}` },
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}
```

In `buildContainerArgs(...)`, after the `NANOCLAW_AGENT_GROUP_*` env block:
```ts
const ghToken = getHostGhToken();
if (ghToken) {
  args.push('-e', `GH_TOKEN=${ghToken}`);
}
```

Imports to add at the top: `import { execSync } from 'child_process';` and `import os from 'os';` if not already present.

**Note:** The three commits `2c69d02` + `2889651` + `a3f8724` are an iterative evolution of the same helper. Apply the **final form above** (from `a3f8724`) — skip the intermediate `bash -lc '…'` version.

## Stage 5.3 — Approvals markdown sanitization (`e45374b`)

**Why:** The `ask_question` Card path bypassed `transformOutboundText`, so approval questions containing odd numbers of `_` or `*` (e.g. "GH_TOKEN") crashed Telegram's legacy Markdown parser.

**File:** `src/channels/chat-sdk-bridge.ts`

In the `ask_question` branch of the bridge `send()` logic, replace:
```ts
const title = content.title as string;
const question = content.question as string;
if (!title) { /* log + skip */ return; }
```
with:
```ts
const rawTitle = content.title as string;
const rawQuestion = content.question as string;
if (!rawTitle) { /* log + skip */ return; }
const title = transformText(rawTitle);
const question = transformText(rawQuestion || '');
```

**Note:** With Stage 5.1 in place, `transformText` is no longer set by Telegram adapter (sanitizer was removed). Approval cards now ride whatever the HTML pipeline does. If upstream's ask-question Card accepts `parse_mode` / HTML, swap in the HTML renderer here. Otherwise, confirm Telegram's Card rendering tolerates plain text with `_`/`*` unescaped — test after upgrade.

## Stage 5.4 — Surf MCP per-group via container.json (`a2bddf8`)

**This supersedes Stage 2's "Surf MCP" subsection.** Rewrite Stage 2 to match the new approach:

**Old (Stage 2):** host auto-injects `ENABLE_SURF_MCP=true` when `~/.config/x402-proxy` exists; `container/agent-runner/src/index.ts` hardcodes a stdio `surf` entry in `mcpServers`.

**New (Stage 5.4):** Surf is declared per-group in `container.json → mcpServers` with HTTP transport + Bearer header. Nothing is hardcoded in the agent-runner.

**Changes:**

1. `container/agent-runner/src/index.ts` — remove the `ENABLE_SURF_MCP === 'true'` block entirely. Widen the `NANOCLAW_MCP_SERVERS` merge to accept non-stdio configs:
   ```ts
   const additional = JSON.parse(process.env.NANOCLAW_MCP_SERVERS) as Record<string, Record<string, unknown>>;
   for (const [name, config] of Object.entries(additional)) {
     mcpServers[name] = config as typeof mcpServers[string];
     const transport = typeof config.type === 'string'
       ? config.type
       : (typeof config.command === 'string' ? `stdio:${config.command}` : 'unknown');
     log(`Additional MCP server: ${name} (${transport})`);
   }
   ```

2. `src/container-runner.ts` — remove the `ENABLE_SURF_MCP=true` injection (the `fs.existsSync(~/.config/x402-proxy)` block). The x402-proxy mount itself **stays** (it's still useful for other x402 consumers).

3. `.claude/skills/debug/SKILL.md` — generalize the "MCP missing from tool list" section to cover stdio / http / sse via `container.json`. Strip `ENABLE_SURF_MCP` / surf-specific guidance.

**Per-group wiring:** surf is now enabled per-group by adding to `groups/<name>/container.json`:
```json
{
  "mcpServers": {
    "surf": {
      "type": "http",
      "url": "https://surf.cascade.fyi/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Stage 5.5 — /debug skill rewrite (`5a9b76e`)

`.claude/skills/debug/SKILL.md` — fork version is a v2-native rewrite. Upstream did not touch `.claude/skills/debug/` between `bd659fd` and `upstream/v2`, so copy the fork's file over wholesale into the worktree after skills are merged. The `a2bddf8` commit also trimmed surf/x402 guidance from it — the file in fork `HEAD` is the correct final version.

## Stage 5.6 — Docs scrub (`3331f5f`)

Drops v1-era specs and `container_config` refs from `docs/*.md`, `CONTRIBUTING.md`, `README_ja.md`, `README_zh.md`. **Likely redundant** — upstream v2.0.0 is expected to have its own updated docs. Verify with:
```bash
git log bd659fd..upstream/v2 -- docs/ CONTRIBUTING.md README_ja.md README_zh.md | head -20
```
If upstream already rewrote these, skip. Otherwise, re-apply the fork's deletions.

---

# Stage 6 — Upstream v2.0.0 architectural shifts (corrections)

`upstream/v2` is now the **NanoClaw v2.0.0 GA release** (CHANGELOG entry dated 2026-04-22). Several breaking changes invalidate or reshape parts of Stages 1–4. Resolve each of these during Phase 2 re-application:

### 6.1 — Shared-source agent-runner (upstream `8a12fa6`)

Per-group `agent-runner-src/` overlays are gone. All groups mount a single read-only shared agent-runner. **Impact on fork:**

- Stage 2's `container/agent-runner/src/mcp-tools/core.ts::sendMediaGroup` and `container/agent-runner/src/formatter.ts::formatAttachments` transcript rendering now live **only** in `container/agent-runner/src/`. Don't copy them into any `groups/<name>/agent-runner-src/` overlay — that path no longer exists.
- If the fork has stale `data/v2-sessions/<id>/agent-runner-src/` overlay directories, they'll be ignored after upgrade. Safe to leave in place.

### 6.2 — Composed CLAUDE.md from shared base + fragments (upstream `c8fc1da`)

Per-group `CLAUDE.md` is now composed from a shared base + per-group fragments instead of a single standalone file. **Impact on fork:**

- Stage 1's monolithic `groups/main/CLAUDE.md` (John/Mark persona) and `groups/global/CLAUDE.md` (writing rules) need to be **refactored into the new fragment model**. Read `upstream/v2:groups/global/CLAUDE.md` and any scaffold files it references — the fragment format is defined there.
- A root-level `CLAUDE.md` exists on upstream/v2 trunk (it did not at `bd659fd`). Merge fork's root `CLAUDE.md` content with upstream's, or keep upstream's and move fork-specific content into a fragment.

### 6.3 — Routing rewrite (upstream `16b9499` + follow-ups)

Engage modes, sender scope, accumulate/drop, per-agent fan-out are new in the router. `src/router.ts`, `src/channels/chat-sdk-bridge.ts`, and `src/access.ts` all changed substantially. **Impact on fork:**

- Stage 2's Telegram feature interceptor must still **attach around `onInbound`** the same way — confirm the hook point still exists.
- `e45374b` (ask_question sanitize) touches `chat-sdk-bridge.ts` which has many upstream commits. The merge target has moved — find the new `ask_question` branch of `send()` in the upgraded bridge and apply the `transformText(rawTitle)` / `transformText(rawQuestion || '')` change there.

### 6.4 — Commits already absorbed upstream

These fork commits are now redundant — **do not cherry-pick or port them**. After resetting to `upstream/v2`, they're already there:

- `820d1ba fix(agent-runner): spawn built-in MCP server with bun, not node` — upstream has `e93292d` (same intent, same file).
- `57fe257 fix(channels): bridge openDM delegates to adapter directly` — upstream has `27c5220` (same title, same fix).

Verify post-upgrade by grepping for `adapter.openDM` in `src/channels/chat-sdk-bridge.ts` and `command: 'bun'` in `container/agent-runner/src/index.ts`.

### 6.5 — Alternative-provider & channel branch split

Channels (`upstream/channels`) and non-default providers (`upstream/providers`) are now on sibling branches. **Impact on fork:**

- Stage 2 already assumed Telegram installs from `upstream/channels` — still correct.
- `/add-<channel>` skills are now the canonical install path. For fresh worktree setup, prefer running the skill over manual file copies.

### 6.6 — Apple Container removed from default setup

Not applicable — the fork runs Docker.

### 6.7 — OneCLI as sole credential path

Already aligned (Stage 2 added `ONECLI_API_KEY`). Verify `ONECLI_API_KEY` is still read from `src/config.ts` and passed to `new OneCLI({…})`.

---

## Validation (updated for Stage 5)

```bash
pnpm install
pnpm run build
pnpm test
cd container/agent-runner && bun install && bun test && bun run typecheck
cd ../..
./container/build.sh
```

**HTML pipeline-specific:**
- Send a table-heavy markdown message to Telegram → narrow tables render as `<pre><code>` blocks, wide tables render as nested bullets.
- Send a message with `__underline__` → renders as underline, not double-bold.
- Send a long blockquote (>300 chars) → renders with tap-to-expand.
- Send a message with `---` on its own line → no stray bold artifact.
- Send a >4000-char message → split into multiple parts with no inline-tag breakage.

**gh CLI:**
```bash
docker run --rm --entrypoint sh nanoclaw-agent:latest -c \
  'which gh && gh --version | head -1'
```
Then verify the real token is injected by checking container env (during a live session) contains `GH_TOKEN=gho_…` (not `placeholder`).

**Approvals:** trigger an approval whose question contains `GH_TOKEN` or similar — should deliver without Telegram rejection.

**Surf per-group:** verify `mcp__surf__*` appears in the tool list **only** for groups that include the `surf` entry in `container.json → mcpServers`.

---
