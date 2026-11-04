# Mailbox HTTP transport and k8s dev kit

Covers commits: 13. Source S=098ed630, target U=f7440e85.

Replay this commit after commits 2 and 3 (see "Ordering" below). It is one isolated, opt-in commit:
removing it (REMOVE.md) returns the install to upstream's SQLite mailbox with no core residue other
than the two small runner MERGE items, which are harmless under SQLite.

How the mode is decided (unchanged from S, keep it):
- Host: `readMailboxHttpSettings()` in `src/mailbox/http/index.ts` reads `process.env`, then `.env`,
  then defaults. `NANOCLAW_MAILBOX_TRANSPORT` is `http` (default whenever this commit is present) or
  `sqlite` (rollback). `NANOCLAW_MAILBOX_HTTP_BIND` defaults to the docker0 IPv4 address on Linux
  (with an `ip -4 -o addr show dev docker0` fallback when the bridge has no carrier) and to
  `127.0.0.1` elsewhere, never `0.0.0.0`. `NANOCLAW_MAILBOX_HTTP_PORT` defaults to 3010.
  `NANOCLAW_MAILBOX_HTTP_URL` defaults to the bind address, or `host.docker.internal` for loopback
  or wildcard binds.
- Per spawn, `HttpServedAgentMailbox.runnerContext()` returns
  `{ transport: 'http', protocol, url, token }` (fresh token per spawn, stored host-only under
  `data/v2-sessions/<group>/.mailbox-http/`). U's `spawnContainer` already writes that value into
  the session context file mounted read-only at `/app/.nanoclaw-session.json`; no core change.
- Runner: `ContextSelectedAgentMailbox.start()` (`container/agent-runner/src/mailbox/http/select.ts`)
  picks HTTP for `{transport:'http'}` and SQLite for `null`. The BIND key only chooses the listen
  address; it does not select the transport.
- Docker containers still get `/workspace` (with `inbound.db`/`outbound.db`) mounted read-write by
  U's `buildMounts`; in HTTP mode the runner simply never opens them.
- The live install stays on HTTP and keeps its existing `.env` mailbox keys.

## Commit 13 - Mailbox HTTP transport + k8s dev kit

### 13.1 Transport files [COPY]
**Intent:** keep the fork's HTTP mailbox (host endpoint + runner replica client) as an installable
mailbox implementation behind upstream's singular `compose.ts` slot.
**Files:**
```
src/mailbox/http/index.ts          (then ADAPT, 13.3)
src/mailbox/http/server.ts         (then ADAPT, 13.4)
src/mailbox/http/runner-ops.ts     (then ADAPT, 13.4 and 13.8)
src/mailbox/http/index.test.ts     (then ADAPT, 13.3)
src/mailbox/http/server.test.ts
container/agent-runner/src/mailbox/http/index.ts   (then ADAPT, 13.5 and 13.8)
container/agent-runner/src/mailbox/http/select.ts  (then ADAPT, 13.5)
container/agent-runner/src/mailbox/http/http.test.ts (then ADAPT, 13.5)
container/mailbox-http.test.ts     (then ADAPT, 13.3)
```
**How to apply on U:** `git show 098ed630:<path> > <path>` for each. Then, skill-style packaging:
create `.claude/skills/add-mailbox-http/` with `SKILL.md`, `REMOVE.md` and `payload/` holding the
files above plus the two `compose.ts` replacements (13.2) and `src/modules/mailbox-http/index.ts`
(13.3), each at its tree path under `payload/`. `SKILL.md` carries prose plus:
````
```nc:copy
payload/src/mailbox/http/index.ts -> src/mailbox/http/index.ts
... (one line per payload file, including both compose.ts files)
```
```nc:append to:src/modules/index.ts
import './mailbox-http/index.js';
```
````
`REMOVE.md`: delete the barrel line, delete every copied file, and restore both `compose.ts` files to
U's five lines (13.2). The commit contains the skill folder and its applied result (the copied files
in the tree), the same way `/add-pond` ships. Keep the payload and tree copies byte-identical.
**Verify:** `pnpm exec tsx scripts/skill-directives.ts .claude/skills/add-mailbox-http/SKILL.md`;
`diff -r` each payload file against its tree copy.

