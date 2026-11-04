# Agent-runner and typing

Covers commits: 3, 4. Source S=098ed630, target U=f7440e85.

Paths under `container/agent-runner/src/` are written as `runner:<path>`. U line numbers are from
`git show f7440e85:<path>`. Snippets are from S; their comments were made ASCII-only (S has em dashes
and ellipses in these comments, and they must not be copied in).

## Commit 3 - Turn state and typing

Replay upstream PR [#3786](https://github.com/nanocoai/nanoclaw/pull/3786), which is still open, but
without its status-text half: no runner anywhere writes `live_status` (in S, only
`src/delivery.ts:357` reads it). Then add the fork's typing extras. The voice observers belong to
commit 12 (D11).

### 3.1 Turn state in the mailbox model [MERGE]
**Intent:** the container record carries the runner's own turn report (`working` / `idle` / `null` = not reported), so typing can follow the turn instead of guessing from the heartbeat file.
**Files:** `src/mailbox/model.ts`, `runner:mailbox/model.generated.ts`, `src/mailbox/model.test.ts`.
**How to apply on U:** edit `src/mailbox/model.ts` only (U has not changed it since B). The S hunks apply verbatim:
- `const TURN_STATES = ['working', 'idle'] as const;` and `export type TurnState = (typeof TURN_STATES)[number];`, placed after `export type InboundKind`.
- `turn: TurnState | null;` in `interface ContainerRecord`, placed before `updatedAt`.
- the helper `optionalNullableOneOf`, placed after `function oneOf`:
```ts
/** A field added after records were first persisted: absent or null both read as null. */
function optionalNullableOneOf<const T extends readonly string[]>(
  record: UnknownRecord,
  key: string,
  values: T,
): T[number] | null {
  if (!(key in record) || record[key] === undefined || record[key] === null) return null;
  return oneOf(record, key, values);
}
```
- `parseContainerRecord`: add `'turn'` to the `strictRecord` key list, and `turn: optionalNullableOneOf(record, 'turn', TURN_STATES),` to the returned object.

Then run `pnpm mailbox-model:generate`. That command is a plain `cp` into `runner:mailbox/model.generated.ts`; never hand-edit the generated file. From S's `src/mailbox/model.test.ts`, copy the `describe('container record turn state')` block.
**Verify:** `pnpm mailbox-model:check`; `pnpm vitest run src/mailbox/model.test.ts`.

### 3.2 Runner writes the turn [MERGE]
**Intent:** the runner's SQLite mailbox gets `markContainerTurn(turn)`. It writes `turn` and `updated_at` only, never the tool-in-flight fields. `container_state` gains a `turn` column, added with a guarded ALTER on old files.
**Files:** `runner:mailbox/sqlite/connection.ts`, `runner:mailbox/sqlite/index.ts`, `runner:mailbox/types.ts`, `runner:db/container-state.ts`, `runner:mailbox/sqlite/sqlite.test.ts`.
**How to apply on U:**
- `runner:mailbox/sqlite/connection.ts`. U rewrote this file (`readInbound`, busy_timeout first, a `path` parameter on `getOutboundDb`), so re-apply by hand:
  - In `getOutboundDb()`'s `CREATE TABLE IF NOT EXISTS container_state`, add `turn TEXT,` before `updated_at`.
  - Right after that `exec`, add:
```ts
    const containerCols = new Set(
      (_outbound.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!containerCols.has('turn')) {
      _outbound.exec('ALTER TABLE container_state ADD COLUMN turn TEXT');
    }
```
  - Add `sqliteMarkContainerTurn` after `sqliteSetContainerToolInFlight`:
```ts
/**
 * Record the runner's turn state. Only `turn` and `updated_at` move: the
 * tool-in-flight fields belong to the PreToolUse/PostToolUse hooks and must
 * survive a turn re-mark that lands while a tool is running.
 */
export function sqliteMarkContainerTurn(turn: 'working' | 'idle'): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, turn, updated_at)
       VALUES (1, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         turn = excluded.turn,
         updated_at = excluded.updated_at`,
    )
    .run(turn, now);
}
```
  - Add `turn TEXT,` to `initTestSessionDb()`'s `container_state` table.
  - U already sets busy_timeout before the first schema read (a6964d07), so this ALTER waits for the lock instead of throwing SQLITE_BUSY.
- `runner:mailbox/sqlite/index.ts` (U:1-7 imports, U:219-234 class tail):
  - import `sqliteMarkContainerTurn` from `./connection.js`, and type `TurnState` from `../types.js`.
  - in `setContainerToolInFlight`, add `turn: null,` to the `parseContainerRecord({...})` argument (it is now a strict key).
  - after `clearContainerToolInFlight = ...`, add:
```ts
  markContainerTurn(turn: TurnState): void {
    const record = parseContainerRecord({
      currentTool: null,
      toolDeclaredTimeoutMs: null,
      toolStartedAt: null,
      turn,
      updatedAt: new Date().toISOString(),
    });
    sqliteMarkContainerTurn(record.turn!);
  }
