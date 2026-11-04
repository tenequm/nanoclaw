# Upstream skills re-apply (OneCLI)

Covers commits: 0 (and one short item for 14). Source S=098ed630, target U=f7440e85.

## Applied upstream skills

Applied skills were found by checking, at S and absent at B, every upstream skill's `nc:copy`
destinations, `nc:append` lines and `nc:dep` packages:

| Skill | Status at S | Where it is handled |
|---|---|---|
| `/add-onecli` | all 8 copy targets, the `installed.ts` line, `@onecli-sh/sdk` | commit 0, this section |
| `/add-slack` | all 12 copy targets, `import './slack.js'`, `import './slack-a2a-guard.js'`, `@chat-adapter/slack` | Slack section (05) |
| `slack-a2a-rooms` | `import './slack-a2a.js'` in `src/channels/index.ts` | Slack section (05) |
| `slack-agent-flow` | barrel imports in `src/modules/index.ts` and `container/agent-runner/src/mcp-tools/index.ts` | DROP (D7), do not re-apply |
| `/add-telegram` | only `src/channels/telegram-pairing.ts` (+ test); no `telegram.ts`, no barrel line, no `@chat-adapter/telegram` | not applied: Telegram is the fork's own grammY island (D1, commit 7) |

`/add-voice-mode` and `/add-pond` are fork-owned skills (absent on U); they are not upstream
re-applies (voice section and commit 8). No provider skill (`/add-codex`, `/add-opencode`, ...),
driver, or other gateway skill is applied: `src/drivers/installed.ts` and the provider barrels are
unchanged B..S.

So commit 0 re-applies `/add-onecli` only. `/add-slack` and `slack-a2a-rooms` are re-applied
inside the Slack section's commit, not here.

## Commit 0 - setup: apply add-onecli

### Re-run /add-onecli on U [ADAPT]
**Intent:** the install runs OneCLI as its credential gateway (`NANOCLAW_GATEWAY_PROVIDER=onecli`);
reproduce it by running upstream's own apply, keeping no fork edits to its installed files.
**Files:** `src/gateway-providers/onecli.ts`, `onecli.test.ts`, `onecli-files.ts`,
`onecli-files.test.ts`, `onecli-install.test.ts`, `onecli-chatgpt-stub.ts` (+ test, new on U),
`onecli-provider-credentials.ts` (+ test, new on U), `src/gateway-providers/installed.ts`,
`container/skills/onecli-gateway/SKILL.md`, `container/skills/onecli-gateway/instructions.md`,
`docs/onecli-upgrades.md`, `package.json`, `pnpm-lock.yaml`.
**How to apply on U:** follow `.claude/skills/add-onecli/SKILL.md` at U. It installs from its own
`payload/` folder on main (no registry branch, no fetch):
1. `nc:copy`: copy each `payload/<p>` to `<p>` for the 12 lines in the skill's "Install the provider
   payload" block (`cp .claude/skills/add-onecli/payload/<p> <p>`, creating dirs).
2. `nc:append`: add `import './onecli.js';` as the last line of `src/gateway-providers/installed.ts`.
3. `nc:dep`: `pnpm add @onecli-sh/sdk@2.2.1`; `package.json` must read `"@onecli-sh/sdk": "2.2.1"`.
4. Skip the `nc:run effect:external` step (`scripts/setup.ts`) in the repo: it acts on the gateway
   and `.env` of a running install. It runs on the live install at deploy (it reuses a healthy
   existing gateway and rewrites `ONECLI_URL` in `.env`).
5. Commit as `setup: apply add-onecli`. Do not edit `.claude/skills/add-onecli/` itself (the fork
   never did).

What changes versus the fork's installed copy (all by taking U's payload, nothing to re-apply):
- `onecli.ts`, `onecli.test.ts`, `docs/onecli-upgrades.md`: the fork had B's payload (gateway pin
  1.42.0, no grants). U's payload targets the agent grants API (gateway pin 1.45.0, CLI 2.11.0 in
  `.claude/skills/add-onecli/versions.json`).
- `onecli-files.test.ts`, `onecli-install.test.ts`, the `onecli-gateway` container skill: identical
  in B's and U's payloads. `onecli-install.ts` does not exist on any ref; `onecli-install.test.ts`
  is payload and tests the skill's `scripts/setup.ts` helpers.

### onecli-files.ts cleanup-warning patch [DROP]
**Intent:** S logs a leftover staged temp file instead of throwing from `stageOnecliFile`'s
`finally` (S `src/gateway-providers/onecli-files.ts:5`, `:105-107`).
**Files:** `src/gateway-providers/onecli-files.ts`.
**How to apply on U:** do not. Owner decision D10: take U's payload as is (it still throws at
`payload/src/gateway-providers/onecli-files.ts:103`). A refresh of the skill overwrites installed
files with `copyFileSync` anyway, so an installed-file patch would not survive.