### 13.2 Both compose slots [MERGE]
**Intent:** register the HTTP-capable mailbox in the slot upstream reserves for exactly this
(`docs/agent-mailbox-seam-migration.md:110-115`, `src/modules/index.ts:13-17` at U).
**Files:** `src/mailbox/compose.ts`, `container/agent-runner/src/mailbox/compose.ts`.
**How to apply on U:** replace the whole file in both trees (do not add a second registration).
Host - note it no longer imports `host-lifecycle` (S did; that forced the `startup-order.test.ts`
mock edit, now unnecessary):
```ts
/** Singular mailbox composition slot. See docs/agent-mailbox-seam-migration.md. */
import { HttpServedAgentMailbox } from './http/index.js';
import { registerAgentMailbox } from './index.js';

// SQLite storage, reached by containers over the host's mailbox endpoint
// (NANOCLAW_MAILBOX_TRANSPORT=sqlite reverts them to the shared files).
registerAgentMailbox(() => new HttpServedAgentMailbox());
```
Runner - take S verbatim (`git show 098ed630:container/agent-runner/src/mailbox/compose.ts`):
```ts
/** Singular mailbox composition slot. See docs/agent-mailbox-seam-migration.md. */
import { registerAgentMailbox } from './index.js';
import { ContextSelectedAgentMailbox } from './http/select.js';
import { SqliteAgentMailbox } from './sqlite/index.js';

// SQLite files or the host's HTTP endpoint, as the host's session context selects.
registerAgentMailbox(() => new ContextSelectedAgentMailbox(() => new SqliteAgentMailbox()));
```
U's original (for REMOVE.md), identical in both trees:
```ts
/** Singular mailbox composition slot. See docs/agent-mailbox-seam-migration.md. */
import { registerAgentMailbox } from './index.js';
import { SqliteAgentMailbox } from './sqlite/index.js';

registerAgentMailbox(() => new SqliteAgentMailbox());
```
**Verify:** `http.test.ts` "the runner compose slot registers the context-selected mailbox";
`pnpm exec vitest run setup/mailbox-compatibility.test.ts` passes unedited (needs 13.3).

### 13.3 Host mailbox as a subclass, listen/close as a module [ADAPT]
**Intent:** no edits to upstream host files beyond the slot and one barrel line.
**Files:** `src/mailbox/http/index.ts`, new `src/modules/mailbox-http/index.ts`,
`src/modules/index.ts` (barrel append), `src/mailbox/http/index.test.ts`,
`container/mailbox-http.test.ts`.
**How to apply on U:**
- In `src/mailbox/http/index.ts`, change `class HttpServedAgentMailbox implements AgentMailbox` to
  `class HttpServedAgentMailbox extends SqliteAgentMailbox`. Constructor becomes
  `constructor(private readonly settingsSource: () => MailboxHttpSettings = () => readMailboxHttpSettings()) { super(); }`.
  Delete the pass-through methods (`exists`, `prepare`, `session`, `runnerEnvironment`) and the
  `delegate` field. `destroy` becomes `override async destroy(key)` ending in
  `await super.destroy(key)`. `runnerContext` becomes an override whose sqlite branch is
  `return super.runnerContext(key)`. In `listen()`, `exists: (key) => this.exists(key)`.
  Why: `setup/mailbox-compatibility.test.ts:32` (U) asserts `getAgentMailbox() instanceof SqliteAgentMailbox`;
  a subclass keeps it true, so S's edit to that test is dropped. Other forks use the same pattern
  (upstream issue #3704).
- Type note: U declares `SqliteAgentMailbox.runnerContext(): Promise<null>`, and an override must
  return something assignable to it, so `Promise<HttpRunnerContext | null>` will not compile.
  Annotate the override `Promise<any>` (add an eslint disable for `no-explicit-any` on that line if
  lint flags it) (inferred; confirm with `pnpm run build`).
- New `src/modules/mailbox-http/index.ts`:
```ts
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { HttpServedAgentMailbox } from '../../mailbox/http/index.js';
import { getAgentMailbox } from '../../mailbox/index.js';

// The endpoint serves adopted containers too, so it listens at host start, not first spawn.
onHostStart(async () => {
  const mailbox = getAgentMailbox();
  if (mailbox instanceof HttpServedAgentMailbox) await mailbox.listen();
});
onHostShutdown(async () => {
  const mailbox = getAgentMailbox();
  if (mailbox instanceof HttpServedAgentMailbox) await mailbox.close();
});
```
  Append `import './mailbox-http/index.js';` as the last line of `src/modules/index.ts` (U ends at
  `import './community-portal/index.js';`). `listen()` is already a no-op under `sqlite`.
- Tests: `index.test.ts` builds `new HttpServedAgentMailbox(() => httpSettings)`; its "delegates every
  storage operation" case spies on `SqliteAgentMailbox.prototype` (`exists`, `prepare`, `destroy`,
  `session`) instead of a delegate instance. `container/mailbox-http.test.ts:64` becomes
  `new HttpServedAgentMailbox(() => settings)`.
