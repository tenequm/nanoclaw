# Voice-mode and /meet

Covers commit 12. Source **S2=83dc1e00** (fork `main` after the `/meet` rebuild merged as `99174d16`,
plus one fix), target U=f7440e85. Every `[COPY]` in this section comes from `83dc1e00`, not from
`098ed630`; outside the files below, S2 equals S (`git diff --stat 098ed630 83dc1e00` touches only
voice files, `package.json`, `pnpm-workspace.yaml`, `CLAUDE.md`, `docs/chat-commands.md`,
`docs/jev-gate.md` and the lockfile).

Shape of the rebuilt feature (all in the COPY set):
- Call core `src/channels/voice-mode-livekit.ts`, generic over a `CallKind`; it imports neither layer.
- `/voice` layer `voice-mode-command.ts`: the command, the page call kind, the `livekit`,
  `livekit/token` and `livekit/end` routes, `createCallPage`.
- `/meet` layer `voice-mode-meet.ts`, the Recall.ai client `meet-recall.ts` and the bridge page
  `assets/meet-recall-bridge/index.html` (the Recall bot runs it as its camera; it joins the call's
  LiveKit room as the caller).
- Shared chat plumbing `voice-mode-chat.ts`; composition root `voice-mode.ts`.
- `voice-mode-protocol.ts` is the only host-worker contract: optional `meeting` job field,
  `CallUtterance` (with `candidate` for `/meet ... jev`), the host-to-worker
  `{ type: 'status', status: 'heard' | 'thinking' | 'speaking' | 'idle' }` event (a jev voice
  call's cues); `LIVEKIT_PROTOCOL_VERSION` stays `6`.
- Worker `src/voice-mode-worker.ts`: `loadThreshold: Infinity` (never refuses a call on host CPU
  load), meeting turns are guest turns (no sender role), the acoustic wake spotter runs except in a
  `jev` meeting, and a meeting records nothing. A jev voice call records each utterance, each
  reply and (with `VOICE_MODE_CALL_RECORDING`) the whole call, and plays the listening, typing
  and your-turn cues through the shared `callCues` helper, typing held through `JevLoop.preparing`.
- Host `src/modules/meet-jev/`: `policy.ts`'s `oneCaller` block (join gap, `speak` 0.3, `continue`
  0.5) and `nameAlone` in `core/decide.ts` apply only to a voice call; `index.ts` pushes `status` to
  the worker only on a voice call, and `voice-mode-livekit.ts`'s `chatTyping`
  pushes `thinking` on the agent's typing ticks.

Depends on: 1 (`registerResidentSkillGate`), 2 (`platformMessageId`, `resolveSenderRole`, the
`senderRole` parameter of `deliverToAgent`), 3 (typing module with `notePresence`/turn state, the 7th
`startTypingRefresh` argument), 6 (`deliverToAgent` exported, `COMMANDS.voice`, `hcmd-` reply ids,
`offersVoiceCommand()`), 7 (the island's `/voice` binding, `tsconfig` `ES2023`: `voice-mode.ts` uses
`Array.prototype.findLast`), 11 (`JEV_API_KEY` in `src/config.ts`; `gateEntryFor`,
`DEFAULT_THRESHOLDS`, `renderState`, `GateHistoryRow`, `askJev`, `decide` from
`src/modules/jev-gate/`). Build it on a lane that has 1-7 and 11.

## Commit 12 - feat(voice-mode): voice and meet

### 12.1 Voice files [COPY]
**Intent:** the whole voice channel, worker, `/meet` bridge, sealed call links, wake-word models,
the `/add-voice-mode` skill (with its page source under `ui/`), the resident call-formatting skill
and the voice upgrade runbook.
**Files:** the 84 added paths matched by the pathspec below (listed under "Files covered").
**How to apply on U:** with the fork fetched, one scripted pass (binary-safe; `git show` writes the
raw blob):
```bash
S2=83dc1e00
git diff --name-only --diff-filter=A 66f0823a "${S2}" -- \
  .claude/skills/add-voice-mode assets/meet-recall-bridge assets/voice-mode-wakeword \
  container/skills/voice-mode-formatting docs/2610-07-voice-mode-upgrade.md \
  'src/channels/voice-mode*' 'src/channels/meet-recall*' src/db/voice-mode-lines.ts \
  'src/secret-seal*' 'src/voice-mode*' |
while read -r f; do mkdir -p "$(dirname "${f}")"; git show "${S2}:${f}" > "${f}"; done
```
Notes on what is copied:
- `src/secret-seal.ts` (+ test): AES-256-GCM seal/open under the host-only key
  `NANOCLAW_ENCRYPTION_KEY`, read with `envValue()` from `.env`, never from or into `process.env`, so
  containers and the worker never see it. Voice stores the call link sealed so `/voice` can show it
  again; a call is looked up by the token's SHA-256 only.
- `src/db/voice-mode-lines.ts` registers its own module migrations through U's `registerMigration()`:
  `module:voice-mode:lines`, `module:voice-mode:lines-tts`, `module:voice-mode:lines-tts-concrete`,
  `module:voice-mode:lines-link-sealed`. Keep these names and versions exactly: the live DB applied
  them under these names. No edit to `src/db/migrations/index.ts`.
- `src/channels/voice-mode-page.ts` is a generated bundle (`pnpm build` in
  `.claude/skills/add-voice-mode/ui` emits it); never edit it, its source-hash test guards it.
