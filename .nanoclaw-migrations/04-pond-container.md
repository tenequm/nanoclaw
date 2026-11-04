# Pond recall and the container image

Covers commits: 8, 9. Source S=098ed630, target U=f7440e85.

Commit 8 lands before commit 9: commit 8 adds the pond Dockerfile section, commit 9 adds
the rest of the fork block directly above it, so the two read as one contiguous block.
Commit 7 (Telegram) must already be in: `media-download` uses `send_media_group` and `tts`
relies on the Telegram adapter routing `.ogg` to `sendVoice`.

## Commit 8 - feat(pond): cross-session recall via /add-pond

### Skill folder and payload [COPY]
**Intent:** agents search their own past sessions (and stores the operator grants) through a
read-only pond MCP server; ingest and read permissions are independent per store.
**Files:** `.claude/skills/add-pond/{SKILL.md,REMOVE.md,pond-stores.ts,pond-stores.test.ts,pond-mcp.ts,pond-registration.test.ts,pond-dockerfile.test.ts,pond-sync.sh,pond-recall-container-skill.md}`,
`src/pond-stores.ts`, `src/pond-stores.test.ts`, `src/pond-dockerfile.test.ts`,
`container/agent-runner/src/pond-mcp.ts`, `container/agent-runner/src/pond-registration.test.ts`,
`scripts/pond-sync.sh`, `container/skills/pond-recall/SKILL.md`.
**How to apply on U:** copy the skill folder from S, then run the skill's own copy step
(the tree copies at S are byte-identical to the skill payload; checked with `diff`):
```bash
mkdir -p .claude/skills/add-pond
for f in SKILL.md REMOVE.md pond-stores.ts pond-stores.test.ts pond-mcp.ts \
  pond-registration.test.ts pond-dockerfile.test.ts pond-sync.sh pond-recall-container-skill.md; do
  git show 098ed630:.claude/skills/add-pond/$f > .claude/skills/add-pond/$f
done
S=.claude/skills/add-pond
cp $S/pond-stores.ts src/pond-stores.ts
cp $S/pond-stores.test.ts src/pond-stores.test.ts
cp $S/pond-dockerfile.test.ts src/pond-dockerfile.test.ts
cp $S/pond-mcp.ts container/agent-runner/src/pond-mcp.ts
cp $S/pond-registration.test.ts container/agent-runner/src/pond-registration.test.ts
cp $S/pond-sync.sh scripts/pond-sync.sh && chmod +x scripts/pond-sync.sh .claude/skills/add-pond/pond-sync.sh
mkdir -p container/skills/pond-recall && cp $S/pond-recall-container-skill.md container/skills/pond-recall/SKILL.md
```
`src/pond-stores.ts` imports `MountClass` from `./drivers/types.js` and `VolumeMount` from
`./providers/provider-container-registry.js`; both exist unchanged on U (`VolumeMount` still
carries `mountClass?` and `scope?`). `pond-mcp.ts` returns plain stdio entries that satisfy U's
`McpServerConfig` (`container/agent-runner/src/providers/types.ts`).
**Verify:** `pnpm exec vitest run src/pond-stores.test.ts src/pond-dockerfile.test.ts`;
`cd container/agent-runner && bun test src/pond-registration.test.ts`.

### Skill prose: bump the stale pond pin [ADAPT]
**Intent:** the skill must pin the same pond the image bakes; at S its prose still says
`0.16.3` while S's Dockerfile has `0.20.3`.
**Files:** `.claude/skills/add-pond/SKILL.md`.
**How to apply on U:** replace both `0.16.3` occurrences with `0.20.3` (the
`ARG POND_VERSION=` line in the Dockerfile fence and the `releases/download/v0.16.3/` curl URL in
"Install pond on the host"). The skill's other anchors are still right on U: the import next
to `./modules/mount-security/index.js` (`src/container-runner.ts:63`), the push after the
provider-contributed mounts block in `buildMounts`, the import next to `./plugin-mcp.js`
(`container/agent-runner/src/index.ts:44`), the merge after the `config.mcpServers` loop and
before `createProvider(...)`, and the Dockerfile section "immediately before `# ---- Bun runtime`".
The host's pond binary must stay at the same version as `POND_VERSION` (pre-release, no
format compat shims); on the live install that host pin lives outside this repo.
**Verify:** `rg -n "0\.16\.3" .claude/skills/add-pond` prints nothing.