- Dropped S hunks: `src/startup-order.test.ts` host-lifecycle mock (compose no longer imports
  host-lifecycle; that test mocks `./modules/index.js` to `{}`, U :60) and `src/test-setup.ts`
  per-file port (no unit test loads the module and starts the host, so nothing binds) (inferred).
  If `pnpm test` fails on a Linux machine without docker0 (bind resolution inside `runnerContext()`
  under `container-runner` tests), add only
  `process.env.NANOCLAW_MAILBOX_HTTP_BIND ??= '127.0.0.1';` to `src/test-setup.ts` and say why in
  the commit (inferred).
**Verify:** `pnpm run build`; `pnpm exec vitest run src/mailbox/http container/mailbox-http.test.ts setup/mailbox-compatibility.test.ts src/startup-order.test.ts`;
`rg -n "mailbox-http" src/modules/index.ts` shows one line.

### 13.4 Own SQLite helpers on the host [ADAPT]
**Intent:** S exported `sqliteTimestamp` from `src/mailbox/sqlite/index.ts` and added an options
parameter to `openOutboundDbRw` in `src/mailbox/sqlite/session-db.ts`; keep both upstream files
untouched instead.
**Files:** `src/mailbox/http/runner-ops.ts`, `src/mailbox/http/server.ts`.
**How to apply on U:**
- In `runner-ops.ts`, replace `import { sqliteTimestamp } from '../sqlite/index.js';` with a local
  copy of U's private helper (`src/mailbox/sqlite/index.ts:66-72` at U):
```ts
const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function sqliteTimestamp(value: string): string {
  const source = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}
```
  Keep `import { OUTBOUND_SCHEMA } from '../sqlite/schema.js';` (exported at U, no edit).
- In `server.ts`, drop `import { openOutboundDbRw } from '../sqlite/session-db.js';` and open with
  better-sqlite3 directly (busy_timeout before journal_mode, matching U's runner fix a6964d07;
  `fileMustExist` so the endpoint never creates a missing `outbound.db`):
```ts
function openOutbound(file: string): Database.Database {
  const db = new Database(file, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = DELETE');
  return db;
}
```
  and call `openOutbound(paths.outbound)` where S called `openOutboundDbRw(paths.outbound, { fileMustExist: true })`.
**Verify:** `git diff f7440e85 -- src/mailbox/sqlite` is empty; `server.test.ts` passes.

### 13.5 Heartbeat without core edits [ADAPT]
**Intent:** S added `heartbeat?(): boolean` to the runner `AgentMailbox` and made
`touchHeartbeat()` delegate to it, so a host that cannot see `/workspace` still gets liveness. Do
the same inside the HTTP client only.
**Files:** `container/agent-runner/src/mailbox/http/index.ts`, `.../http/select.ts`,
`.../http/http.test.ts`. Not touched: `container/agent-runner/src/heartbeat.ts`,
`container/agent-runner/src/mailbox/types.ts` (both stay as U has them).
**How to apply on U:**
- `HttpAgentMailbox`: delete the public `heartbeat()` method. In `exchange()`, replace
  `const heartbeat = this.heartbeatPending;` with a read of the local heartbeat file's mtime
  (`fs.statSync(heartbeatPath()).mtimeMs`, `heartbeatPath` imported from `../../heartbeat.js`;
  treat a missing file as 0); send the `heartbeat` op when it is newer than the last mtime
  forwarded, and record that mtime only after the exchange succeeds (S re-arms
  `heartbeatPending` on failure; keep that behavior). The runner keeps touching the file through
  U's `touchHeartbeat()`, so semantics stay "the runner made progress", never "the transport is
  alive". Under Docker the host also sees the bind-mounted file, so a double touch is harmless.
  (inferred feasible; a pod must be able to write `heartbeatPath()` locally)