### Behavior change the deploy must expect [ADAPT]
**Intent:** none to replay; U's adapter now grants the group's model credential itself.
**How to apply on U:** nothing in code. On every spawn U's `ensureAgentReady` (payload `onecli.ts`)
attaches the credentials recorded for the group's provider in `data/onecli/provider-credentials.json`.
With no record yet, the first spawn per provider adopts, once, the secrets setup saves by name
(`Anthropic` for claude, `codex`/`openai` for codex). If two or more secrets share that name, it
throws `DuplicateSavedCredentialsError` (`onecli-provider-credentials.ts:203-207`), `ensureAgentReady`
rethrows, and every spawn of that provider fails until fixed. Zero matching secrets is harmless:
nothing is adopted and grants made by hand stay.
**Pre-deploy check:** before deploying, confirm no two OneCLI secrets are named exactly `Anthropic`
(case-insensitive) in `onecli secrets list`. If there are, re-run the Claude login
(`.claude/skills/add-onecli/scripts/auth.ts`, which records the id it uses) or delete the extra
secret. Also confirm the running gateway is the version pinned in `versions.json`; if not, follow
`docs/onecli-upgrades.md` before deploying.
**Verify:**
- `pnpm run build`
- `pnpm exec vitest run src/gateway-providers/onecli-files.test.ts src/gateway-providers/onecli-chatgpt-stub.test.ts src/gateway-providers/onecli-install.test.ts src/gateway-providers/onecli-provider-credentials.test.ts src/gateway-providers/onecli.test.ts src/gateway-providers/gateway-provider-registry.test.ts src/gateway-approval-coordinator.test.ts`
- `for p in $(awk '/^```nc:copy/{f=1;next} /^```/{f=0} f{print $3}' .claude/skills/add-onecli/SKILL.md); do cmp -s ".claude/skills/add-onecli/payload/${p}" "${p}" || echo "differs: ${p}"; done` prints nothing.
- `rg -n "import './onecli.js'" src/gateway-providers/installed.ts` shows one line.

## Commit 14 - OneCLI grants notes in CLAUDE.md

### Short OneCLI note [MERGE]
**Intent:** keep the three operational facts U's docs lack; drop the rest of S's
"Credential grants (OneCLI, this install's gateway)" section (S `CLAUDE.md:181-194`), which U now
covers in `/add-onecli` SKILL.md ("Provider credentials") and `docs/onecli-upgrades.md:40`.
**Files:** `CLAUDE.md`.
**How to apply on U:** under U's "## Secrets / Credentials / Gateways" section, after the paragraph
that points to `docs/gateway-seam.md`, add:

```markdown
OneCLI notes (grants by hand are in `/add-onecli`):

- App connections are attached like secrets: `onecli agents grants attach-connection --id <agent-id> --connection-id <id>`.
- `onecli agents credentials --id <agent-id>` shows what an agent can actually use, with provenance.
- A container whose CLI already got a `401` keeps failing after the grant is attached until it is respawned: `ncl groups restart --id <group-id>`.
```
**Verify:** `rg -n "attach-connection|agents credentials|groups restart" CLAUDE.md`.

## Cross-section notes
- Section 04 owns pins and the Dockerfile (including the OneCLI git CA and credential helper lines,
  D4); nothing about them here.
- The voice section owns `src/webhook-server.ts`: U binds `WEBHOOK_HOST` (default `127.0.0.1`), so the
  live install needs `WEBHOOK_HOST=0.0.0.0` for a reverse proxy in Docker to reach it.
- Section 05 re-applies `/add-slack` and `slack-a2a-rooms`; `slack-agent-flow` is dropped (D7).
- Commit 7 owns `src/channels/telegram-pairing.ts` (+ test): the grammY island imports it
  (`src/channels/telegram-grammy/layers.ts:25`); it is not an `/add-telegram` re-apply.
- `container/skills/onecli-gateway/` comes from this commit's skill apply; the container section
  must not copy it from S.
- S's `debug/SKILL.md` and `docs/v1-to-v2-changes.md` grants edits: DROP, U covers them
  (`.claude/skills/debug/SKILL.md:156-157`, `docs/v1-to-v2-changes.md:83`).

## Files covered
docs/onecli-upgrades.md -> 0 (skill apply; fork copy DROP)
src/gateway-providers/installed.ts -> 0 (skill apply)
src/gateway-providers/onecli-files.test.ts -> 0 (skill apply)
src/gateway-providers/onecli-files.ts -> 0 (skill apply; fork patch DROP)
src/gateway-providers/onecli-install.test.ts -> 0 (skill apply)
src/gateway-providers/onecli.test.ts -> 0 (skill apply; fork copy DROP)
src/gateway-providers/onecli.ts -> 0 (skill apply; fork copy DROP)