### Host store mounts in `buildMounts` [MERGE]
**Intent:** a group's container gets each local pond store it may read, read-only, at
`/workspace/extra/pond/<name>`; the host decides, containers never write pond.
**Files:** `src/container-runner.ts`.
**How to apply on U:** no additive seam fits. `registerProviderContainerConfig` is one-per-provider
(it throws on a second `'claude'` registration, which commit 5 owns) and its `mounts` are only
honoured when the provider has no host contract, so the skill's one reach-in stays. Two edits:
1. Import, next to `import { validateAdditionalMounts } from './modules/mount-security/index.js';`
   (U line 63):
   ```ts
   import { pondStoreMounts } from './pond-stores.js';
   ```
2. In `buildMounts` (U line 1157), directly after the block that ends
   `mounts.push(...providerContribution.mounts.map(...))` / `}` (the "Provider-contributed
   mounts" comment) and before the final `return mounts;`:
   ```ts
     // Pond recall stores (.claude/skills/add-pond): read-only, host-decided.
     // The module classes them itself - see the rationale in pond-stores.ts.
     mounts.push(...pondStoreMounts(agentGroup.id, DATA_DIR));
   ```
   `pondStoreMounts` already returns `mountClass: 'allowlisted-extra'`, `scope`, `readonly: true`;
   `toMountSpecs` converts them unchanged. With no `data/pond/stores.json` it returns `[]`.
**Verify:** `pnpm exec tsc --noEmit`; `pnpm exec vitest run src/container-runner.test.ts` (existing mount
tests stay green because the function returns `[]` without a config);
`rg -n "pondStoreMounts" src/container-runner.ts` shows the import and the push.

### Runner MCP registration in `index.ts` [MERGE]
**Intent:** one read-only stdio pond server per mounted store; no mount means no server.
**Files:** `container/agent-runner/src/index.ts`.
**How to apply on U:** no upstream registry for runner MCP servers exists (`registerTools` /
`extendTool` cover tools inside the built-in `nanoclaw` server, not extra servers), so this is a
minimal edit:
1. Import, next to `import { resolvePluginServer } from './plugin-mcp.js';` (U line 44):
   ```ts
   import { pondMcpServers } from './pond-mcp.js';
   ```
2. In `main()`, after the `for (const [name, serverConfig] of Object.entries(config.mcpServers))`
   loop closes (U ~line 119) and before `const provider = createProvider(providerName, {`:
   ```ts
     // Pond recall (.claude/skills/add-pond): one read-only stdio server per
     // store the host mounted under /workspace/extra/pond. No mount, no server.
     Object.assign(mcpServers, pondMcpServers());
   ```
**Verify:** `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`; the structural test in
`pond-registration.test.ts` (`Object.assign(mcpServers, pondMcpServers())` regex) passes.

### pond binary in the image [MERGE]
**Intent:** the container runs `pond mcp` against the mounted stores.
**Files:** `container/Dockerfile`.
**How to apply on U:** insert the pond section from the add-pond SKILL.md (the fenced
`dockerfile` block, with `POND_VERSION=0.20.3`) on its own, immediately before U's
`# ---- Bun runtime ---` header (U line 76), with one blank line on each side. It is reproduced as
the last section of the commit 9 block below; commit 9 later inserts the rest of the block
directly above it.
**Verify:** `pnpm exec vitest run src/pond-dockerfile.test.ts container/dockerfile.test.ts`.

### Host sync loop [COPY]
**Intent:** the host ingests each group's Claude transcripts into the stores named in its
`ingest` lists (`data/pond/stores.json`, host-only).
**Files:** `scripts/pond-sync.sh` (copied above). No change for U: it reads
`data/v2-sessions/<gid>/.claude-shared/projects`, which U still uses (`claudeDir` in `buildMounts`).
The scheduler (systemd timer or equivalent) is install config, not repo code.
**Verify:** `bash -n scripts/pond-sync.sh`; on the live install `./scripts/pond-sync.sh` prints
`pond-sync: <n> group-store sync(s) completed`.

### Skill pins [ADAPT]
**Intent:** CI's `skill-pins` job runs `pnpm run skill-pins:check`; the add-pond SKILL.md adds a
`POND_VERSION` Dockerfile ARG row to `not-covered.json`.
**Files:** `.github/skill-pins/not-covered.json`.
**How to apply on U:** do NOT copy S's file (it carries a stale `POND_VERSION=0.16.3` row and a
voice-mode row from commit 12). Run `pnpm run skill-pins:generate` in this commit.
**Verify:** `pnpm run skill-pins:check`; `rg -n POND_VERSION .github/skill-pins/not-covered.json`
shows `0.20.3`.