- `ContextSelectedAgentMailbox`: delete its `heartbeat()` pass-through.
- `http.test.ts` (around S lines 306-403): rewrite the heartbeat cases to set
  `NANOCLAW_HEARTBEAT_PATH` to a temp file, call `touchHeartbeat()`, and assert one `heartbeat` op
  rides the next exchange and none when the mtime did not move.
**Verify:** `cd container/agent-runner && bun test src/mailbox`;
`git diff f7440e85 -- container/agent-runner/src/heartbeat.ts container/agent-runner/src/mailbox/types.ts`
shows only commit 2 and 3 hunks.

### 13.6 MCP entry keeps the mailbox started [MERGE]
**Intent:** `startMcpServer` returns once stdio is attached while tools keep running for the life
of the process; U's `finally { await mailbox.stop(); }` stops the mailbox at that point, which
freezes an HTTP replica (tool polls such as `ask_user_question` then fail closed after 15 s).
Harmless for SQLite. Minimal upstream edit, no seam exists for it.
**Files:** `container/agent-runner/src/mcp-tools/index.ts`.
**How to apply on U:** in `main()` (U lines 21-29), replace the `try { ... } finally { ... }` with:
```ts
  // startMcpServer returns once stdio is attached while tools keep running for
  // the life of the process, so the mailbox stays started; each tool call
  // commits its writes inside run().
  try {
    await startMcpServer((action) => mailbox.run(action));
  } catch (err) {
    await mailbox.stop();
    throw err;
  }
```
**Verify:** `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`; e2e: an
`ask_user_question` answered after 15 s still completes in HTTP mode.