```
- `runner:mailbox/types.ts`:
  - import and re-export `TurnState` from `./model.generated.js`.
  - add to `MailboxOperations`, after `clearContainerToolInFlight(): void;`:
    `/** Record whether the runner is inside a turn. Writes turn and stamps updated_at; tool fields untouched. */ markContainerTurn(turn: TurnState): void;`
- `runner:db/container-state.ts`: add
  `export function markContainerTurn(turn: 'working' | 'idle'): void { getAgentMailbox().operations.markContainerTurn(turn); }`
- `runner:mailbox/sqlite/sqlite.test.ts`:
  - copy S's `describe('SQLite runner mailbox turn state')` block.
  - copy the two-line assertion after the tool-in-flight check in the canonical-serialization test: `// A tool-in-flight write leaves the turn alone.` and `expect(outbound.prepare('SELECT turn FROM container_state').get()).toEqual({ turn: null });`.
**Verify:** `cd container/agent-runner && bun test src/mailbox/sqlite/sqlite.test.ts`.

### 3.3 Poll loop reports the turn [MERGE]
**Intent:** the poll loop is the one place that knows when a turn starts and ends. It marks `working` when it starts answering, re-marks it every 5 s, and marks `idle` when it goes back to waiting and on loop exit. Every write is best-effort.
**Files:** `runner:poll-loop.ts`, `runner:poll-loop.turn-state.test.ts`.
**How to apply on U** (`runner:poll-loop.ts`):
- U:10: import `markContainerTurn` beside `clearStaleProcessingAcks`.
- After `const ACTIVE_POLL_INTERVAL_MS = 500;` (U:39), add:
```ts
/**
 * While a turn runs, re-mark it 'working' this often so the container_state
 * row's updated_at keeps moving through a long generation. The host treats a
 * 'working' report as stale after three of these, so it must be well under
 * that window.
 */
const WORKING_REMARK_MS = 5000;
```
- In `processQuery`, right after `let answering = initialPrompt !== '';` (U:427), add the S block without its `providerPushes` lines (those come in commit 4):
```ts
  // Report the turn state to the runner-owned mailbox so the host's typing
  // indicator follows it (working while a turn runs, idle when it ends)
  // instead of guessing from the heartbeat file. Best-effort throughout: a
  // failed write logs and never breaks the loop.
  let workingRemark: ReturnType<typeof setInterval> | null = null;
  const markTurn = (turn: 'working' | 'idle'): void => {
    try {
      markContainerTurn(turn);
    } catch (err) {
      log(`Turn-state mark (${turn}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const enterWorking = (): void => {
    markTurn('working');
    if (!workingRemark) {
      workingRemark = setInterval(() => markTurn('working'), WORKING_REMARK_MS);
      // unref so a lingering re-mark timer can't hold the process alive.
      workingRemark.unref?.();
    }
  };
  const enterIdle = (): void => {
    if (workingRemark) {
      clearInterval(workingRemark);
      workingRemark = null;
    }
    markTurn('idle');
  };
  // An initial prompt means the turn is already running when we get here.
  if (answering) enterWorking();
```
- In `adoptTurn` (U:439): add `enterWorking();` after `answering = true;`.
- At the turn boundary (U:711-713): replace `else answering = false;` with `else { answering = false; enterIdle(); }`.
- In the outer `finally` (U:761-764): add `enterIdle();` after `clearInterval(pollHandle);`, with the comment `// Clean loop exit: stop the re-mark timer and report idle. Idempotent with the turn-boundary idle.`
- Copy `runner:poll-loop.turn-state.test.ts` from S, leaving out the two coalescing tests (`reports idle when two pushed prompts coalesce into one result` and `after a coalesced result the next push answers on its own route...`) and the `CoalescingProvider` class. Commit 4 adds them back.
**Verify:** `bun test src/poll-loop.turn-state.test.ts src/poll-loop*.test.ts`.

### 3.4 Host reads the turn on the delivery poll [MERGE]
**Intent:** the host reads the runner's report on the delivery poll it already runs (no new session, no new poll) and hands it to the typing module. The status-text read is not replayed.
**Files:** `src/mailbox/sqlite/schema.ts`, `src/mailbox/sqlite/session-db.ts`, `src/mailbox/sqlite/index.ts`, `src/mailbox/types.ts`, `src/mailbox/index.ts`, `src/delivery.ts`, `src/host-sweep.test.ts`, `src/mailbox/sqlite/sqlite.test.ts`, `src/delivery.test.ts`, `docs/db-session.md`. All of these are in the core file list; their turn hunks belong here.
**How to apply on U:**
- `schema.ts`: add `turn TEXT,` to `OUTBOUND_SCHEMA`'s `container_state`. The `idx_delivered_platform_message` index in the same S diff belongs to commit 2.
- `session-db.ts`:
  - add `turn: string | null;` to `interface ContainerState`.
  - replace `getContainerState` (U:203-216) with S's `SELECT *` plus per-field version. It tolerates an old table that has no `turn` column:
```ts
    const row = outDb.prepare('SELECT * FROM container_state WHERE id = 1').get() as
      | (Partial<ContainerState> & { updated_at: string })
      | undefined;
    if (!row) return null;
    return {
      current_tool: row.current_tool ?? null,
      tool_declared_timeout_ms: row.tool_declared_timeout_ms ?? null,
      tool_started_at: row.tool_started_at ?? null,
      turn: row.turn ?? null,
      updated_at: row.updated_at,
    };
```
  - Do NOT add `getSessionState` (status text only). `getReplyTarget` and `openOutboundDbRw(options)` belong to other commits.
- `src/mailbox/sqlite/index.ts`, in `getContainerState` (U:338-352): add `turn: row.turn,` to the `parseContainerRecord` input, and `turn: record.turn, updatedAt: record.updatedAt,` to the return. Skip S's `getState` and `parseStateRecord` additions.
- `src/mailbox/types.ts`:
  - change `export type ContainerState = Omit<ContainerRecord, 'updatedAt'>;` (U:55) to `export type ContainerState = ContainerRecord;` with the comment `tool in flight (sweep tolerance) plus the runner's turn report and its stamp (typing indicator)`.
  - re-export `TurnState` from `./model.js`.
  - skip `StateValue` and `getState?`.
- `src/mailbox/index.ts`: add `TurnState` to the type re-export list (not `StateValue`).
- `src/delivery.ts`:
  - import `notePresence` from `./modules/typing/index.js` (U:36).
  - add the S helper `readPresence` before `deliverSessionMessages` (U:242):
```ts
/**
 * A presence read only drives the typing indicator, so a runner row that
 * fails to parse (version skew, a turn state this host does not know) reads
 * as "not reported" instead of failing the session's whole delivery.
 */
function readPresence<T>(sessionId: string, read: () => T): T | undefined {
  try {
    return read();
  } catch (err) {
    log.debug('Presence read failed', { sessionId, err: String(err) });
    return undefined;
  }
}
```
  - in `drainSession` (U:268-276), add `containerState: readPresence(session.id, () => mailbox.getContainerState()),` to the returned object. After `({ delivered, pending } = existing);`, add:
```ts
    // Typing follows the runner's presence. A missing record or a null turn
    // (older runner) reads as "not reported" and keeps the heartbeat fallback.
    const { containerState } = existing;
    notePresence(session.id, {
      turn: containerState?.turn ?? null,
      updatedAtMs: containerState ? Date.parse(containerState.updatedAt) : null,
    });
```
  - in `interface ChannelDeliveryAdapter` (U:110, after `setTyping?`), add:
    - `clearTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;`
    - `addReaction?(channelType: string, platformId: string, messageId: string, emoji: string, instance?: string): Promise<void>;`
    - `removeReaction?(...)`, with the same signature as `addReaction`.
    - `typingRequiresThread?(channelType: string, instance?: string): boolean;`
    - `resolveReaction`, `threadsReplies` and `inReplyTo` belong to commits 7 and 2.
- `src/host-sweep.test.ts`: the two `decideStuckAction` fixtures with `currentTool: 'Bash'` gain `turn: null,` and an `updatedAt` equal to their `toolStartedAt`. `ContainerState` now includes both fields.
- Tests:
  - from S's `src/mailbox/sqlite/sqlite.test.ts`, copy `reads a container_state row written before the turn column existed` and `returns null when the row was never written`.
  - from S's `src/delivery.test.ts`, copy `reads the runner turn report on the poll and forwards it to the typing module`, `a turn report that fails to parse reads as not reported and never blocks delivery` and `forwards a not-reported turn (no container_state row) as null`. Remove every `status` expectation from them.
- `docs/db-session.md` section 4.4: copy S's two-bullet description and the `turn` column line. Write it ASCII-only.
**Verify:** `pnpm vitest run src/delivery.test.ts src/host-sweep.test.ts src/mailbox`; `pnpm run build`.

### 3.5 Channel clear and reaction primitives [MERGE]
**Intent:** some platforms keep the indicator painted until it is cleared explicitly (Slack's assistant status stays until a post or a 2-minute timeout). A platform that paints only inside threads gets an eyes-reaction ack in threadless chats instead.
**Files:** `src/channels/adapter.ts`, `src/channels/channel-registry.ts`, `src/channels/chat-sdk-bridge.ts`, and their tests. These are core-list files.
**How to apply on U:**
- `adapter.ts`, after `setTyping?` (U:243-248), add from S:
  - `clearTyping?(platformId: string, threadId: string | null): Promise<void>;`
  - `typingRequiresThread?: boolean;`
  - `addReaction?(platformId: string, messageId: string, emoji: string): Promise<void>;`
  - `removeReaction?(platformId: string, messageId: string, emoji: string): Promise<void>;`
  - Carry S's doc comments as ASCII. The other S hunks (`routeInboundEvent`, `materialize`, `agentGroupId`, `onStored`, `ResolvedReaction`, `threadsReplies`) belong to other commits.
- `channel-registry.ts`, in `createChannelDeliveryAdapter` after `setTyping` (U:116-126), add the S methods:
  - `clearTyping`, `addReaction` and `removeReaction`, each resolving `getChannelAdapterExact(instance ?? channelType)` and calling the adapter method with the channel and instance dropped.
  - `typingRequiresThread(channelType, instance) { return getChannelAdapterExact(instance ?? channelType)?.typingRequiresThread === true; }`
- `chat-sdk-bridge.ts`:
  - add S's `MAX_STATUS_TEXT_LENGTH` and the exported `normalizeStatusText`, written ASCII with `...` instead of the ellipsis character. Commit 10's Slack wrapper still passes a default status line through it.
  - replace `setTyping` (U:1098-1101) with S's `setTyping(platformId, threadId, status?)`, which calls `adapter.startTyping(tid, text || undefined)`.
  - add S's `addReaction`, `removeReaction` and the generic `clearTyping` (the `setAssistantStatus` / `decodeThreadId` probe).
- Tests:
  - from S's `channel-registry.test.ts`: `dispatches clearTyping to the exact adapter instance, like setTyping`.
  - from S's `chat-sdk-bridge.test.ts`: the `setTyping passes a status line...`, `normalizeStatusText caps...` and three `clearTyping ...` cases, plus `describe('createChatSdkBridge - typing and reaction primitives')`.
**Verify:** `pnpm vitest run src/channels/channel-registry.test.ts src/channels/chat-sdk-bridge.test.ts`.

### 3.6 Typing module follows the turn, with fork extras [ADAPT]
**Intent:** keep typing on while the runner reports a fresh `working` turn, including during long tool runs. U's heartbeat-only rule drops typing after 6 s with no events, and a running tool reports only every 30 s. End the refresh with one clear on `idle` or on a stale report. Fork extras:
- a reaction ack in threadless chats on thread-only platforms.
- failures are logged, not swallowed.
- a 5-minute ceiling on continuous typing.
- a report left over from a previous run keeps plain typing for up to 60 s after a wake, for slow cold starts.
**Files:** `src/modules/typing/index.ts`, `src/modules/typing/index.test.ts`, `src/router.ts`.
**How to apply on U:** U's module is unchanged since B. Start from `git show 098ed630:src/modules/typing/index.ts`, then remove two things.
- Status text:
  - delete `interface PresenceStatus` and the `status` field of `PresenceReport`.
  - `refresh(entry, showStatus)` becomes `refresh(entry)`: return if capped, return if `entry.mode !== 'status'`, else plain `triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance)`. Update its four callers.
  - `triggerTyping` loses its `status` and `statusKind` parameters.
  - drop the header paragraph on status text.
- Voice observers (they move to commit 12):
  - delete `TypingTick`, `TypingObserver`, `typingObservers`, `registerTypingObserver`, `workingSinceInbound` and `notifyObservers`.
  - delete the `notifyObservers(entry)` calls in `paintSignal` and `refresh`.
  - in `notePresence`, delete `pickedUp` and the observer `if`.
  - in the header, drop "One observer hook (registerTypingObserver)...".

Keep everything else as in S:
- `TURN_STALE_MS`, `TYPING_CEILING_MS`, `LEFTOVER_REPORT_BUDGET_MS`, `ACK_EMOJI`.
- `signalFailed`, `resolveMode`, `paintSignal`, `clearSignal`, `endRefresh`.
- the interval tick rule and `notePresence`.
- the `messageId` parameter of `startTypingRefresh`.
- `pauseTypingRefreshAfterDelivery`, which removes the ack and restarts the ceiling.

`src/router.ts`, in the `startTypingRefresh(...)` call (U:648-655): add a seventh argument `event.message.id`, the anchor for the reaction ack. Commit 12 later wraps it as `event.agentGroupId ? undefined : event.message.id`.

Tests: copy S's `index.test.ts`, then:
- delete `describe('presence: runner status text rides on the typing indicator')` and `describe('typing observers')`.
- strip `, status: null` from every `notePresence(...)` call (`sed -i '' 's/, status: null//'`).
- drop any import of removed symbols.
**Verify:** `pnpm vitest run src/modules/typing/index.test.ts`; `rg -n 'live_status|registerTypingObserver' src` returns nothing.

### 3.7 Not replayed from these commits [DROP]
- The status-text half of #3786 (`live_status`, host `getState?`, `getSessionState`, `StateValue`): nothing writes it.
- The fork's earlier `createTurnLiveness` heartbeat ticker and `task_started` provider event (a6317afb, 02493c57): the fork itself removed them in d9d37696, so they are not in the S tree.

## Commit 4 - Agent-runner fixes

### 4.1 Coalesced results [MERGE]
**Intent:** the SDK can fold queued sends into one turn (`result.queued_turn_count`, documented as "Queued sends may coalesce into fewer turns"). U assumes one result per push, so a leftover queued route answers the next push. A probe on U showed a task folded into a chat turn sending the next chat answer to `task_log` as `[undelivered -> ...]`.
**Files:** `runner:providers/types.ts`, `runner:providers/claude.ts`, `runner:poll-loop.ts`, `runner:poll-loop.turn-state.test.ts`.
**How to apply on U:**
- `providers/types.ts` result variant (U:164): add `queuedTurnCount?: number;`, with S's doc lines: count of pushed sends still waiting when the result was produced; 0 means every send received by then is answered; undefined when unknown.
- `providers/claude.ts` result branch (U:368-381):
  - widen the cast to include `queued_turn_count?: number;`.
  - add `queuedTurnCount: m.queued_turn_count,` to the yielded result.
- `poll-loop.ts`:
  - declare `let providerPushes = 0;` next to `workingRemark`, with S's 4-line comment.
  - add `providerPushes += 1;` after `query.push(prompt)` in `pushRetry` (U:450) and after the follow-up push (U:541).
  - first line of the result branch (U:611): `const pushesAtResult = providerPushes;`.
  - at the boundary, right before `const next = queuedTurns.shift();` (U:711):
```ts
        // The SDK may coalesce queued sends into fewer turns, so one result can
        // answer several pushed turns. A result reporting no queued sends, with
        // nothing pushed while it was handled, answered them all: drop the
        // leftover routes and prompts so the loop goes idle and the next push
        // adopts its own route instead of an already-answered one.
        if (event.queuedTurnCount === 0 && providerPushes === pushesAtResult && queuedTurns.length > 0) {
          log(`Result reports no queued sends: ${queuedTurns.length + 1} pushed turns coalesced into one result`);
          queuedTurns.length = 0;
          archivePrompts.length = 0;
        }
```
  - The guard also covers U's `nudgedWindow`: a nudge pushed by this same result raises `providerPushes`, so nothing is cleared.
- Put the two coalescing tests and `CoalescingProvider` back into `poll-loop.turn-state.test.ts` from S.
**Verify:** `bun test src/poll-loop.turn-state.test.ts`.

### 4.2 Close an open `<message>` block at end_turn [ADAPT]
**Intent:** a clean `end_turn` that leaves one addressed `<message to="...">` open means only the close tag is missing. Deliver it. On U, a lone open block gets a plain nudge (the model re-sends it), and an open block after a complete one is dropped silently (probe on U).
**Files:** `runner:providers/types.ts`, `runner:providers/claude.ts`, `runner:poll-loop.ts`, `runner:poll-loop.midturn-assembly.test.ts`, `runner:providers/claude.midturn-text.test.ts`.
**How to apply on U:**
- `types.ts` result variant: add `stopReason?: string | null;` with S's doc (only an explicit `'end_turn'` lets the poll loop close an open block).
- `claude.ts`: add `stop_reason?: string | null;` to the result cast, and `stopReason: m.stop_reason,` to the yield.
- `poll-loop.ts`:
  - add after `const OPEN_MESSAGE_RE` (U:991):
    `/** A carried tail that is exactly one still-open, addressed <message> block. */ const OPEN_BLOCK_RE = /^<message\s+to="[^"]+"\s*>/;`
  - after `const failed = event.isError === true;` (U:620), add:
```ts
        // A clean end_turn that leaves a <message to="..."> block open ends the
        // block: the model addressed it and finished the turn, only the close
        // tag is missing. Truncation and failures keep the fragment undelivered;
        // an open <internal> or unknown destination still delivers nothing.
        // Runs before the nudge decision, which then sees the delivery.
        if (midTurnCompleteDelivery && !failed && event.stopReason === 'end_turn' && OPEN_BLOCK_RE.test(midTurnTail)) {
          const closed = await deliverMidTurnBlocks('</message>', routing, turnStartSeq, midTurnTail, nudgedWindow);
          if (closed.delivered > 0) log('Closed an unterminated <message> block at end of turn');
          midTurnSent += closed.delivered;
          midTurnReplied += closed.replied;
          midTurnTail = '';
        }
```
- ADAPT: S's version does not do `midTurnReplied += closed.replied` and does not pass `nudgedWindow`. Both are U names (#3918). Without the first, U's `hasUnwrapped` (`replied === 0 && scratchpad`) fires an informed nudge right after the close, which invites a re-send (probe on U). Drop S's `workSinceDelivery = false` line, which 4.3 replaces.
- Tests:
  - copy S's `describe('end_turn closes a still-open block')` into U's `poll-loop.midturn-assembly.test.ts`. U still has the helpers `run`, `seedDest` and `deliveredTexts`.
  - copy S's `passes the SDK result's stop_reason through as stopReason` into `claude.midturn-text.test.ts`.
**Verify:** `bun test src/poll-loop.midturn-assembly.test.ts src/providers/claude.midturn-text.test.ts`.

### 4.3 Streamed acknowledgment, then work, then an unwrapped answer [ADAPT]
**Intent:** an "on it" followed by more tool work and then the real answer left unwrapped must not lose the answer.
**What U already covers:** U's [#3918](https://github.com/nanocoai/nanoclaw/commit/15c6124f) informed nudge covers the send_message ack and the reaction cases. Probe on U: an informed nudge fires for both.
**The gap:** a `<message>` ack streamed through the mid-turn door counts in `midTurnReplied`, so U sends no nudge and the answer is lost.
**Files:** `runner:providers/types.ts`, `runner:providers/claude.ts`, `runner:poll-loop.ts`, `runner:poll-loop.midturn-resultdoor.test.ts`, `runner:providers/claude.midturn-text.test.ts`.
**How to apply on U:**
- ADAPT: do not replay S's 082b4e69 hunks. They do not compile on U:
  - `turnDelivered` is gone from `ResultDispatchOptions` (U:837-870).
  - `chatRowWrittenSince` is now `chatRowsInWindow` (U:1055).
  - S's `hasScratchpad` return clashes with U's `undelivered` (U:1288).
  - Drop S's `workSinceDelivery`, `willNudgeAfterAck` plus its soft-nudge text, `hasScratchpad`, `replyRowWrittenSince` and `isReactionRow`.
- `types.ts`: add the event variant after `text`:
  `| { type: 'tool_call'; name: string }`, with S's doc (a main-thread tool call; optional for providers).
- `claude.ts` assistant branch (U:354-361): replace the `content` cast with S's `assistant` cast (`parent_tool_use_id?: string | null`; content blocks with an optional `name`). After `if (text) yield { type: 'text', text };`, add:
```ts
            // Subagent tool calls are the subagent's own work; the main
            // thread's Agent call already marks that work.
            if (!assistant.parent_tool_use_id) {
              for (const block of content) {
                if (block.type === 'tool_use' && block.name) yield { type: 'tool_call', name: block.name };
              }
            }
```
- `poll-loop.ts`:
  - new branch before `} else if (event.type === 'result') {` (U:611):
```ts
      } else if (event.type === 'tool_call') {
        // Non-delivery work after a streamed reply makes that reply an acknowledgment:
        // an unwrapped final text then gets the informed wrap-nudge instead of passing as answered.
        if (midTurnCompleteDelivery && !routing.taskRun && !REPLY_NEUTRAL_TOOLS.has(bareToolName(event.name))) {
          midTurnReplied = 0;
        }
```
  - module helpers, placed near `answersBatch` (U:985):
```ts
/** Tools that are themselves a send or a reaction: calling one does not turn an earlier reply into an ack. */
const REPLY_NEUTRAL_TOOLS = new Set(['send_message', 'send_file', 'send_media_group', 'edit_message', 'add_reaction']);

/** `mcp__nanoclaw__send_message` -> `send_message`; plain names pass through. */
function bareToolName(name: string): string {
  return name.replace(/^mcp__nanoclaw__/, '');
}
```
  - This was checked on a scratch copy of U: with the branch in place, the streamed-ack case fires the informed nudge, and U's poll-loop door suites (152 tests) still pass.
- Tests:
  - do not copy S's `describe('unwrapped final text after an acknowledgment')`. Its strings are S's soft nudge.
  - add to U's `poll-loop.midturn-resultdoor.test.ts`:
```ts
describe('streamed ack, then tool work, then an unwrapped answer', () => {
  it('a non-delivery tool call after a streamed reply gets the unwrapped answer the informed nudge', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">looking into it</message>' };
      yield { type: 'tool_call', name: 'mcp__glim__glim_web_search' };
      yield { type: 'text', text: 'The answer, unwrapped.' };
      yield { type: 'result', text: 'The answer, unwrapped.' };
    }
    const { query, pushes } = makeStubQuery(events());
    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);
    expect(deliveredTexts()).toEqual(['looking into it']);
    expect(informedNudges(pushes)).toHaveLength(1);
  });

  it('a send or reaction tool after a streamed reply keeps it the reply', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">the answer</message>' };
      yield { type: 'tool_call', name: 'mcp__nanoclaw__add_reaction' };
      yield { type: 'text', text: 'Reacted too.' };
      yield { type: 'result', text: 'Reacted too.' };
    }
    const { query, pushes } = makeStubQuery(events());
    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);
    expect(nudges(pushes)).toHaveLength(0);
  });
});
```
  - copy S's `yields a tool_call per main-thread tool_use block...` into `claude.midturn-text.test.ts`.
- Behaviour change to accept: after "send_message reply, then an unwrapped note", U sends one informed nudge where S stayed quiet. The model answers `<internal>done</internal>`, at the cost of one round trip.
**Verify:** `bun test src/poll-loop.midturn-resultdoor.test.ts src/providers/claude.midturn-text.test.ts`; `bun run typecheck` (or `tsc --noEmit`) in `container/agent-runner`.

### 4.4 PreCompact hook starts the mailbox [MERGE]
**Intent:** `compact-instructions.ts` runs as its own Bun process and called `getAllDestinations()` with no mailbox registered. It failed with "No agent mailbox registered", so compaction lost the routing reminder. Upstream [issue #3984](https://github.com/nanocoai/nanoclaw/issues/3984) is still open, and U still has the bug.
**Files:** `runner:compact-instructions.ts`.
**How to apply on U:** replace the `if (import.meta.main)` block (U:76-79) with S's:
```ts
if (import.meta.main) {
  // A hook runs as its own Bun process: load the mailbox composition and start
  // it like every other entry point (upstream #3984).
  await import('./modules/index.js');
  const { getAgentMailbox, readMailboxContext } = await import('./mailbox/index.js');
  const mailbox = getAgentMailbox();
  await mailbox.start(await readMailboxContext());
  try {
    const names = getAllDestinations().map((destination) => destination.name);
    console.log(buildCompactInstructions(names, getTaskSeriesId()));
  } finally {
    await mailbox.stop();
  }
}
```
`readMailboxContext` reports problems on stderr, so the hook's stdout stays clean.
**Verify:** in a running agent container, `bun /app/src/compact-instructions.ts` prints the instructions and exits 0.

### 4.5 Delivery guidance wording [MERGE]
**Intent:** tell agents that unwrapped text is never shown. U's #3918 already says an ack does not replace the answer (U `runner:destinations.ts:139`), so keep only the part U lacks.
**Files:** `runner:destinations.ts`.
**How to apply on U:** in `buildDestinationsSection`, append to the "Wrap each delivered message in a `<message to="name">...</message>` block; ..." line, after `marks thinking you don't want sent.`:
` Text outside a \`<message>\` block is never shown to anyone. To stay silent, write nothing or only \`<internal>\`.`
**Verify:** `bun test src/destinations.test.ts`.

