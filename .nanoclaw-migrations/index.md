# NanoClaw Fork Migration Guide - v4

**Generated:** 2026-11-04
**Base (merge-base with upstream):** `66f0823a` (2026-10-06)
**Fork HEAD at generation:** `098ed630` (fork `main`)
**Upstream target:** `f7440e85` (`upstream/main`: v2026.10.1-rc.2 plus three fixes)

Supersedes the v3 guide (`guide.md`, generated 2026-08-31, removed in this commit). Tier 3 in
`.claude/skills/migrate-nanoclaw` terms: start from a clean upstream checkout and replay every
customization as ONE focused commit, in the order below. Nothing is merged.

**Status:** draft. Section 07 (voice-mode) is a placeholder until the `/meet` rebuild on `feat/meet`
merges into fork `main`; then re-extract it and update "Fork HEAD at generation" above.

## How to use

1. Read this file, then the sections in commit order. Each section file owns a set of source
   files and documents every hunk in them; a hunk that belongs to another commit is marked with
   that commit's number (usually under "Cross-section notes"). Before replaying commit N, collect
   every item labeled N from all sections.
2. Item tags: **[COPY]** a new file, copied verbatim with `git show 098ed630:<path>`; **[MERGE]**
   both sides changed the file, so start from upstream's version and re-apply the intent;
   **[ADAPT]** upstream moved something the replay must fit; **[DROP]** deliberately not replayed.
3. Gate every commit with `check.sh` (see "Execution plan"); run `check.sh full --baseline ...`
   once at the end. Fix only what the replay broke.
4. Prefer upstream's additive seams over editing upstream files: `registerTools` / `extendTool`
   (runner MCP tools), `registerMigration()` (module migrations), `onHostStart`, module barrel
   imports, `registerProviderContainerConfig`, the mailbox slot in `compose.ts`, skill payloads.

## Commit plan

| # | Commit | Section |
|---|---|---|
| 0 | `setup: apply <skill>` for each upstream skill the install uses (OneCLI first) | [00](00-upstream-skills.md) |
| 1 | `feat(core): agent-doc section hooks` | [01](01-core.md) |
| 2 | `feat(envelope): message ids, quotes, sender role, reply_to` | [01](01-core.md), with runner items from [02](02-runner-typing.md) |
| 3 | `feat(typing): report turn state, keep typing through tool calls` | [02](02-runner-typing.md) |
| 4 | `fix(agent-runner): coalesced results, unclosed blocks, ack nudge, PreCompact` | [02](02-runner-typing.md) |
| 5 | `feat(agents): per-agent auto-compact window` | [01](01-core.md) |
| 6 | `feat(commands): host chat commands` | [03](03-telegram-commands.md) |
| 7 | `feat(telegram): grammY channel` | [03](03-telegram-commands.md) |
| 8 | `feat(pond): cross-session recall` | [04](04-pond-container.md) |
| 9 | `feat(container): fork tools, rules and skills` | [04](04-pond-container.md) |
| 10 | `feat(slack): multi-instance, a2a guard, room membership, onboarding` | [05](05-slack-jev.md) |
| 11 | `feat(jev): Jev gate` | [05](05-slack-jev.md) |
| 12 | `feat(voice-mode): voice and meet` | [07](07-voice.md) (pending) |
| 13 | `feat(mailbox): HTTP transport and k8s dev kit` | [06](06-mailbox-k8s.md) |
| 14 | `docs: fork docs and migration guide` | all |

Dependencies: 7, 10, 11 and 12 register prose through commit 1's hooks. Commit 13 implements the
mailbox operations added by commits 2 and 3, so it comes after them. Commit 7's `/context` command
reads commit 5's column.

## Execution plan (minimum wall time)

Commit order is for the final history; build order follows dependencies. Lanes run in
parallel, each in its own isolated checkout (one worktree of this repo, so lane branches are
visible to each other without pushing); an assembler cherry-picks every lane commit into the
order above.

| Wave | Lane | Commits | Starts when | Executor |
|---|---|---|---|---|
| 0 | foundation | 0, 1, 5 | now | GPT-6 Astra, high effort |
| 0 | container | 8, 9 (then a local `./container/build.sh build` to prove the slim block) | now | GPT-6 Astra, medium |
| 1 | foundation | 2, 3, 4 (one lane: 3 and 4 both edit `poll-loop.ts`) | after 1 | GPT-6 Astra, high |
| 1 | telegram | 6 (published first so voice can branch), 7, 11 | after 1 and 5 | GPT-6 Astra, high |
| 1 | slack | 10 (the typing hunk lands with 3 at assembly) | after 1 | GPT-6 Astra, medium |
| 2 | mailbox | 13 | after 2 and 3 | GPT-6 Astra, high |
| 2 | voice | 12 | after `feat/meet` merges, from foundation + 6 | GPT-6 Astra, high |
| 3 | assembly | cherry-pick 0-14 in order, then 14 | all lanes done | the driving session |

Model choice (Artificial Analysis Intelligence Index v5, 2026-11-04): GPT-6 Astra high scores 55
at 7.7 min per task, against Claude Opus 5.5 high at 52 and 9.3 min; xhigh/max tiers roughly
double the time for a few points and are used only for a lane that keeps failing. Lane wall time
is dominated by edit-check-fix loops, so first-time accuracy beats raw speed.

Rules that keep the lanes fast:

- **Pin the upstream target** at `f7440e85` for the whole replay; anchors in this guide assume it.
- **Never merge lockfiles.** Lanes commit whatever `pnpm install` writes; at assembly a
  lockfile conflict is resolved by taking either side and re-running `pnpm install`.
- **COPY items go in one scripted pass** (`git show 098ed630:<path> > <path>` per listed file);
  agent effort goes to MERGE and ADAPT items.
- **One gate script: [`check.sh`](check.sh)**, run from the repo root. Every job runs in
  parallel with tool caches (incremental `tsc`, `eslint --cache`, `prettier --cache`), host
  tests are only those affected by the change (`vitest run --changed <ref>`), and runner tests
  run only when runner files change (`bun test --parallel --changed=<ref>`). It installs first
  when a `package.json` or lockfile changed, prints one PASS/FAIL line per job and the tail of
  each failing log, and ends with `GATE-OK`.
  - `check.sh` - uncommitted changes; use it while iterating and before each commit.
  - `check.sh --base <ref>` - everything changed since `<ref>` (a whole lane).
  - `check.sh full --baseline .nanoclaw-migrations/baseline-upstream.txt` - every CI check and
    both full suites; fails only on test files outside the baseline. Once per lane, at the end.
  - Measured on clean upstream (10-core Mac): 3 s on a clean tree, 18 s after editing
    `src/router.ts` and `poll-loop.ts`, 81 s for `full` (was about 130 s run serially: `pnpm test`
    77 s, then runner tests 32 s, then the other checks; `bun test --parallel` alone is 32 s ->
    6 s). Rejected after measuring: `vitest --pool=threads` (181 failing tests),
    `--maxWorkers=100%` (slower and flakier).
- **The baseline is upstream's own.** Clean upstream (`f7440e85`) fails 34 tests in
  `scripts/update/transaction.e2e.test.ts` and `setup/verify-slack.test.ts`, and
  `scripts/update/controller-archive.test.ts` is flaky; [`baseline-upstream.txt`](baseline-upstream.txt)
  lists the three files. Compare against it, never against zero.
- **Known conflict points at assembly:** `src/router.ts`, `src/delivery.ts`,
  `src/container-runner.ts`, `src/modules/index.ts`, the runner's `mcp-tools/index.ts`,
  `src/db/container-configs.ts`, `package.json`. Resolve with this guide's anchors.

## Owner decisions (2026-11-04)

- The Telegram grammY island stays; it replaces upstream's `/add-telegram`.
- The HTTP mailbox transport and the k8s dev kit stay as one isolated commit. HTTP is the default
  whenever that commit is present.
- Voice-mode is one commit (`/voice` and `/meet` together), including `secret-seal.ts` and the
  webhook root-route handler.
- The "Rules for every agent" block in `container/CLAUDE.md` stays as it is, minus its DuckDB
  paragraph.
- The agent image is slimmed (section 04): duckdb, openssh-client, AtomicParsley and two unused pip
  packages go; git-lfs stays. The fork's additions become one contiguous Dockerfile block.
- Upstream's Claude Code, Agent SDK, Bun and Node pins are taken as-is; only the agent-browser bump
  stays.
- The agent-doc hooks in `project-doc-compose.ts` stay.
- The Slack agent flow (creating Slack bots and rooms from chat) and the Slack canvas tools are
  dropped and archived (below). Multi-instance, the a2a guard, room membership and onboarding stay.
- The fork's core migrations 025, 026 and 028 become idempotent module migrations.
- OneCLI comes from re-running `/add-onecli`; the fork keeps no patches on its installed files.

## Dropped, not replayed

- Slack agent flow and canvas tools: kept on the branch `archive/slack-agent-flow` (cut from fork
  `main` before the rebuild). Section 05 lists the paths and the upstream seam it wraps, for a
  later re-add.
- `src/env-file.ts` and the Slack agent flow's copy; room membership keeps its own two helpers.
- duckdb, openssh-client, AtomicParsley and the pip packages `secretstorage` and `xattr`.
- The `install-cli-tools.sh` patch, the fork's OneCLI file diffs, the typing status text, the
  runner's compact-window plumbing, and the fork's edits to upstream's migration list.
- From the `/meet` rebuild: the meeting front desk and the Attendee bridge.

## Cutover outline

Host-specific steps (service units, proxy routes, backups, the deploy chain) are kept in the
owner's private infra repo, not here. In outline:

1. `feat/meet` is merged and deployed; section 07 is re-extracted; the tree is clean.
2. Safety net: a `backup/pre-migrate-<hash>-<timestamp>` branch and tag, and
   `archive/slack-agent-flow`, all pushed to origin before anything is rewritten.
3. Replay commits 0-14 on a fresh branch from `upstream/main` in an isolated checkout, validating
   after each commit.
4. Back up the central DB, deploy the rebuilt branch, stamp the upgrade marker
   (`pnpm exec tsx scripts/upgrade-state.ts set "" migrate-nanoclaw`) after a successful build, and
   rebuild the agent image.
5. Replace fork `main` with the rebuilt branch (force-push with lease, owner-approved).
6. Check each channel end to end: a Telegram round trip, a Slack message on each instance, an a2a
   room, typing, pond recall, a `/voice` call, a `/meet` join, and an agent spawn over the HTTP
   mailbox.

Rollback: reset to the backup tag, restore the DB copy, rebuild, restart.

## Validation of this guide

Each section ends with "Files covered", which maps every file the fork changed (`git diff
66f0823a 098ed630`) to a commit number or DROP. The union of all sections must equal that file
list; voice files are covered by section 07 once it is re-extracted.