- `voice-mode-livekit.ts` skips `hcmd-` reply ids (commit 6's host-command replies are never spoken).
**Verify:** `pnpm exec vitest run src/channels/voice-mode*.test.ts src/voice-mode*.test.ts
src/channels/meet-recall.test.ts src/secret-seal.test.ts` (after 12.2-12.13 land).

### 12.2 Skill dependency pins [ADAPT]
**Intent:** `/add-voice-mode` installs the same versions `package.json` pins, and CI's skill-pins
check sees them.
**Files:** `.claude/skills/add-voice-mode/SKILL.md`, `.github/skill-pins/package.json`,
`.github/skill-pins/not-covered.json`.
**How to apply on U:** S2's `nc:dep` block is stale (the deps bump `4d1bffe4` changed only
`package.json`). After the COPY, replace the block's lines with the 12.3 pins (inferred fix):
```
@google/genai@2.32.0
@livekit/agents@1.9.5
@livekit/agents-plugin-elevenlabs@1.9.5
@livekit/agents-plugin-google@1.9.5
@livekit/agents-plugin-silero@1.9.5
@livekit/rtc-node@1.2.1
livekit-server-sdk@2.19.1
onnxruntime-node@1.24.3
zod@4.6.5
```
Then `pnpm run skill-pins:generate`; it adds these packages to `.github/skill-pins/package.json` and
an `npm manifest` row for `.claude/skills/add-voice-mode/ui/package.json` to `not-covered.json`. Do
not copy S2's generated files (they still carry the 1.9.2 pins).
**Verify:** `pnpm run skill-pins:check`; `rg -n '@1\.9\.2|@2\.24\.0|rtc-node@1\.1' .claude/skills/add-voice-mode/SKILL.md`
and `rg -n -A1 '"@livekit/agents"' .github/skill-pins/package.json` show only the 12.3 versions.