### 4.6 Agent SDK bump [DROP]
**Files:** `runner:package.json`, `container/agent-runner/bun.lock`. S pins `^0.3.295`; U already pins `^0.3.296` and has dropped `cron-parser`. Take U's pins (D5).

## Cross-section notes

- **Commit 2 (envelope):**
  - `runner:mailbox/sqlite/operations.ts` adds `sqliteFindSeqByPlatformMessageId` (S:195-234). `runner:mailbox/sqlite/index.ts` delegates `findSeqByPlatformMessageId(channelType, platformId, platformMessageId)` to it, and `runner:mailbox/types.ts` adds the matching `MailboxOperations` member.
  - ADAPT: S reads through `getInboundDb()`. On U that throws outside test mode (`connection.ts:70-72`), and the formatter's `replyToSeq` catch swallows the error. reply_to then silently vanishes while unit tests stay green.
  - Rewrite the inbound part as `readInbound((db) => ({ inboundRow: db.prepare(...).get({...}), outIds: db.prepare('SELECT message_out_id FROM delivered WHERE platform_message_id = ?').all(id) }))`, keeping S's SQL and parameters. Then query `getOutboundDb()` as S does. U's `sqliteGetMessageIdBySeq` (operations.ts:163) is the model.
  - The host `idx_delivered_platform_message` index (schema.ts and `migrateDeliveredTable`) and `getReplyTarget` go here too.
  - `runner:cross-session-echo.test.ts` (+25: `replies to the last waking message...` and `falls back to the first row...`) tests the formatter's `extractRouting` change and lands with it. It does not overlap U's #4092 tests (a different `describe`).