### 13.7 Refresh the mailbox at the result door [MERGE]
**Intent:** the nudge decision reads reply rows the MCP process just committed; a replicated
mailbox sees them only after a sync. Under SQLite `run()` is a pass-through, so this is a no-op.
**Files:** `container/agent-runner/src/poll-loop.ts`.
**How to apply on U:** U restructured the result door (#3918). Anchor: in the
`} else if (event.type === 'result') {` branch, directly after `markCompleted(initialBatchIds);`
(U `poll-loop.ts:618`; S used `markCompleted(batchIds)`), insert:
```ts
        // The nudge decision and the next turn boundary read reply rows the
        // MCP process wrote; a replicated mailbox sees them only after a sync.
        await refreshMailbox();
```
and add the helper just above `/** Current outbound seq high-water mark` (U :1042); `getAgentMailbox`
and `log` are already in scope (U :13, :44):
```ts
/** Fail-open like the reads it feeds: a failed sync leaves those reads on the current replica. */
async function refreshMailbox(): Promise<void> {
  try {
    await getAgentMailbox().run(() => undefined);
  } catch (err) {
    log(`mailbox refresh failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```
**Verify:** `cd container/agent-runner && bun test src/poll-loop` (all poll-loop suites, including
U's `poll-loop.midturn-resultdoor.test.ts`).

### 13.8 `getDeliveryStatus` over HTTP [ADAPT]
**Intent:** U added optional `MailboxOperations.getDeliveryStatus?` (runner
`mailbox/types.ts:62`, c28507ba) so `ask_user_question` stops waiting when its card cannot be
delivered (`mcp-tools/interactive.ts:229`). S's HTTP client lacks it: it compiles, but a failed card
waits out the full timeout.
**Files:** `src/mailbox/http/runner-ops.ts`, `container/agent-runner/src/mailbox/http/index.ts`,
both HTTP test files.
**How to apply on U:**
- Host snapshot (`runner-ops.ts`, S lines 241-251 and 303-306): select `status` with
  `rowid, message_out_id, platform_message_id` in both branches and send
  `{ messageOutId, platformMessageId, status }`. U's host writes `delivered` with `INSERT OR IGNORE`
  (`markDelivered`/`markDeliveryFailed`), so a row's status never changes after its rowid is sent and
  the rowid cursor stays correct.
- Runner: add `status` to `WireSnapshot.delivered`; in `Replica` keep a
  `deliveryStatus = new Map<string, 'delivered' | 'failed'>()` filled and trimmed together with
  `delivered` in `apply()` (map `status === 'failed'` to `'failed'`, anything else to
  `'delivered'`, as U's `sqliteGetDeliveryStatus` does); add to `createOperations()`
  `getDeliveryStatus: (messageOutId) => read(() => replica.deliveryStatus.get(messageOutId) ?? null)`.
**Verify:** a runner test against the stub host: a `failed` delivered row yields `'failed'`;
an e2e case in `container/mailbox-http.test.ts` after `markDeliveryFailed`.

### 13.9 Ordering on commits 2 and 3 [ADAPT]
**Intent:** the HTTP code implements two fork ops that do not exist on U.
**Files:** `container/agent-runner/src/mailbox/http/index.ts` (S :592 `findSeqByPlatformMessageId`,
S :618 `markContainerTurn`), `src/mailbox/http/runner-ops.ts` (S :170 `turn` column in
`ensureRunnerOutboundTables`, S :178-218 port of the reply-seq rule plus `replySeqs` in the snapshot,
S :470-481 `markContainerTurn` op).
**How to apply on U:** replay commit 2 (adds `findSeqByPlatformMessageId` to runner
`MailboxOperations`) and commit 3 (adds `markContainerTurn` and the `turn` column, upstream PR
#3786) first; otherwise the `MailboxOperations` object literal fails excess-property checks. If
commit 2 changes the reply-seq rule while rewriting it on `readInbound()`, mirror the change in
`runner-ops.ts` `findSeqByPlatformMessageId` and the replica fallback in the client; if commit 3
renames the op or column, rename here too. Transport files use neither `openInboundDb()` nor
`getInboundDb()`, so U's inbound-db API change needs nothing here.
**Verify:** `pnpm exec vitest run container/mailbox-http.test.ts` (asserts protocol and op coverage
across both sides).

### 13.10 k8s dev kit [COPY]
**Intent:** keep the local kind + agent-sandbox playground and the GHCR agent images as dev tooling
for the k8s lane. Nothing in `src/` references it.
**Files:**
```
dev/k8s/.gitignore
dev/k8s/README.md        (then ADAPT, 13.11)
dev/k8s/down.sh
dev/k8s/kind-config.yaml
dev/k8s/sample-claim.yaml
dev/k8s/sandbox-template.yaml
dev/k8s/up.sh
dev/k8s/warm-pool.yaml
container/Dockerfile.k8s
.github/workflows/agent-image.yml
```
**How to apply on U:** `git show 098ed630:<path> > <path>`; keep `up.sh`/`down.sh` executable.
U's `container/Dockerfile` still takes `AGENT_RUNNER_LOCK_SHA256` and has the same
`# syntax=docker/dockerfile:1.7@sha256:a57df69d...` frontend pin `Dockerfile.k8s` mirrors; recheck
both if U bumps the pin. `NANOCLAW_AGENT_IMAGE_REF` still overrides U's new release-image lookup
(`container/pull.sh`), so the README's pull instructions hold. Not part of the skill payload.
**Verify:** `bash -n dev/k8s/up.sh dev/k8s/down.sh`; `actionlint .github/workflows/agent-image.yml`
if available.

### 13.11 Fold the GHCR docs into the kit README [ADAPT]
**Intent:** S added a "Registry images (GHCR)" section to `docs/build-and-runtime.md`; keep that
upstream doc untouched and put the section in the kit's README instead. The repo is public, so the
README must not carry host-specific addresses.
**Files:** `dev/k8s/README.md`; `docs/build-and-runtime.md` stays as U has it.
**How to apply on U:** append the section from
`git diff 66f0823a 098ed630 -- docs/build-and-runtime.md` (the 24 added lines, from
`## Registry images (GHCR)` through the `NANOCLAW_AGENT_IMAGE_REF` paragraph) to
`dev/k8s/README.md`, changing its link `[hardened-image.md](hardened-image.md)` to
`[hardened-image.md](../../docs/hardened-image.md)`. In the README's "Reaching the Mac from a
sandbox" table and prose, replace the two rows that name the developer machine's own LAN and
tailnet addresses with `<host LAN IP>` and `<host tailnet IP>`; generic addresses (OrbStack's host
IP, the kind gateway, pod IPs, public resolvers) can stay.
**Verify:** `git diff f7440e85 -- docs/build-and-runtime.md` is empty;
`rg -n "Registry images" dev/k8s/README.md` matches; the README names no address of a real machine.

## Cross-section notes
- Commit 2: owns `findSeqByPlatformMessageId` in runner `mailbox/types.ts` and the SQLite op. S's
  SQLite version calls `getInboundDb()` (`container/agent-runner/src/mailbox/sqlite/operations.ts:200`
  at S), which throws outside test mode on U (`connection.ts:70-72`): bun tests pass while
  production SQLite throws, and HTTP mode on the live install would hide it. It must use
  `readInbound((db) => ...)`. Also owns the `delivered(platform_message_id)` index in
  `src/mailbox/sqlite/schema.ts` that the host port's lookup relies on.
- Commit 7: S's `mcp-tools/index.ts` `main()` also has
  `if (loadConfig().richMessages) offerRichMessages();` before `getAgentMailbox()`; that line is
  Telegram rich messages, not 13.6.
- Commit 3: owns `markContainerTurn`, `TurnState`, the `turn` column and `getState`; this commit
  only consumes them.
- Commit 4: owns the #3984 PreCompact fix in `container/agent-runner/src/compact-instructions.ts`
  (load `./modules/index.js`, then `start()`/`stop()` the mailbox around the reads). HTTP mode
  needs it: without `start()` the hook would read the SQLite files, which a remote runtime does not
  have.
- Dropped S hunks owned by no commit: runner `mailbox/types.ts` `heartbeat?()` and
  `container/agent-runner/src/heartbeat.ts` delegation (13.5); `src/mailbox/sqlite/index.ts`
  `export` and `src/mailbox/sqlite/session-db.ts` options (13.4); `src/startup-order.test.ts` mock,
  `setup/mailbox-compatibility.test.ts` assertion and `src/test-setup.ts` port (13.3);
  `docs/build-and-runtime.md` section (13.11).
- Not in this commit: the k8s SessionDriver lives on fork branch `feat/kubernetes-driver` (fork PR
  #31, open, unmerged; it also carries a newer `dev/k8s/` kit and a mailbox `NO_PROXY` change).
  Upstream PR #4181 is a separate `/add-k8s-driver` skill for in-cluster hosts.
- Risk to note in the docs commit (inferred): with `NANOCLAW_EGRESS_LOCKDOWN=true`, U attaches
  agents only to the `--internal` egress network (`src/egress-lockdown.ts:124-126`), so a
  docker0-bound mailbox endpoint is unreachable and runners poison after 15 s.

## Files covered
```
.github/workflows/agent-image.yml -> 13
container/Dockerfile.k8s -> 13
container/agent-runner/src/heartbeat.ts -> DROP (S delegation replaced by 13.5; file stays as U)
container/agent-runner/src/mailbox/compose.ts -> 13
container/agent-runner/src/mailbox/http/http.test.ts -> 13
container/agent-runner/src/mailbox/http/index.ts -> 13
container/agent-runner/src/mailbox/http/select.ts -> 13
container/mailbox-http.test.ts -> 13
dev/k8s/.gitignore -> 13
dev/k8s/README.md -> 13
dev/k8s/down.sh -> 13
dev/k8s/kind-config.yaml -> 13
dev/k8s/sample-claim.yaml -> 13
dev/k8s/sandbox-template.yaml -> 13
dev/k8s/up.sh -> 13
dev/k8s/warm-pool.yaml -> 13
src/mailbox/compose.ts -> 13
src/mailbox/http/index.test.ts -> 13
src/mailbox/http/index.ts -> 13
src/mailbox/http/runner-ops.ts -> 13
src/mailbox/http/server.test.ts -> 13
src/mailbox/http/server.ts -> 13
```