## Commit 9 - feat(container): fork image block, tool pins, agent rules, container skills

### Dockerfile fork block [MERGE]
**Intent:** one contiguous fork block with no edits to upstream lines (D4): media stack
(ffmpeg, yt-dlp, instaloader), Deno for yt-dlp, uv/uvx for Python and Python MCP servers, gh
plus git-over-HTTPS through the OneCLI gateway, git-lfs, pond. Dropped vs S: duckdb,
openssh-client, AtomicParsley, pip `secretstorage`/`xattr`, the `uv` named stage above
`FROM`, and the `ARG DENO_VERSION` next to U's `BUN_VERSION`.
**Files:** `container/Dockerfile`.
**How to apply on U:** anchor: between U's `ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (U line 74)
and the `# ---- pond:` header commit 8 placed before `# ---- Bun runtime`. Everything above
`# ---- pond:` below is new in this commit; the pond section is commit 8's, shown so the whole
block can be checked. Placement reasons: after U's base apt list, because
`container/dockerfile.test.ts` parses the FIRST `apt-get install -y --no-install-recommends ... &&`
as the base list (keep `poppler-utils` in U's list, never move it); before Bun/pnpm, because U
orders "most stable first, most frequently bumped last" and a Claude Code bump in
`cli-tools.json` must not rebuild ffmpeg/gh/pond; still root (before `USER node`). Each `ARG` sits
directly above the only `RUN` that uses it, so a pin bump invalidates from that layer down only.
`ENV GIT_SSL_CAINFO` points at a file that exists only at runtime; the later build steps
(`bun install`, `pnpm install -g`) fetch no git deps (U's `bun.lock` has none), so it is inert at
build time - a future git-sourced dep would trip it. `COPY --from` takes a literal tag
(BuildKit expands no `ARG` in an image reference), which is why the uv version is inline.

```dockerfile
# ---- Fork additions (tenequm/nanoclaw) --------------------------------------
# One contiguous block through the pond section; upstream lines stay untouched.

# ---- Media stack (yt-dlp / instaloader / ffmpeg) + git-lfs -------------------
# Used by the media-download container skill (ffmpeg also by tts). The yt-dlp
# `default` extra pulls yt-dlp-ejs, mutagen, pycryptodomex, brotli, websockets,
# requests and certifi; `curl-cffi` adds impersonation. pip goes through
# --break-system-packages since apt-packaged Python on Debian slim is PEP 668
# managed and pip would otherwise refuse.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        git-lfs \
        ffmpeg \
        python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir \
        "yt-dlp[default,curl-cffi]" instaloader

# yt-dlp needs Deno for modern YouTube signature extractors.
ARG DENO_VERSION=2.9.6
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s v${DENO_VERSION}

# ---- uv / uvx ----------------------------------------------------------------
# General Python capability for agents, and the launcher for Python MCP servers
# (the `npx -y` equivalent that Debian bookworm has no package for - neither `uv`
# nor `python3-uv` is in the repos). Copied from Astral's official image rather
# than piped from an install script: two static binaries, no network fetch at
# container start, no dependency on the PEP 668 managed system Python. The tag is
# literal because BuildKit expands no ARG in a COPY --from image reference.
COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /uvx /usr/local/bin/

# ---- GitHub CLI (gh) ---------------------------------------------------------
# Install gh so agents can run `gh pr list`, `gh repo view`, etc. Auth follows
# the OneCLI "Pattern D" model (onecli.sh/docs/guides/credential-stubs/general-app):
# the sentinel env value only satisfies gh's local auth check; real credentials
# are injected at the network level by the OneCLI gateway (HTTPS_PROXY), via the
# GitHub OAuth app connection. No real token ever enters the container env.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

ENV GH_TOKEN=onecli-managed

# git-over-HTTPS through the gateway. Two gaps the injected env doesn't cover
# (verified against the @onecli-sh/sdk version pinned in package.json - re-check
# on upgrades): git reads GIT_SSL_CAINFO, not SSL_CERT_FILE, for the MITM CA; and
# the gateway only swaps credentials git actually sends, so gh acts as git's
# credential helper to supply the sentinel. The CA path is hardcoded in the
# OneCLI SDK (applyContainerConfig mounts the combined gateway+system bundle
# there), so public hosts still verify normally.
ENV GIT_SSL_CAINFO=/tmp/onecli-combined-ca.pem
RUN git config --system credential.helper '!gh auth git-credential'

# ---- pond: cross-session recall (read-only MCP over mounted stores) ----------
ARG POND_VERSION=0.20.3
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
The gh and git comments are S's verbatim (keep the OneCLI block). The CA path still matches U's
`/add-onecli` payload (`.claude/skills/add-onecli/payload/src/gateway-providers/onecli.ts:71`,
`const target = '/tmp/onecli-combined-ca.pem'`); re-check after commit 0's apply.
**Verify:** `git diff f7440e85 -- container/Dockerfile` shows only added lines, all between U lines
74 and 76; `rg -n -i "duckdb|openssh|atomicparsley|secretstorage|xattr" container/Dockerfile`
prints nothing; `pnpm exec vitest run container/dockerfile.test.ts container/base-image.test.ts src/pond-dockerfile.test.ts`;
`./container/build.sh`, then in the built image (`docker run --rm --entrypoint sh <image> -c '...'`):
`python3 -m pip show yt-dlp-ejs curl_cffi mutagen` (all found - the `default` extra check),
`yt-dlp --version && instaloader --version && ffmpeg -version | head -1 && deno --version && uv --version && gh --version && git lfs version && pond --version`,
`git config --system credential.helper` prints `!gh auth git-credential`.

### `container/cli-tools.json` [MERGE]
**Intent:** keep the fork's agent-browser bump; take upstream's Claude Code pin (D5).
**Files:** `container/cli-tools.json`.
**How to apply on U:** start from U's file (Claude Code `2.1.296`, which equals the
`claudeCodeVersion` of U's locked Agent SDK `0.3.296`) and change only the `agent-browser`
`"version"` from `0.27.1` to `0.41.2` (owner decision 2026-11-04; S had `0.41.1`).
**Verify:** `jq -r '.[] | "\(.name)@\(.version)"' container/cli-tools.json` prints
`agent-browser@0.41.2` and `@anthropic-ai/claude-code@2.1.296`;
`npm view @anthropic-ai/claude-agent-sdk@0.3.296 claudeCodeVersion` prints `2.1.296` (re-run with
the SDK version in `container/agent-runner/bun.lock` after any later SDK bump; the two must match).

### `.github/skill-pins/*` [ADAPT]
**Intent:** CI's `pnpm run skill-pins:check` must match the bumped `cli-tools.json`.
**Files:** `.github/skill-pins/package.json`, `.github/skill-pins/not-covered.json`.
**How to apply on U:** do NOT copy S's files (stale: Claude Code `2.1.295`, agent-browser
`0.39.0`, plus voice-mode deps from commit 12). Run `pnpm run skill-pins:generate` in this commit.
**Verify:** `pnpm run skill-pins:check`; `rg -n '"agent-browser"' -A1 .github/skill-pins/package.json`
shows `0.41.2`.

### `container/install-cli-tools.sh` [DROP]
**Intent:** the fork's patch forced Claude Code to the SDK's `claudeCodeVersion` instead of the
manifest pin. D5 drops it: U keeps the manifest pin in step with the SDK (both `.296`).
**Files:** `container/install-cli-tools.sh` - keep U's file untouched.
**Verify:** `git diff f7440e85 -- container/install-cli-tools.sh` is empty.

### `container/CLAUDE.md` rules block [MERGE]
**Intent:** D3 - the fork's "Rules for every agent" block stays exactly as at S, minus its
DuckDB paragraph (duckdb leaves the image), and U's "Lead with the result..." wording goes.
**Files:** `container/CLAUDE.md` (U did not change this file since B).
**How to apply on U:** two edits, nothing else in U's prose changes.
1. In-place, under `## Communication` (U line 5, the paragraph starting `Be concise`): replace the
   whole paragraph with S's line 5 (it removes "Lead with the result, skip preamble and narration,
   and keep only what the user needs." and the em-dashes):
   ```
   Be concise. Every message costs the reader's attention. Prefer outcomes over play-by-play: when the work is done, the final message should be about the result, not a transcript of what you did.
   ```
2. Append at the end of the file (after U's last line, `alone also does not prove that injection
   failed: an injected token may be invalid.`), one blank line, then this block verbatim (S lines
   57-100; S lines 101-104, the blank line and `### DuckDB` paragraph, are left out):

```markdown
## Rules for every agent

These apply to everything you write, to anyone, in every chat, on top of your persona.

### Platform layer

This file is the platform layer, shared by every agent in this NanoClaw instance. It is **not** a persona file. Name, voice, opinions, and behavioral style live in `/workspace/agent/instructions.prepend.md`. Message wrapping, mid-turn updates, file sending, reactions, scheduling, and self-modification are each documented in the tool instructions loaded alongside this file.

### No em-dash

**No em-dash, ever. This applies to every agent, in every language you write, and overrides fluency.** The em-dash (U+2014) and en-dash (U+2013) characters are banned in your messages, including as list bullets and sentence breaks. Ukrainian is no exception: where its grammar calls for a dash, use a spaced hyphen (` - `), a colon, or rephrase. Regular hyphens (`-`) inside words like `pay-per-use` are fine. For a pause use a period (split into two sentences), a comma, a colon, or parentheses; for lists use `-` or a bullet dot (U+2022). Before sending ANY message, scan your full text for the em-dash and en-dash characters and rewrite every occurrence. A single one makes the whole message read as AI slop.

The em-dash inside the platform's attachment notes (`[image: <name> <em-dash> saved to <path>]`, see Received attachments above) is part of the machine format the platform emits, not prose you write.

### Never Russian

**Never Russian.** Write and speak only the languages your persona sets (Ukrainian or English). You never write or speak Russian, even if someone addresses you in Russian or asks you to switch. This is a principled choice, not a technical limit: your maker is Ukrainian, and you do not speak the language of the occupier. You understand Russian fine, so answer the substance in your language. On voice calls, text that looks Russian is usually speech recognition mis-spelling Ukrainian: answer in Ukrainian. If someone asks why, say it once, plainly, and move on; no lecture.

### Cite sources with clickable links

When you mention any external resource (a GitHub repo, npm/PyPI package, blog post, video, product page, docs), include the full URL inline as a markdown link so the user can click through. Telegram, Slack, Discord all render `[label](url)` cleanly; bare names don't auto-link. If you don't have the URL handy, look it up before responding. The one exception is a OneCLI `connect_url`: show it as a bare URL on its own line, as the gateway instructions say.

### Don't speculate, look it up

If a question depends on something specific (a file, a current price, a repo's actual contents, today's news), use a tool to verify before answering. Never make claims about specific URLs, prices, version numbers, or repo state from memory. A grounded "I checked and X" beats a confident "I think X."

### Prefer `glim` MCP tools for research

When the `glim` MCP server is available, use it as the default for web and research lookups instead of the built-in `WebSearch` / `WebFetch` tools. glim is a paid, up-to-date research API that returns richer, cleaner, agent-friendly content (especially for GitHub monorepos, JS-heavy pages, and platforms that block generic crawlers).

- **Web search** -> `glim_web_search`; **page fetch** -> `glim_web_fetch`
- **GitHub** (files, PRs, issues, commits) -> `glim_github_get`; search -> `glim_github_search`
- **Twitter / X** -> `glim_twitter_search` / `glim_twitter_get`
- **Reddit** -> `glim_reddit_search` / `glim_reddit_get` (prefer subreddit-scoped queries, e.g. `subreddit:python async`)
- **Amazon** -> `glim_amazon_search` / `glim_amazon_get`
- **YouTube transcripts** -> `glim_youtube_get`

Search tools return compact previews; follow up with the matching detail tool for full content. When you delegate research to sub-agents, instruct them to use glim tools too. Only fall back to `WebSearch` / `WebFetch` if a glim tool fails or the user explicitly asks.

### GitHub and git

`gh` and git-over-HTTPS both work out of the box. The OneCLI gateway injects real credentials at the proxy, and the image pre-configures git's CA and credential helper. The `GH_TOKEN` value in your env is a sentinel: never change it or ask for a real token.

Always use HTTPS remotes, not SSH. SSH bypasses the gateway and has no key. If a private org repo 404s while personal repos work, the org restricts third-party OAuth apps; tell the user to approve the app in the org's OAuth application policy settings.
```

**Verify:** `diff <(git show 098ed630:container/CLAUDE.md | sed '101,$d') container/CLAUDE.md` is
empty; `rg -n -i "duckdb|Lead with the result" container/CLAUDE.md` prints nothing.

### Container skills [COPY]
**Intent:** the fork's agent capabilities that ride the image tools above.
**Files and how to apply on U:** `git show 098ed630:<path> > <path>` for each:
- `container/skills/gemini-image/SKILL.md` - curl to Gemini, credential via the OneCLI gateway;
  uses `send_file` only. No removed tool.
- `container/skills/media-download/SKILL.md` - yt-dlp, instaloader, ffmpeg (all kept). Uses
  `send_file` and `send_media_group` (commit 7). No AtomicParsley or ssh use.
- `container/skills/meta-ads/SKILL.md`, `container/skills/meta-ads/references/{api-endpoints,onboarding,reporting,website-analysis}.md`
  - read-only reporting; `send_message`/`send_file` only. No removed tool.
- `container/skills/tts/SKILL.md`, `container/skills/tts/scripts/tts.ts` - Gemini TTS via the
  gateway, `bun` + `ffmpeg` (kept); depends on commit 7's `.ogg` -> `sendVoice` routing.
- `container/skills/pond-recall/SKILL.md` - comes from commit 8's copy step, not here.
`rg -n -i "duckdb|ssh|canvas_read|canvas_update|atomicparsley" container/skills/{gemini-image,media-download,meta-ads,tts,pond-recall}`
at S prints nothing.
**Verify:** for each copied path `diff <(git show 098ed630:<path>) <path>` is empty;
`test ! -e container/skills/canvas-work`; each SKILL.md `send_*` example passes an explicit `to`.

### `container/skills/canvas-work` [DROP]
**Intent:** D7 drops the Slack canvas tools. The skill is built entirely on them: its description
says "Use EVERY time you edit a canvas with canvas_update", and its body calls `canvas_read` and
`canvas_update` throughout (S `container/skills/canvas-work/SKILL.md` lines 6, 35, 62, 67, 93, 98,
135, 137, 146). With no `canvas_*` tools it is dead text; it is archived on
`archive/slack-agent-flow` with the tools.
**Verify:** `test ! -e container/skills/canvas-work`.

### `container/skills/onecli-gateway` [n/a - commit 0]
**Intent:** installed by `/add-onecli` from its payload; S's two files are byte-identical to U's
`.claude/skills/add-onecli/payload/container/skills/onecli-gateway/{SKILL.md,instructions.md}`.
**How to apply on U:** nothing here; commit 0's apply writes them.

## Cross-section notes

- Commit 10 (Slack): `container/skills/welcome/addenda/slack.md` belongs to Slack onboarding (it
  is read through U's existing "Channel addenda" hook in `container/skills/welcome/SKILL.md`).
  Copy it in commit 10 but delete the sentence starting "The room's canvas tab" in its
  "Shared rooms" item, since D7 drops room canvases.
- D7 DROP: `container/skills/welcome/addenda/teams-tour.md` is the agent flow's "Teams" tour item
  (create agents, open a shared room); it goes with the archived flow.
- Commit 7 must precede commit 9's skills: `send_media_group` (media-download) and the `.ogg`
  voice routing (tts).
- Commit 5 owns `registerProviderContainerConfig('claude')`; pond must not register a second
  `'claude'` config (it throws), hence the `buildMounts` reach-in.
- Commit 12 (voice) regenerates `.github/skill-pins/*` again for its own deps; nothing from S's
  voice rows is carried here.
- Commit 14 (docs): any fork doc mentioning duckdb or ssh in the container is now wrong.
- The image change needs a container rebuild on the live install (`./container/build.sh`) and the
  host pond binary at `0.20.3` before groups respawn.

## Files covered

.claude/skills/add-pond/REMOVE.md -> 8
.claude/skills/add-pond/SKILL.md -> 8
.claude/skills/add-pond/pond-dockerfile.test.ts -> 8
.claude/skills/add-pond/pond-mcp.ts -> 8
.claude/skills/add-pond/pond-recall-container-skill.md -> 8
.claude/skills/add-pond/pond-registration.test.ts -> 8
.claude/skills/add-pond/pond-stores.test.ts -> 8
.claude/skills/add-pond/pond-stores.ts -> 8
.claude/skills/add-pond/pond-sync.sh -> 8
.github/skill-pins/not-covered.json -> 8, 9 (regenerated, not copied)
.github/skill-pins/package.json -> 9 (regenerated, not copied)
container/CLAUDE.md -> 9
container/Dockerfile -> 8 (pond section), 9 (rest of the block)
container/agent-runner/src/pond-mcp.ts -> 8
container/agent-runner/src/pond-registration.test.ts -> 8
container/cli-tools.json -> 9
container/install-cli-tools.sh -> DROP
container/skills/canvas-work/SKILL.md -> DROP
container/skills/gemini-image/SKILL.md -> 9
container/skills/media-download/SKILL.md -> 9
container/skills/meta-ads/SKILL.md -> 9
container/skills/meta-ads/references/api-endpoints.md -> 9
container/skills/meta-ads/references/onboarding.md -> 9
container/skills/meta-ads/references/reporting.md -> 9
container/skills/meta-ads/references/website-analysis.md -> 9
container/skills/onecli-gateway/SKILL.md -> n/a (written by /add-onecli, commit 0)
container/skills/onecli-gateway/instructions.md -> n/a (written by /add-onecli, commit 0)
container/skills/pond-recall/SKILL.md -> 8
container/skills/tts/SKILL.md -> 9
container/skills/tts/scripts/tts.ts -> 9
container/skills/welcome/addenda/slack.md -> 10
container/skills/welcome/addenda/teams-tour.md -> DROP
scripts/pond-sync.sh -> 8
src/pond-dockerfile.test.ts -> 8
src/pond-stores.test.ts -> 8
src/pond-stores.ts -> 8