- **Commit 5 (compact window):** drop the runner hunks entirely. That is `autoCompactWindow` in `runner:config.ts`, `runner:index.ts` (`autoCompactWindow: config.autoCompactWindow,`), `runner:providers/types.ts` (`ProviderOptions.autoCompactWindow`) and `runner:providers/claude.ts` (the env override). The runner already reads `process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` (U `runner:providers/claude.ts:202`), and the host hook `registerProviderContainerConfig('claude', ctx)` (U `src/providers/claude.ts:14-22`) gets `ctx.agentGroupId` on every spawn (U `src/container-runner.ts:1120-1132`).
- **Commit 7 (Telegram):**
  - `richMessages` in `runner:config.ts` and `runner:config.test.ts`.
  - in `runner:mcp-tools/index.ts`: `import { loadConfig } from '../config.js'; import { offerRichMessages } from './rich-messages.js'; import './media-group.js';` and `if (loadConfig().richMessages) offerRichMessages();` before `mailbox.start` (section 01 moves `send_media_group` to `media-group.ts` and the rich-messages offer to `rich-messages.ts`).
- **Commit 8 (pond):** `runner:index.ts` `import { pondMcpServers } from './pond-mcp.js';` plus `Object.assign(mcpServers, pondMcpServers());` with its 2-line comment, after the `config.mcpServers` loop (U `runner:index.ts:115-124`). U has no runner-side MCP registration hook, so this one-line edit to an upstream file is unavoidable.
- **Commit 3 (Slack typing hunk; section 05's file map agrees):** `src/channels/slack.ts` sets `bridge.typingRequiresThread = true`, wraps `setTyping` with the default `'is thinking...'` status, and overrides `clearTyping` through `setAssistantStatus(channel, threadTs, '')`. It depends on 3.5's bridge `setTyping(status)`, `normalizeStatusText` and the registry's `typingRequiresThread`.
- **D7 drop:**
  - `runner:mcp-tools/index.ts` trailing `import './canvas.js'; import './rooms.js';` are not replayed.
  - `runner:mcp-tools/server.extend.test.ts` (the `fixture_purpose` rename) exists only because `rooms.ts` extends `create_agent` in the same process. Keep U's version, which already expects `template`.
- **Commit 12 (voice):**
  - `runner:poll-loop.ts`: `startForCall` in `runPollLoop`; the `runQuery` extraction; `adoptsInitialBatch` / `batchIds` in `processQuery` (`markCompleted(batchIds)` in the result branch, and `if (batchIds !== initialBatchIds) markCompleted(batchIds);` in `finally` before `enterIdle()`).
  - ADAPT: S's `runQuery` copies the old catch. Keep U's `log(\`Query error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\`)` (U:283, from #4118).
  - `startsIdle` in `runner:providers/types.ts`, `runner:providers/claude.ts` and `runner:providers/mock.ts`; `if (input.prompt) stream.push(input.prompt);` in claude.ts; the mock's idle start.
  - tests `runner:providers/claude.idle-start.test.ts` and the `poll loop - started ahead of a voice call` block in `runner:integration.test.ts`.
  - typing observers: `TypingTick`, `registerTypingObserver`, `workingSinceInbound`, `notifyObservers` and its calls (removed in 3.6), the `pickedUp` notice in `notePresence`, the `typing observers` test block, and the router's `event.agentGroupId ? undefined : event.message.id` guard.
- **Commit 13 (HTTP mailbox):**
  - `runner:mailbox/types.ts` `AgentMailbox.heartbeat?(): boolean` (and `runner:heartbeat.ts` delegating to it).
  - `runner:poll-loop.ts` `refreshMailbox()` (S:1166) and its `await refreshMailbox();` after `markCompleted(...)` in the result branch.
  - the `runner:mcp-tools/index.ts` change that keeps the mailbox started: `catch (err) { await mailbox.stop(); throw err; }` instead of `finally`.
  - The HTTP runner mailbox must implement `markContainerTurn` (required from 3.2), and the host HTTP mailbox's `getContainerState` must return `turn` and `updatedAt`. U's SQLite `run()` just calls the action, so these hunks are no-ops without HTTP.

## Files covered
container/agent-runner/bun.lock -> DROP
container/agent-runner/package.json -> DROP
container/agent-runner/src/compact-instructions.ts -> 4
container/agent-runner/src/config.test.ts -> 7
container/agent-runner/src/config.ts -> 7 (richMessages); autoCompactWindow DROP (5 is host-only)
container/agent-runner/src/cross-session-echo.test.ts -> 2
container/agent-runner/src/destinations.ts -> 4
container/agent-runner/src/index.ts -> 8 (pond); autoCompactWindow DROP (5 is host-only)
container/agent-runner/src/integration.test.ts -> 12
container/agent-runner/src/mailbox/model.generated.ts -> 3 (regenerated from src/mailbox/model.ts)
container/agent-runner/src/mailbox/types.ts -> 3 (markContainerTurn); 2 (findSeqByPlatformMessageId); 13 (heartbeat?)
container/agent-runner/src/mcp-tools/index.ts -> 7 (rich messages); 13 (keep mailbox started); canvas/rooms imports DROP (D7)
container/agent-runner/src/mcp-tools/server.extend.test.ts -> DROP (D7; keep U's version)
container/agent-runner/src/poll-loop.midturn-assembly.test.ts -> 4
container/agent-runner/src/poll-loop.midturn-resultdoor.test.ts -> 4 (new test written on U; S block not copied)
container/agent-runner/src/poll-loop.ts -> 3 (turn state); 4 (coalescing, end_turn close, ack reset); 12 (voice prewarm, runQuery); 13 (refreshMailbox)
container/agent-runner/src/poll-loop.turn-state.test.ts -> 3 (turn tests); 4 (coalescing tests)
container/agent-runner/src/providers/claude.idle-start.test.ts -> 12
container/agent-runner/src/providers/claude.midturn-text.test.ts -> 4
container/agent-runner/src/providers/claude.ts -> 4 (tool_call, queued_turn_count, stop_reason); 12 (startsIdle, empty prompt); autoCompactWindow DROP
container/agent-runner/src/providers/mock.ts -> 12
container/agent-runner/src/providers/types.ts -> 4 (tool_call, queuedTurnCount, stopReason); 12 (startsIdle); autoCompactWindow DROP
src/modules/typing/index.test.ts -> 3 (status-text block dropped; observers block -> 12)
src/modules/typing/index.ts -> 3 (status text dropped; observers -> 12)
container/agent-runner/src/db/container-state.ts -> 3
container/agent-runner/src/mailbox/sqlite/connection.ts -> 3
container/agent-runner/src/mailbox/sqlite/index.ts -> 3 (markContainerTurn); 2 (findSeqByPlatformMessageId)
container/agent-runner/src/mailbox/sqlite/operations.ts -> 2 (rewrite on readInbound)
container/agent-runner/src/mailbox/sqlite/sqlite.test.ts -> 3