### 12.3 Root dependencies and worker script [MERGE]
**Intent:** host and worker deps, exact pins.
**Files:** `package.json`, `pnpm-lock.yaml`.
**How to apply on U:** add to `dependencies` (alphabetical, exact versions):
`"@google/genai": "2.32.0"`, `"@livekit/agents": "1.9.5"`, `"@livekit/agents-plugin-elevenlabs": "1.9.5"`,
`"@livekit/agents-plugin-google": "1.9.5"`, `"@livekit/agents-plugin-silero": "1.9.5"`,
`"@livekit/rtc-node": "1.2.1"`, `"livekit-server-sdk": "2.19.1"`, `"onnxruntime-node": "1.24.3"`,
`"zod": "4.6.5"` (no voice file imports `zod`; it satisfies `@livekit/agents`' peer
`zod: ^3.25.76 || ^4.1.8`). Add the script after U's `"test:watch": "vitest"`:
`"voice-mode-worker": "node dist/voice-mode-worker.js start"`. Run `pnpm install` and commit the
lockfile it writes (never S2's). `pnpm-workspace.yaml` stays U's: S's temporary
`minimumReleaseAgeExclude` block for the 1.9.2 versions is gone at S2, and `onlyBuiltDependencies`
gains nothing.
**Verify:** `pnpm install --frozen-lockfile`; `pnpm run build` emits `dist/voice-mode-worker.js`.

### 12.4 Channel registration [MERGE]
**Intent:** voice is a native channel adapter that self-registers through the barrel; everything
else hangs off its import.
**Files:** `src/channels/index.ts`.
**How to apply on U:** append after the Slack imports (commit 0/10):
```ts
// Voice - browser calls with the agent over LiveKit (/add-voice-mode).
import './voice-mode.js';
```
Importing `voice-mode.ts` (all in the COPY set) does at module load:
`registerChannelAdapter('voice-mode', { factory })` (the factory returns null, so U's registry logs
"credentials missing" and skips it, unless `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and
`VOICE_MODE_GEMINI_API_KEY` are set; bad Recall settings only turn `/meet` off);
`registerResidentSkillGate('voice-mode-formatting', ...)` (commit 1: the call-formatting skill
composes only for agents with a `voice_mode_lines` row); and, through its imports of
`voice-mode-command.ts` and `voice-mode-meet.ts`, one `registerMessageInterceptor` each for `/voice`
and `/meet` (`!voice`/`!meet` on Slack). `/meet` is an interceptor only, not a `COMMANDS` entry. HTTP
routes are registered in the adapter's `setup()`, never at import: `registerWebhookHandler('voice-mode', ...)`
(worker routes under `/webhook/voice-mode/livekit/agent/`) and `registerRootHandler('voice', ...)`
(page, token, TTS and end routes under `/voice`), plus the optional separate page listener
(`VOICE_MODE_PORT`, default 3100).
**Verify:** `pnpm exec vitest run src/channels/voice-mode-registration.test.ts`.

### 12.5 Webhook root routes [MERGE]
**Intent:** serve browser pages at a short root prefix (`/voice`) on the existing webhook server,
outside `/webhook`, so a reverse proxy forwards one prefix.
**Files:** `src/webhook-server.ts`, `src/webhook-server.test.ts`.
**How to apply on U:** U changed this file since B (it listens on `getWebhookHost()`, default
`127.0.0.1`; `getWebhookStatus()` gained `host`; an unknown adapter answers `Not found`); keep all of
that and add:
- header comment (after U:6): ` *   /{segment}[/...]       -> raw handler from registerRootHandler(segment, ...)`.
- after `const rawRoutes` (U:32): `const rootRoutes = new Map<string, RawWebhookHandler>();`.
- `getWebhookStatus()` `paths` (U:44) becomes
  ```ts
      paths: [
        ...[...new Set([...routes.keys(), ...rawRoutes.keys()])].map((p) => `/webhook/${p}`),
        ...[...rootRoutes.keys()].map((s) => `/${s}`),
      ],
  ```
  keeping U's `host: address.address` line.
- after `registerWebhookHandler` (U:119-123): `git show 83dc1e00:src/webhook-server.ts | sed -n '127,139p'`
  (the `registerRootHandler(segment, handler)` doc comment and function; it throws on `webhook` or a
  segment containing `/?#`).
- in `ensureServer`'s request handler (U:137-149):
  ```ts
        // Route: /webhook/{adapterName}, else a root route /{segment}
        const match = url.match(/^\/webhook\/([^/?]+)/);
        const segment = match ? undefined : url.match(/^\/([^/?#]+)/)?.[1];
        const rootHandler = segment === undefined ? undefined : rootRoutes.get(segment);
        if (!match && !rootHandler) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const adapterName = match?.[1] ?? segment ?? '';
  ```
  and `const rawHandler = rootHandler ?? rawRoutes.get(adapterName);`.
- `stopWebhookServer()` (after `rawRoutes.clear();`, U:203): `rootRoutes.clear();`.
- Test: keep U's file (it already sets `WEBHOOK_HOST` and expects `host`); widen its import to
  `getWebhookStatus, registerRootHandler, registerWebhookAdapter, registerWebhookHandler, stopWebhookServer, type RawWebhookHandler`
  and append S2's `describe('registerRootHandler ...')` block
  (`git show 83dc1e00:src/webhook-server.test.ts | sed -n '120,143p'`; its title has an em dash,
  write `-`).
**Verify:** `pnpm exec vitest run src/webhook-server.test.ts`.

### 12.6 Host-addressed inbound events [MERGE]
**Intent:** a voice turn is stored in one named agent's session and the caller learns whether a
session took it, so the page's "sent" mark is true.
**Files:** `src/channels/adapter.ts`.
**How to apply on U:** add `import type { Session } from '../types.js';` after the header comment
(U:6), and to `interface InboundEvent`, after `replyTo?: DeliveryAddress;` (U:76) (and after commit 7's
`materialize?`):
```ts
  /**
   * Restricts the fan-out to this one wired agent group. Set only host-side, by
   * an adapter routing a message into another chat on one agent's behalf (a
   * voice call's turns, src/channels/voice-mode-livekit.ts); never from platform input.
   */
  agentGroupId?: string;
  /**
   * Called each time the router stores the message in an agent's session, as a
   * trigger (before the wake) or as context under the `accumulate` policy, with
   * that session. Set only host-side, like `agentGroupId`.
   */
  onStored?: (session: Session) => void;
```
DROP (verified dead at S2): `ChannelSetup.routeInboundEvent?` and its `src/index.ts` line
`routeInboundEvent: (event) => inboundReady.then(() => routeInbound(event)),`. Since `51f6421d`
("direct router delivery") voice turns go through `routeVoiceModeTurn()` (`voice-mode-route.ts`),
which calls the router's exported `deliverToAgent` directly; nothing calls `routeInboundEvent`
(`git grep -n routeInboundEvent 83dc1e00 -- src` hits only its declaration and the `index.ts` line).
This supersedes section 01's commit-12 note for `adapter.ts`/`index.ts`.
**Verify:** `pnpm run build`.

### 12.7 Router [MERGE]
**Intent:** the turn's `onStored` fires once stored, and a host-made message id never gets the
reaction ack.
**Files:** `src/router.ts`, `src/router-session-created.test.ts`.
**How to apply on U:** both hunks are inside `deliverToAgent` (U:518), which commit 6 exports:
- right after the `await writeSessionMessage(session.agent_group_id, session.id, {...});` statement
  (U:604-613), before `if (wake && created) {`:
  ```ts
    // Stored is what a host-made turn waits for, whether it woke the agent or became context.
    event.onStored?.(session);
  ```
- in the `startTypingRefresh(...)` call (U:648-655), the 7th argument commit 3 added becomes:
  ```ts
        // A host-addressed event's id (livekit:<call>:<n>) is no platform message to react to.
        event.agentGroupId ? undefined : event.message.id,
  ```
DROP (verified dead at S2, same reason as 12.6): the three `routeInbound` hunks - the interceptor
loop `for (const intercept of event.agentGroupId ? [] : messageInterceptors)` and its comment, the
fan-out filter `if (event.agentGroupId && agent.agent_group_id !== event.agentGroupId) continue;`, and
the `ruleEngages = !!event.agentGroupId || (await evaluateEngage(...))` prefix. Voice turns never
enter `routeInbound`: `routeVoiceModeTurn()` resolves the one wiring itself and voice access is
checked by the call engine before every turn. This supersedes section 01's note and section 05's
"Commit 12 later prefixes `ruleEngages`"; commit 11's `ruleEngages` stays as 05 writes it.
Test: from S2's `describe('an event addressed to one agent group')` copy only the `addressed` helper
and the two cases that go through `deliverToAgent`'s hunks: `reports through onStored a turn on a
chat whose agent keeps it as context without waking` and `puts no reaction ack on its host-made
message id` (with the imports they use: `setTypingAdapter`, `stopTypingRefresh`). Drop the other four
(they assert the dropped `routeInbound` hunks); `voice-mode-route.test.ts` covers the voice path
(inferred that the two kept cases pass unchanged without the dropped hunks; if one fails, keep the
hunk it needs rather than editing the test).
`src/channels/voice-mode-call-session.test.ts` (COPY) still calls `routeInbound` with an
`agentGroupId` event (S2:100-120); the same rule applies: if it fails without a dropped hunk, keep
that hunk and record it.
**Verify:** `pnpm exec vitest run src/router-session-created.test.ts src/channels/voice-mode-route.test.ts`.

### 12.8 Wiring thread policy helper [MERGE]
**Intent:** voice resolves a stored chat's thread policy the same way the router keys it.
**Files:** `src/channels/channel-defaults.ts` (unchanged B..U).
**How to apply on U:** import `getChannelAdapter` alongside `getChannelDefaults,
hasDeclaredChannelDefaults` (U:18) and `MessagingGroupAgent` alongside `MessagingGroup` (U:20); insert
`git show 83dc1e00:src/channels/channel-defaults.ts | sed -n '142,155p'` (`wiringThreadsEnabled(wiring, mg)`)
after `resolveThreadPolicy` (before `export interface EngageValues`, U:142). Used by `voice-mode.ts`,
`voice-mode-chat.ts` and `voice-mode-route.ts`.
**Verify:** `pnpm run build`.

### 12.9 Delivery: expedited drain and outbound presentation [MERGE]
**Intent:** while a caller waits live, drain that session's outbox every 200 ms instead of the ~1 s
active poll; let the voice module mark a chat reply its call speaks without changing what is
stored.
**Files:** `src/delivery.ts`, `src/delivery.test.ts`, `src/delivery-poll.test.ts`.
**How to apply on U:**
- before `export function startActiveDeliveryPoll()` (U:176): `git show 83dc1e00:src/delivery.ts | sed -n '203,239p'`
  (`EXPEDITED_POLL_MS`, `expedited`, `expediteTimer`, exported `expediteDelivery(session, forMs)`,
  `stopExpediting()`).
- `stopDeliveryPolls()` (U:714) gains `stopExpediting();` after `sweepPolling = false;`.
- before the `Post-delivery hooks` comment block (U:563): `git show 83dc1e00:src/delivery.ts | sed -n '867,910p'`
  (`OutboundAddress`, `OutboundPresentation`, `setOutboundPresentation`, `presentOutbound`).
- the content argument of `deliveryAdapter.deliver(...)` (U:541) - the JSON string commit 2 builds
  (`deliveredContent` in section 01's snippet, `outboundContent` at S2) - is wrapped:
  ```ts
      presentOutbound(
        {
          id: msg.id,
          kind: msg.kind,
          channelType: msg.channelType,
          platformId: msg.platformId,
          threadId: msg.threadId,
          inReplyTo: msg.inReplyTo,
        },
        outboundContent,
        session,
      ),
  ```
  The stored row and the post-delivery hooks keep the original content.
- Tests: S2's `describe('expediteDelivery')` in `delivery-poll.test.ts` (with its import) and
  `describe('deliverSessionMessages - outbound presentation')` in `delivery.test.ts` (S2 title has an
  em dash) plus the `setOutboundPresentation` import.
**Verify:** `pnpm exec vitest run src/delivery.test.ts src/delivery-poll.test.ts`.

### 12.10 Wake reason reaches the runner [MERGE + ADAPT]
**Intent:** a call joining wakes the agent with reason `voice-call`, and the runner sees it as
`NANOCLAW_WAKE_REASON`, so it can start the agent before the caller's first turn.
**Files:** `src/request-wake.ts`, `src/container-runner.ts`, `src/request-wake.test.ts`,
`src/container-restart.test.ts`, `src/container-runner.test.ts`.
**How to apply on U:**
- `request-wake.ts` (unchanged B..U): take S2's file (`git diff 66f0823a 83dc1e00 -- src/request-wake.ts`
  applies cleanly): `| 'voice-call'` appended to `WakeReason` with its comment, and
  `requestWake(session, reason)` returns `wakeContainer(session, reason)`; header comment as S2.
- `container-runner.ts`: `import type { WakeReason } from './request-wake.js';` (after the
  `provider-name.js` import, U:68); `wakeContainer(session: Session, reason?: WakeReason)` (U:390) with
  S2's 3-line doc addition; `spawnContainer(session, reason)` (U:417); `async function
  spawnContainer(session: Session, wakeReason?: WakeReason)` (U:430); `wakeReason,` after
  `mailboxEnvironment,` in its `composeSessionSpec({...})` call (U:512);
  `/** Why this spawn happened, for the runner. */ wakeReason?: WakeReason;` at the end of
  `ComposeSessionSpecInput` (U:1396); in `composeSessionSpec`'s `env` after `...mailboxEnvironment,`
  (U:1422): `...(input.wakeReason && { NANOCLAW_WAKE_REASON: input.wakeReason }),`.
- ADAPT: U added an adoption-retry branch at the top of `wakeContainer` (U:395-407) that re-wakes
  with `wakeContainer(current)`; pass the reason through: `wakeContainer(current, reason)` (inferred,
  not in S2).
- Tests: `request-wake.test.ts` mock `wakeContainer: (session: Session, reason?: string) => wakeContainer(session, reason)`
  and `toHaveBeenCalledWith(session, 'inbound-message')`; `container-restart.test.ts:128`
  `toHaveBeenCalledWith(freshSession, 'container-restart')`; `container-runner.test.ts` S2's case
  `tells the runner why it was woken, when the wake said` in `describe('composeSessionSpec')`.
**Verify:** `pnpm exec vitest run src/request-wake.test.ts src/container-restart.test.ts src/container-runner.test.ts`.

### 12.11 Per-agent vocabulary file read [MERGE]
**Intent:** `voice-mode-line.ts` reads the agent's `voice.vocabulary.txt` with the same hardened,
bounded reader as the persona file.
**Files:** `src/group-persona.ts`.
**How to apply on U:** on top of commit 1's hardening (section 01, 1.3), change the signature to
`readGroupPersona(groupDir: string, fileName: string = PERSONA_PREPEND_FILE)` and
`const file = path.join(groupDir, fileName);`.
**Verify:** `pnpm exec vitest run src/group-persona.test.ts`.

### 12.12 Typing observers [MERGE] (D11)
**Intent:** the call hears the agent "thinking" from the chat's typing ticks, including the moment
the runner picks the turn up.
**Files:** `src/modules/typing/index.ts`, `src/modules/typing/index.test.ts`.
**How to apply on U:** re-add on top of commit 3's module what section 02 (3.6) removed:
- `git show 83dc1e00:src/modules/typing/index.ts | sed -n '202,252p'` (`TypingTick`, `TypingObserver`,
  `typingObservers`, `registerTypingObserver`, `workingSinceInbound`, `notifyObservers`) after
  `signalFailed`.
- `notifyObservers(entry);` as the first line of `paintSignal` and, after the `capped` return, of
  `refresh` (commit 3's `refresh(entry)`).
- in `notePresence`, around `entry.presence = report;`:
  ```ts
    const pickedUp = workingSinceInbound(entry);
    entry.presence = report;
    // Observers hear the pickup at once, not on the next refresh tick; nothing is painted.
    if (!pickedUp && !entry.capped && entry.pausedUntil <= Date.now() && workingSinceInbound(entry))
      notifyObservers(entry);
  ```
- header: "One observer hook (registerTypingObserver) lets the voice channel follow a chat's ticks."
- Test: S2's `describe('typing observers')` (S2:682), minus any `status` fields commit 3 dropped.
**Verify:** `pnpm exec vitest run src/modules/typing/index.test.ts`.

### 12.13 Runner voice prewarm [MERGE + ADAPT]
**Intent:** a container woken for a call opens the agent query with no turn, so the caller's first
turn is pushed into a warm SDK.
**Files:** `runner:poll-loop.ts`, `runner:providers/{types,claude,mock}.ts`,
`runner:providers/claude.idle-start.test.ts` [COPY from S2], `runner:integration.test.ts`
(`runner:` = `container/agent-runner/src/`). Section 02's cross-section list for commit 12 is the
item list; S2 equals S in these files. Anchors:
- `runQuery(config, continuation, midTurnCompleteDelivery, prompt, routing, batchIds)`: extract U's
  inline query block (U:242-305, from `const query = config.provider.query({` through the `finally`)
  into S2's function (`git show 83dc1e00:container/agent-runner/src/poll-loop.ts | sed -n '277,348p'`),
  returning the continuation; the main loop calls it where the block was (S2:268) and keeps
  `markCompleted(processingIds)` after it. ADAPT: keep U's catch log
  `log(\`Query error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\`);` (U:283,
  from #4118), not S2's `errMsg` line; keep S2's `if (batchIds.length > 0)` guard around the
  "Errored batch" log (an idle start has no batch).
- `startForCall` (S2:133-136 before the loop, S2:150-157 inside `if (messages.length === 0)`, and
  `startForCall = false;` right after that block): reads
  `process.env.NANOCLAW_WAKE_REASON === 'voice-call' && config.provider.startsIdle === true`.
- `processQuery`: `let batchIds = initialBatchIds; let adoptsInitialBatch = initialPrompt === '';`
  with S2's comment (S2:414-418); the follow-up push branch adopts the first pushed batch
  (`if (adoptsInitialBatch) { adoptsInitialBatch = false; batchIds = keptIds; } else markCompleted(keptIds);`,
  U:550); the result branch marks `batchIds` (U:618 `markCompleted(initialBatchIds)`); the `finally`
  adds `if (batchIds !== initialBatchIds) markCompleted(batchIds);` before `enterIdle()`.
- `providers/types.ts`: `readonly startsIdle?: boolean;` with S2's doc comment after
  `query(input: QueryInput): AgentQuery;` (U:35). `claude.ts`: `readonly startsIdle = true;` first in
  the class (U:211) and `if (input.prompt) stream.push(input.prompt);` with its comment (U:266).
  `mock.ts`: `readonly startsIdle = true;` and S2's idle start around "Process initial prompt" (U:62).
- Tests: copy `claude.idle-start.test.ts`; add S2's `describe('poll loop - started ahead of a voice call')`
  (S2 `integration.test.ts:373`, em dash in the title).
**Verify:** `cd container/agent-runner && bun test src/providers/claude.idle-start.test.ts src/integration.test.ts`.

### 12.14 Composer test cases [MERGE]
**Intent:** prove `voice-mode-formatting` composes only for agents with a line.
**Files:** `src/project-doc-compose.test.ts`.
**How to apply on U:** on top of commits 1-11's version add S2's imports
`import { createVoiceModeLine } from './db/voice-mode-lines.js';` and `import './channels/voice-mode.js';`,
`const VOICE_SECTION = 'NanoClaw Skill: voice-mode-formatting';` and the three cases (S2:438-471):
`composes voice-mode-formatting for an agent with a voice-mode line`, `leaves voice-mode-formatting
out for an agent wired only to a \`voice\` chat from before the rename`, `leaves voice-mode-formatting
out for a non-voice agent on the "all" selection`. They use the `seed`/`wire`/`realSkill`/
`composedSection` helpers that commits 7-11 bring in.
**Verify:** `pnpm exec vitest run src/project-doc-compose.test.ts`.

### 12.15 Docs [MERGE]
**Intent:** document sealed secrets, the idle-start provider contract, `/meet`, and Jev in meetings.
**Files:** `docs/SECURITY.md`, `docs/agent-runner-details.md`, `docs/chat-commands.md`,
`docs/jev-gate.md`, `.gitignore` (the runbook `docs/2610-07-voice-mode-upgrade.md` is in 12.1).
**How to apply on U:**
- `docs/SECURITY.md`: insert `git show 83dc1e00:docs/SECURITY.md | sed -n '218,234p'`
  (`### 6. Sealed Host Secrets`) before `## Resource Limits` (U:243).
- `docs/agent-runner-details.md`: the `readonly startsIdle?: boolean;` member with its comment after
  `query(input: QueryInput): AgentQuery;` (U:33), and S2's longer **Idle behavior** paragraph replacing
  U:454 (the two hunks of `git diff 66f0823a 83dc1e00 -- docs/agent-runner-details.md`; U moved
  them by one line).
- `docs/chat-commands.md` (commit 6 copied it from S with the `/voice` row): add S2's `/meet` row
  after the `/voice` row (`git show 83dc1e00:docs/chat-commands.md | sed -n '16p'`).
- `docs/jev-gate.md` (commit 11 copied it from S): insert S2's `## Meetings (\`/meet <link> jev\`)`
  section before `## Kill switch` (`git show 83dc1e00:docs/jev-gate.md | sed -n '75,99p'`): meeting
  candidates are judged on the host by the meeting call kind with the same rubric and `decide()`;
  addressed turns never wait on Jev; fail-silent; thresholds from the group's gate entry or defaults.
- `.gitignore`: append `.voice-mode-upgrade-backup/` (after U's last block).
**Verify:** `rg -n 'Sealed Host Secrets|startsIdle|/meet <link>|## Meetings' docs`.

### 12.16 Not in the rebuild [DROP]
**Intent:** the `/meet` rebuild removed these; nothing is ported.
**Files:** none at S2.
**How to apply on U:** do not port the Attendee bridge, `MEET_PROVIDER`, `ATTENDEE_*`, the meeting
front desk (`VOICE_MODE_MEET_FRONTDESK`, `VOICE_MODE_FRONTDESK_*`), `VOICE_MODE_WORKER_MAX_JOBS`, or
`wakeInFinal` / `wake_only`. Checked at S2: `git grep -n -i -E 'attendee|MEET_PROVIDER|frontdesk|front desk|VOICE_MODE_WORKER_MAX_JOBS|wakeInFinal|wake_only' 83dc1e00 -- . ':!pnpm-lock.yaml'`
finds none of them in voice code (only an unrelated "attendee list" fixture in
`src/channels/slack-raw-text.test.ts`). The page's `wakeOnly` caption flag (`ui/src/App.tsx`,
`ui/src/lib/livekit-call.ts`, `ui/src/lib/voice-call.ts`, the generated `voice-mode-page.ts`) predates
the rebuild (present at `098ed630`) and marks a transcript line that was only the wake phrase; it is
not the dropped worker `wake_only` and is copied as is.
**Verify:** the same grep on the replayed tree returns nothing outside `slack-raw-text.test.ts`.

### Deploy note
The worker reaches the host on loopback (`LIVEKIT_HOST_URL`, default `http://127.0.0.1:<WEBHOOK_PORT>`;
anything but a local plain-http origin is refused because every request carries call secrets). U's
webhook server binds `WEBHOOK_HOST`, default `127.0.0.1`. An install whose reverse proxy reaches the
webhook server from outside loopback (for example a proxy in a container) must set
`WEBHOOK_HOST=0.0.0.0`; binding only a bridge address breaks the worker. Never proxy the worker routes
(`/webhook/voice-mode/livekit/agent/`): a worker request carrying `X-Forwarded-For`/`Forwarded` is
refused. Restart host and worker together; they must be the same build (protocol 6). Cutover checks:
a `/voice` call (wake, send, reply, hangup) and a `/meet` join on Telegram and on Slack (`!meet`); that
`/meet` reaches the router's interceptors through the Telegram island is inferred, not tested here.

## Cross-section notes

- **01:** its "Commit 12" list is superseded here: `package.json` pins are 12.3's (not 2.24.0/1.9.2/1.1.0);
  `routeInboundEvent` and the three `routeInbound` hunks are DROP (12.6, 12.7); everything else it
  lists is placed in 12.5-12.15. `CLAUDE.md`'s `## Chat Commands` wording for `/voice` and `/meet`
  (S2 `CLAUDE.md:126`, the whole paragraph) lands in **commit 14** per the commit plan, not 12 as 01's
  6.x note says; commit 6 can carry S's paragraph without it or with it, the text is prose only.
- **02:** commit 12 owns the typing observers (12.12) and the runner prewarm (12.13) exactly as 02's
  commit-12 list says, with U's `err.stack` log kept.
- **03:** `/voice` on Telegram is commit 7's native binding (calls `handleVoiceCommand` on the
  `voice-mode` adapter with a sender-only reply, else imports `../../voice-mode-command.js`);
  `offersVoiceCommand()` and `fallback.ts`'s drop of `/voice` are commit 6's. `/meet` needs nothing
  from 6/7: it is a router interceptor.
- **04:** commit 12 reruns `pnpm run skill-pins:generate` (12.2); `.claude/skills/add-pond/pond-recall-container-skill.md`
  and `container/skills/pond-recall/SKILL.md` match this section's file filter but are commit 8's.
- **05:** the `/meet ... jev` path reuses commit 11's exports (`gateEntryFor`, `DEFAULT_THRESHOLDS`,
  `renderState`, `askJev`, `decide`) and `JEV_API_KEY`; without the key `/meet ... jev` is refused.
  Drop 05's "Commit 12 later prefixes `ruleEngages`" (12.7). `docs/jev-gate.md` gains the Meetings
  section in commit 12 (12.15).
- **Index:** the commit-12 row can drop "(pending)"; this section's COPY source is `83dc1e00`, and
  "Fork HEAD at generation" should move to it.

## Files covered

```
.claude/skills/add-pond/pond-recall-container-skill.md -> 8 (pond recall; matched the file filter only)
.claude/skills/add-voice-mode/REMOVE.md -> 12
.claude/skills/add-voice-mode/SKILL.md -> 12 (12.1 COPY, then 12.2 nc:dep fix)
.claude/skills/add-voice-mode/apply-fixtures.json -> 12
.claude/skills/add-voice-mode/ui/.gitignore -> 12
.claude/skills/add-voice-mode/ui/THIRD_PARTY_NOTICES.md -> 12
.claude/skills/add-voice-mode/ui/components.json -> 12
.claude/skills/add-voice-mode/ui/index.html -> 12
.claude/skills/add-voice-mode/ui/package.json -> 12
.claude/skills/add-voice-mode/ui/pnpm-lock.yaml -> 12
.claude/skills/add-voice-mode/ui/pnpm-workspace.yaml -> 12
.claude/skills/add-voice-mode/ui/scripts/emit-page.mjs -> 12
.claude/skills/add-voice-mode/ui/source-files.json -> 12
.claude/skills/add-voice-mode/ui/src/App.tsx -> 12
.claude/skills/add-voice-mode/ui/src/assets/fonts/HankenGrotesk.woff2 -> 12
.claude/skills/add-voice-mode/ui/src/assets/fonts/IBMPlexMono-400.woff2 -> 12
.claude/skills/add-voice-mode/ui/src/assets/fonts/IBMPlexMono-500.woff2 -> 12
.claude/skills/add-voice-mode/ui/src/assets/nanoclaw-logo.png -> 12
.claude/skills/add-voice-mode/ui/src/components/StreamText.tsx -> 12
.claude/skills/add-voice-mode/ui/src/components/ui/avatar.tsx -> 12
.claude/skills/add-voice-mode/ui/src/components/ui/bar-visualizer.tsx -> 12
.claude/skills/add-voice-mode/ui/src/components/ui/button.tsx -> 12
.claude/skills/add-voice-mode/ui/src/components/ui/conversation.tsx -> 12
.claude/skills/add-voice-mode/ui/src/components/ui/matrix.tsx -> 12
.claude/skills/add-voice-mode/ui/src/components/ui/message.tsx -> 12
.claude/skills/add-voice-mode/ui/src/components/ui/shimmering-text.tsx -> 12
.claude/skills/add-voice-mode/ui/src/index.css -> 12
.claude/skills/add-voice-mode/ui/src/lib/config.ts -> 12
.claude/skills/add-voice-mode/ui/src/lib/demo-call.ts -> 12
.claude/skills/add-voice-mode/ui/src/lib/livekit-call.ts -> 12
.claude/skills/add-voice-mode/ui/src/lib/review.ts -> 12
.claude/skills/add-voice-mode/ui/src/lib/utils.ts -> 12
.claude/skills/add-voice-mode/ui/src/lib/voice-call.ts -> 12
.claude/skills/add-voice-mode/ui/src/lib/voice-endpoint.ts -> 12
.claude/skills/add-voice-mode/ui/src/main.tsx -> 12
.claude/skills/add-voice-mode/ui/src/vite-env.d.ts -> 12
.claude/skills/add-voice-mode/ui/tsconfig.app.json -> 12
.claude/skills/add-voice-mode/ui/tsconfig.json -> 12
.claude/skills/add-voice-mode/ui/tsconfig.node.json -> 12
.claude/skills/add-voice-mode/ui/vite.config.ts -> 12
assets/meet-recall-bridge/index.html -> 12
assets/voice-mode-wakeword/LICENSE -> 12
assets/voice-mode-wakeword/NOTICE -> 12
assets/voice-mode-wakeword/embedding_model.onnx -> 12
assets/voice-mode-wakeword/hey_livekit.onnx -> 12
assets/voice-mode-wakeword/melspectrogram.onnx -> 12
container/skills/pond-recall/SKILL.md -> 8 (pond recall; matched the file filter only)
container/skills/voice-mode-formatting/instructions.md -> 12
docs/2610-07-voice-mode-upgrade.md -> 12
src/channels/meet-recall.test.ts -> 12
src/channels/meet-recall.ts -> 12
src/channels/voice-mode-adapter.test.ts -> 12
src/channels/voice-mode-call-session.test.ts -> 12
src/channels/voice-mode-chat.ts -> 12
src/channels/voice-mode-command.test.ts -> 12
src/channels/voice-mode-command.ts -> 12
src/channels/voice-mode-line-roles.test.ts -> 12
src/channels/voice-mode-line.ts -> 12
src/channels/voice-mode-livekit.test.ts -> 12
src/channels/voice-mode-livekit.ts -> 12
src/channels/voice-mode-meet.test.ts -> 12
src/channels/voice-mode-meet.ts -> 12
src/channels/voice-mode-page.test.ts -> 12
src/channels/voice-mode-page.ts -> 12
src/channels/voice-mode-protocol.ts -> 12
src/channels/voice-mode-registration.test.ts -> 12
src/channels/voice-mode-review-page.test.ts -> 12
src/channels/voice-mode-route.test.ts -> 12
src/channels/voice-mode-route.ts -> 12
src/channels/voice-mode-tts-catalog.test.ts -> 12
src/channels/voice-mode-tts-catalog.ts -> 12
src/channels/voice-mode-tts.fixtures.json -> 12
src/channels/voice-mode.ts -> 12
src/db/voice-mode-lines.ts -> 12
src/secret-seal.test.ts -> 12
src/secret-seal.ts -> 12
src/voice-mode-gemini-live.test.ts -> 12
src/voice-mode-gemini-live.ts -> 12
src/voice-mode-tts.test.ts -> 12
src/voice-mode-tts.ts -> 12
src/voice-mode-wakeword-fixtures/negative.wav -> 12
src/voice-mode-wakeword-fixtures/positive.wav -> 12
src/voice-mode-wakeword.test.ts -> 12
src/voice-mode-wakeword.ts -> 12
src/voice-mode-worker.test.ts -> 12
src/voice-mode-worker.ts -> 12
src/webhook-server.test.ts -> 12 (12.5 MERGE)
src/webhook-server.ts -> 12 (12.5 MERGE)

# Shared files with voice hunks (owned by other sections; commit 12 parts placed above)
package.json -> 12 (12.3 deps and worker script; other deps per sections 00/01/03)
pnpm-lock.yaml -> 12 (regenerated by pnpm install, never copied)
pnpm-workspace.yaml -> DROP (S release-age exclusions gone at S2; keep U)
.github/skill-pins/package.json -> 12 (regenerated, 12.2)
.github/skill-pins/not-covered.json -> 12 (regenerated, 12.2)
src/channels/index.ts -> 12 (12.4)
src/channels/adapter.ts -> 12 (12.6: Session import, agentGroupId, onStored); routeInboundEvent DROP
src/index.ts -> routeInboundEvent DROP (12.6); nothing for 12
src/router.ts -> 12 (12.7: onStored, typing-ack guard); routeInbound agentGroupId hunks DROP
src/router-session-created.test.ts -> 12 (12.7, two of six cases)
src/channels/channel-defaults.ts -> 12 (12.8)
src/delivery.ts -> 12 (12.9)
src/delivery.test.ts -> 12 (12.9 outbound presentation)
src/delivery-poll.test.ts -> 12 (12.9 expediteDelivery)
src/request-wake.ts -> 12 (12.10)
src/request-wake.test.ts -> 12 (12.10)
src/container-runner.ts -> 12 (12.10 wake reason)
src/container-runner.test.ts -> 12 (12.10)
src/container-restart.test.ts -> 12 (12.10)
src/group-persona.ts -> 12 (12.11 fileName); hardening is 1
src/modules/typing/index.ts -> 12 (12.12 observers)
src/modules/typing/index.test.ts -> 12 (12.12 typing observers block)
container/agent-runner/src/poll-loop.ts -> 12 (12.13)
container/agent-runner/src/providers/types.ts -> 12 (12.13 startsIdle)
container/agent-runner/src/providers/claude.ts -> 12 (12.13 startsIdle, empty prompt)
container/agent-runner/src/providers/mock.ts -> 12 (12.13)
container/agent-runner/src/providers/claude.idle-start.test.ts -> 12 (12.13 COPY)
container/agent-runner/src/integration.test.ts -> 12 (12.13 voice-call block)
src/project-doc-compose.test.ts -> 12 (12.14 three cases)
docs/SECURITY.md -> 12 (12.15 Sealed Host Secrets)
docs/agent-runner-details.md -> 12 (12.15)
docs/chat-commands.md -> 12 (12.15 /meet row); /voice row is 6
docs/jev-gate.md -> 12 (12.15 Meetings section); rest is 11
.gitignore -> 12 (.voice-mode-upgrade-backup/)
CLAUDE.md -> 14 (/voice and /meet wording in Chat Commands)
```
