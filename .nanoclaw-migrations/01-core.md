# Host core

Covers commits: 1, 2, 5. Source S=098ed630, target U=f7440e85.

This section owns the shared core files (top-level `src/*.ts`, `src/db`, `src/cli`, `src/mailbox`,
the shared channel machinery, `src/providers`, `setup/`, the runner's `formatter.ts` and
`mcp-tools/core*`, repo config and some docs). Many hunks in them exist for other features; those
are listed under their own commit heading below ("Commit 3" to "Commit 14"), so a replayer of
commit N collects them here. Paths under `container/agent-runner/src/` are written `runner:<path>`.
U line numbers are from `git show f7440e85:<path>`. S snippets carry em dashes in some comments:
write them ASCII when replaying.

Upstream moves that touch these files (B..U):
- `src/inbox-safety.ts` is gone. U's #4063 replaced it with `src/anchored-dir.ts` (`AnchoredDir`,
  `copyRegularFile`), and `extractAttachmentFiles` (U `src/session-manager.ts:356`) now writes
  through an anchored `inbox/<folder>` descriptor, with `inboxFolderName()` from #4170.
- `src/command-gate.ts` parses commands through U's new `src/slash-command.ts` (`commandText`,
  `slashCommandName`, which already drops a `@botname` suffix). The router's admin-deny reply now
  goes straight through `getDeliveryAdapter().deliver(...)` (#4119), not `writeOutboundDirect`.
- `src/delivery.ts` adds `fromAgent: true` to agent `ask_question` content before `deliver`
  (U:537-541).
- CLI dispatch canonicalizes arg keys (`src/cli/args.ts` `normalizeArgs`): handlers read
  `args.auto_compact_window`, never `args['auto-compact-window']`.
- `chat` is 4.41.1 on U (the fork pinned 4.29.0).

## Commit 1 - Agent-doc hooks

### 1.1 Section hooks in the project-doc composer [MERGE]
**Intent:** host modules add per-agent prose to the composed project document, and narrow a
module's or resident skill's prose to the agents it applies to, without the composer importing
them (D6). Consumers: Telegram formatting/rich sections (7), the Slack skill gate (10), the Jev
note (11), voice (12).
**Files:** `src/project-doc-compose.ts` (unchanged B..U, so S's hunks apply as-is).
**How to apply on U:**
- After `const SKILLS_HOST_SUBPATH = ...` (U:160), insert verbatim from S
  (`git show 098ed630:src/project-doc-compose.ts`, the block from `export type
  ProjectDocSectionProvider` through `async function sectionAdmitted`): the types
  `ProjectDocSectionProvider`, `ProvidedSection`, `SectionGate`; the stores `sectionProviders`,
  `moduleSectionGates`, `residentSkillGates`; the exported `registerProjectDocSection`,
  `registerModuleSectionGate`, `registerResidentSkillGate` (the latter two `log.warn` on overwrite);
  and `sectionAdmitted`, which returns `true` with no gate and `false` plus
  `log.error('Project document section gate threw; section left out', { kind, name, group: group.name, err })`
  when the gate throws.
- In the module loop, after `if (cliDisabled && NCL_DEPENDENT_MODULES.has(moduleName)) continue;`
  (U:224):
```ts
      if (!(await sectionAdmitted(moduleSectionGates, 'module', moduleName, group))) continue;
```
- Right after the module loop closes and before `// Resident skill prose.` (U:229):
```ts
  // Agent-specific sections from host modules. A provider that throws loses
  // only its own section, never the spawn.
  for (const provider of sectionProviders) {
    try {
      const section = await provider(group);
      if (section) push(section.name, section.body, true);
    } catch (err) {
      log.error('Project document section provider threw; section left out', { group: group.name, err });
    }
  }
```
- In the resident-skill loop, after `if (!fs.existsSync(hostFragment)) continue;` (U:238):
```ts
      if (!(await sectionAdmitted(residentSkillGates, 'skill', skillName, group))) continue;
```
**Verify:** `rg -n "registerProjectDocSection|registerModuleSectionGate|registerResidentSkillGate" src/project-doc-compose.ts`; tests in 1.4.

### 1.2 Compose the document with the resolved skill list [MERGE]
**Intent:** the document must teach the skills the runner actually links (gateway skills forced
in), not the raw stored selection. U still passes no skill list on this path.
**Files:** `src/container-runner.ts`, `src/providers/claude.test.ts`.
**How to apply on U:** in `resolveProviderContribution`, the `composeProjectDocument` callback
(U:1151) becomes:
```ts
      composeProjectDocument: (spec) =>
        composeGroupProjectDoc(agentGroup, context.groupDir, spec, context.selectedSkills),
```
`composeGroupProjectDoc` already takes `runtimeSkills` (U:173).
In `src/providers/claude.test.ts`: replace the inline mock with a hoisted
`const composeGroupProjectDoc = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));` passed
into the `vi.mock('../project-doc-compose.js', ...)` factory, add `composeGroupProjectDoc.mockClear();`
to `afterEach`, and copy S's `describe('claude provider project document')` (asserts
`mock.calls[0][3]` equals `['fixture-gateway']` after `resetGatewayProvider({ ..., agentSkills: ['fixture-gateway'] })`).
**Verify:** `pnpm vitest run src/providers/claude.test.ts`.

### 1.3 Persona read hardening [MERGE] (unplanned fix, placed here)
**Intent:** `instructions.prepend.md` sits in an agent-writable group folder; a FIFO there blocks
the host's synchronous open, and a huge file stalls it. Not in U.
**Files:** `src/group-persona.ts`, `src/group-persona.test.ts`.
**How to apply on U:** from S: export `MAX_PERSONA_READ_BYTES = 64 * 1024`; open with
`O_RDONLY | O_NOFOLLOW | O_NONBLOCK`; `fstat`, return null unless `isFile()`; warn
`'Group standing instructions are oversized; reading only the start'` with `{ file, bytes }` when
larger; read at most that many bytes with `fs.readSync` into a `Buffer.alloc(min(size, MAX))`.
Keep U's signature `readGroupPersona(groupDir)`; the extra `fileName` parameter is commit 12's.
Tests: S's `reads at most MAX_PERSONA_READ_BYTES of an oversized file` and the `mkfifo` case.
**Verify:** `pnpm vitest run src/group-persona.test.ts`.

### 1.4 Tests [MERGE]
**Files:** `src/project-doc-compose.test.ts`.
**How to apply on U:** keep U's file; add `registerModuleSectionGate` to the composer import and
copy S's `composes a forced gateway skill the stored selection leaves out` (into the
`composeGroupProjectDoc skill selection` describe) and `leaves a module out, and logs at error,
when its gate throws` (it gates `self-mod`). S tests the provider and resident-skill hooks only
through feature modules; add one small test per hook with a throwaway registration
(inferred - not in S). Do NOT copy S's imports of feature modules (`jev-gate`, `voice-mode`,
`telegram-grammy/agent-docs`, `slack`, `canvas-actions`, `slack-agent-flow`), the `DATA_DIR`
`config.js` mock, `withRealContainer`/`realSkill`/`composedSection`/`wire` helpers or the
per-agent-section tests here: each lands with its commit (see 7, 9, 10, 11, 12 below).
**Verify:** `pnpm vitest run src/project-doc-compose.test.ts`.

## Commit 2 - Message envelope

### 2.1 Agent-scoped message ids and their inverse [MERGE]
**Intent:** the agent addresses messages by the inbound row id, which the router suffixes with the
agent group; adapters need the platform's own id back (Slack's `reactions.add` got
`message_not_found`).
**Files:** `src/platform-id.ts`, `src/platform-id.test.ts` [COPY], `src/router.ts`,
`src/delivery.ts`.
**How to apply on U:**
- Append S's `agentScopedMessageId(baseId, agentGroupId)` (returns `${baseId}:${agentGroupId}`) and
  `platformMessageId(scopedId, agentGroupId)` (exact `:<agentGroupId>` suffix strip, else
  unchanged) to `src/platform-id.ts`, with S's doc comments.
- Copy `src/platform-id.test.ts` from S.
- `src/router.ts`: import `agentScopedMessageId` from `./platform-id.js`; in `messageIdForAgent`
  (U:690) return `agentScopedMessageId(id, agentGroupId)` with the comment
  `// Inverse: platformMessageId, applied at delivery.`
- `src/delivery.ts`: see 2.6 (the `messageId` rewrite and the `inReplyTo` argument).
**Verify:** `pnpm vitest run src/platform-id.test.ts`.

### 2.2 Envelope: reply_to as a session seq, highlighted quote, user_id and role [MERGE]
**Intent:** one numbering everywhere: `reply_to` names the replied message by the same `#N` seq
the tools take (absent when the original is not in the session); a partial quote is shown as
`highlighted`; each message carries the sender's platform `user_id` and the host-stamped nanoclaw
`role`.
**Files:** `runner:formatter.ts`, `runner:formatter.test.ts`.
**How to apply on U:** U's formatter changed only command parsing and echo rows; S's hunks apply at:
- import `getAgentMailbox` from `./mailbox/index.js`.
- `formatSingleChat` (U:261): replace the `replyAttr` line (U:268) with
```ts
  const replySeq = replyToSeq(msg, content.replyTo?.id);
  const replyAttr = replySeq != null ? ` reply_to="${replySeq}"` : '';
```
  add `const userAttr = senderAttrs(msg, content);` after `const fromAttr = originAttr(msg);`, and
  put `${userAttr}` right after `sender="${escapeXml(sender)}"` in the returned `<message ...>`.
- add after `formatSingleChat` (verbatim from S):
```ts
function replyToSeq(msg: MessageInRow, platformMessageId: unknown): number | null {
  if (platformMessageId == null || platformMessageId === '' || !msg.channel_type || !msg.platform_id) return null;
  try {
    return getAgentMailbox().operations.findSeqByPlatformMessageId(
      msg.channel_type,
      msg.platform_id,
      String(platformMessageId),
    );
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function senderAttrs(msg: MessageInRow, content: any): string {
  const senderId = extractSenderId(msg, content);
  const prefix = `${msg.channel_type}:`;
  const userId = senderId?.startsWith(prefix) ? senderId.slice(prefix.length) : senderId;
  const userAttr = userId ? ` user_id="${escapeXml(userId)}"` : '';
  const hostStamped =
    msg.channel_type !== 'agent' && (content.senderRole === 'owner' || content.senderRole === 'admin');
  const role = hostStamped ? ` role="${content.senderRole}"` : '';
  return userAttr + role;
}
```
  (carry S's doc comments for both).
- `formatReplyContext` (U:379): replace the return with
```ts
  const highlighted =
    typeof replyTo.quote === 'string' && replyTo.quote && replyTo.quote !== text
      ? ` highlighted="${escapeXml(replyTo.quote)}"`
      : '';
  return `\n  <quoted_message from="${escapeXml(sender)}"${highlighted}>${escapeXml(text)}</quoted_message>\n`;
```
  and update its doc comment as in S.
- `findSeqByPlatformMessageId` on the runner mailbox (rewritten on `readInbound()`) is section 02's
  (02-runner-typing.md, Cross-section notes, commit 2). Without it `replyToSeq` swallows the
  error and `reply_to` silently disappears.
- `runner:formatter.test.ts`: from S take the `getOutboundDb` import, the extended
  `insertMessage(..., opts?: { timestamp?; processAfter?; chat?; status? })` helper (inserts
  `channel_type`/`platform_id`, `channel_type = 'telegram'` when `chat` is set), the rewritten
  `reply_to + quoted_message rendering` cases (seq of a replied inbound row, seq of the agent's own
  delivered message, omitted when not in session, edit/reaction/longer-id rows never matched,
  lookup failure, highlighted fragment) and `describe('sender user_id and role')`. Keep U's added
  tests. The `attachment rendering` describe is commit 7's.
**Verify:** `cd container/agent-runner && bun test src/formatter.test.ts`.

### 2.3 Host stamps the sender role [MERGE]
**Intent:** the container cannot read `user_roles`, so the host stamps `senderRole` into a human's
inbound chat content; only the host can claim one (an adapter's or an agent's is dropped).
**Files:** `src/modules/permissions/db/user-roles.ts`, `src/router.ts`,
`src/router-sender-role.test.ts` [COPY], `src/modules/agent-to-agent/agent-route.ts` (+test).
**How to apply on U:**
- `user-roles.ts`, before `hasAdminPrivilege` (U:65), add S's `getRoleOverAgentGroup(userId,
  agentGroupId)`: `SELECT role FROM user_roles WHERE user_id = ? AND (agent_group_id IS NULL OR
  agent_group_id = ?)`, owner wins over admin, else `undefined`.
- `router.ts`:
  - import `getRoleOverAgentGroup` from `./modules/permissions/db/user-roles.js`; add
    `UserRoleKind` to the `./types.js` type import (U:38).
  - before `safeParseContent` (U:204), add S's `isChatKind`, exported `resolveSenderRole(event,
    userId, agentGroupId)` (role only for a chat message with a known user) and exported
    `stampSenderRole(content, role)` (non-JSON or array content unchanged; content without a role
    and without a `senderRole` key returned byte-identical; otherwise drop any `senderRole` and
    add the host's).
  - in the fan-out loop, before the engaged branch: `const senderRole = await
    resolveSenderRole(event, userId, agent.agent_group_id);` and pass it as a new last argument
    to both `deliverToAgent(...)` calls (engaged and accumulate).
  - `deliverToAgent` (U:518) gains `senderRole: UserRoleKind | undefined` as its last parameter;
    add `const isChat = isChatKind(event.message.kind);` at the top and use `isChat` for the
    command-gate condition. After `const messageId = messageIdForAgent(...)` (U:603):
    `const content = isChat ? stampSenderRole(event.message.content, senderRole) : event.message.content;`
    and use `content` instead of `event.message.content` in `writeSessionMessage` (U:611), the
    session-created event's `message.content` (U:627) and `fanInboundMessage` (U:678).
- `agent-route.ts`: in `performAgentRoute` wrap the forwarded content (U:315):
  `const forwardedContent = withoutHostStamps(forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id));`
  and add S's `withoutHostStamps(content)` after `forwardFileAttachments`, dropping only the
  top-level `senderRole` for now (commit 7 adds the attachment `stagedPath` strip; S has both).
  Test: S's `drops a senderRole the sending agent put in its content`.
**Verify:** `pnpm vitest run src/router-sender-role.test.ts src/modules/agent-to-agent`.

### 2.4 Default reply target is the last waking message in that chat [MERGE]
**Intent:** a batch's default reply answers the newest waking message in the first message's chat,
not old ambient context at the top of the batch.
**Files:** `runner:formatter.ts`, `src/modules/agent-to-agent/agent-route.ts` (doc comment only).
**How to apply on U:** in `extractRouting` (U:191), after `const first = ...`:
```ts
  const answered = waking
    .filter(
      (m) =>
        !isFailureNotice(m) &&
        m.channel_type === first?.channel_type &&
        m.platform_id === first.platform_id &&
        m.thread_id === first.thread_id,
    )
    .at(-1);
```
and `inReplyTo: (answered ?? first)?.id ?? null,` (U:200); extend the doc comment with S's last
sentence. In `agent-route.ts` the `in_reply_to` comment (U:145) becomes "sets this to the batch's
last waking inbound in its chat". Its runner test (`runner:cross-session-echo.test.ts`) is listed
by section 02.
**Verify:** `cd container/agent-runner && bun test`.

### 2.5 send_message `reply_to` and `quote` [MERGE]
**Intent:** the agent can answer a specific earlier message (`reply_to: N`, the envelope seq) and
highlight a verbatim part (`quote`); an explicit choice always shows as a reply.
**Files:** `runner:mcp-tools/core.ts`, `runner:mcp-tools/core.test.ts`,
`runner:mcp-tools/core.instructions.md`. `core.ts` is unchanged B..U.
**Why `extendTool` cannot carry it:** `extendTool` adds schema properties, a description suffix
and passthrough keys, and passthrough decorates only `kind: 'system'` payloads
(`withOutboundPassthrough` / `decorateContent` in `runner:db/messages-out.ts`); `send_message`
writes `kind: 'chat'`. `reply_to` must also change the row's `in_reply_to` column (not content),
after resolving the seq to a message id and checking it is in the destination chat, and `quote`
needs a length check and maps into a `replyIntent` object. That is handler logic, so this is a
minimal `core.ts` edit.
**How to apply on U:**
- after `resolveRouting` (U:49-64), add S's `resolveSeqTarget(seq)` (returns `{ messageId,
  routing }` or `{ error }` from `getMessageIdBySeq` / `getRoutingBySeq`) and
  `const MAX_QUOTE_LENGTH = 1024;`. Use it in `editMessage` (U:174-180) and `addReaction`
  (U:215-221) in place of the duplicated lookups:
```ts
    const target = resolveSeqTarget(seq);
    if ('error' in target) return err(target.error);
    const { messageId: platformId, routing } = target;
```
- `sendMessage`: description becomes S's ("...By default it answers the message you are replying
  to, shown as a reply only when newer messages came in after it. Pass reply_to to answer a
  specific earlier message, and quote to highlight the exact part you answer."); add schema
  properties `reply_to` (integer, "Message ID to reply to (the numeric id shown in messages);
  always shown as a reply.") and `quote` (string, "Part of the replied message to highlight,
  copied verbatim from its text (max ${MAX_QUOTE_LENGTH} chars). Dropped if it does not match.").
- in the handler, after the routing check:
```ts
    let inReplyTo = getCurrentInReplyTo();
    const quote = typeof args.quote === 'string' && args.quote ? args.quote : undefined;
    if (quote && quote.length > MAX_QUOTE_LENGTH) return err(`quote is longer than ${MAX_QUOTE_LENGTH} characters`);
    if (args.reply_to != null) {
      const replySeq = Number(args.reply_to);
      const target = resolveSeqTarget(replySeq);
      if ('error' in target) return err(target.error);
      if (target.routing.channel_type !== routing.channel_type || target.routing.platform_id !== routing.platform_id) {
        return err(`Message #${replySeq} is not in ${routing.resolvedName}`);
      }
      inReplyTo = target.messageId;
    }
    const explicit = args.reply_to != null || quote !== undefined;
```
  then `in_reply_to: inReplyTo` and
  `content: JSON.stringify({ text, ...(explicit ? { replyIntent: quote ? { quote } : {} } : {}) })`.
- `core.instructions.md`: add S's `### Replies and mentions` first paragraph ("Every `<message>`
  id, and its `reply_to`, uses the same `#N` numbering..."). The Telegram mention sentence is
  commit 7's.
- `core.test.ts`: S's `describe('send_message - reply_to and quote')` (4 cases; uses the existing
  `seedChannelDestination`, `seedInbound`, `publishReplyRoute` helpers).
**Verify:** `cd container/agent-runner && bun test src/mcp-tools/core.test.ts`.

### 2.6 Host reply threading and id rewrite at delivery [MERGE]
**Intent:** the host decides whether a reply shows as a reply box (`content.threadReply`): an
explicit `replyIntent` always; a default reply only when newer messages arrived in that chat after
the one it answers. Adapters get the answered platform id (`OutboundMessage.inReplyTo`) and clean
`messageId`s. Consumers: Telegram (7).
**Files:** `src/channels/adapter.ts`, `src/channels/channel-registry.ts`, `src/delivery.ts`,
`src/mailbox/types.ts`, `src/mailbox/sqlite/session-db.ts`, `src/mailbox/sqlite/index.ts`,
`src/mailbox/sqlite/schema.ts`, `src/mailbox/sqlite/session-db.test.ts`, `src/delivery.test.ts`.
**How to apply on U:**
- `adapter.ts`: `OutboundMessage` gains `inReplyTo?: string;` ("The adapter's own id of the
  inbound message this answers (agent scope stripped), when known."); `ChannelAdapter` gains
  `threadsReplies?: boolean;` with S's comment.
- `channel-registry.ts` `createChannelDeliveryAdapter`: `deliver` takes a trailing
  `inReplyTo?: string` and passes `...(inReplyTo ? { inReplyTo } : {})` into the adapter's
  `deliver` content object; add
  `threadsReplies(channelType, instance) { return getChannelAdapterExact(instance ?? channelType)?.threadsReplies === true; }`.
- `mailbox/types.ts`: add `export interface ReplyTarget { channelType: string | null; platformId:
  string | null; newerInChat: boolean; }` and `getReplyTarget(messageId: string): ReplyTarget |
  null;` on `InboundMailbox` (U:106, after `getMostRecentPeerSourceSessionId`).
- `session-db.ts`: import `type { ReplyTarget }` from `../types.js`; after
  `getInboundSourceSessionId` (U:320) add S's `getReplyTarget(db, messageId)`:
```ts
  const row = db.prepare('SELECT seq, channel_type, platform_id FROM messages_in WHERE id = ?').get(messageId) as
    | { seq: number; channel_type: string | null; platform_id: string | null }
    | undefined;
  if (!row) return null;
  const newer = db
    .prepare(
      `SELECT 1 FROM messages_in
       WHERE channel_type IS ? AND platform_id IS ? AND seq > ? AND kind IN ('chat', 'chat-sdk')
         AND id NOT LIKE '%:reaction:%' AND id NOT LIKE '%:edit:%'
       LIMIT 1`,
    )
    .get(row.channel_type, row.platform_id, row.seq);
  return { channelType: row.channel_type, platformId: row.platform_id, newerInChat: !!newer };
```
  and in `migrateDeliveredTable` (U:271), after the `status` column block:
  `db.prepare('CREATE INDEX IF NOT EXISTS idx_delivered_platform_message ON delivered(platform_message_id)').run();`
  (it serves the runner's `findSeqByPlatformMessageId`).
- `schema.ts`: after the `delivered` table (U:27-28) add
  `CREATE INDEX IF NOT EXISTS idx_delivered_platform_message ON delivered(platform_message_id);`.
- `sqlite/index.ts`: import `getReplyTarget`; in `wrapSqliteInbound` add
  `getReplyTarget: (messageId) => getReplyTarget(db, messageId),` next to U's
  `hasMessagesFromOtherAgents`.
- `delivery.ts`:
  - import `platformMessageId` from `./platform-id.js`.
  - `ChannelDeliveryAdapter.deliver` gains a trailing `inReplyTo?: string` ("Platform id of the
    inbound message being answered, agent scope stripped."); add
    `threadsReplies?(channelType: string, instance?: string): boolean;`.
  - add S's `resolveThreadReply(msg, content, session, instance)` (returns `undefined` unless
    `msg.inReplyTo`, channel and platform are set; skips any `content.operation` other than
    `send_media_group` and `content.type === 'ask_question'`; needs
    `deliveryAdapter?.threadsReplies?.(...)`; an object `replyIntent` returns `{ quote }` or `{}`;
    else reads `mailbox.getReplyTarget(inReplyTo)` through `withExistingMailboxSession` and returns
    `{}` only for the same chat with `newerInChat`; a read error logs at debug and returns
    `undefined`).
  - in `deliverMessage`, replace U's `deliveredContent` (U:537-541) with the merged form (keeps
    U's `fromAgent` marker):
```ts
  const rewritten: Record<string, unknown> = {};
  if (typeof content.messageId === 'string') {
    rewritten.messageId = platformMessageId(content.messageId, session.agent_group_id);
  }
  const threadReply = await resolveThreadReply(msg, content, session, deliverInstance);
  if (threadReply) rewritten.threadReply = threadReply;
  // Agent-asked questions keep their own markup (U).
  if (content.type === 'ask_question') rewritten.fromAgent = true;
  // Only the host decides on a reply box; the stored content's own key is not carried.
  const { threadReply: _stored, ...base } = content;
  const deliveredContent =
    Object.keys(rewritten).length > 0 || 'threadReply' in content
      ? JSON.stringify({ ...base, ...rewritten })
      : msg.content;
```
    and pass `msg.inReplyTo ? platformMessageId(msg.inReplyTo, session.agent_group_id) : undefined`
    as the new last `deliver(...)` argument. Commit 7 adds `emoji`/`rich` to `rewritten`; commit 12
    wraps `deliveredContent` in `presentOutbound`.
- Tests: `session-db.test.ts` S's `delivered platform_message_id index` (imports
  `migrateDeliveredTable`); `delivery.test.ts` S's `hands the adapter the replied-to inbound id with
  the agent scope stripped`, `describe('deliverSessionMessages - agent-scoped message ids')` and
  `describe('deliverSessionMessages - reply box')` minus its `rich` cases (commit 7) and the media
  group case until commit 7, with the `insertOperation` helper.
**Verify:** `pnpm vitest run src/delivery.test.ts src/mailbox src/channels`; `pnpm run build`.

### 2.7 Button clicks wait for inbound readiness [MERGE] (unplanned fix, placed here)
**Intent:** a button click replayed at startup must not wake a session before adoption or reach an
approval before the coordinator's handler, same as inbound messages. Not in U.
**Files:** `src/index.ts`, `src/startup-order.test.ts`.
**How to apply on U:** in `initChannelAdapters`'s setup, wrap `onAction`'s `dispatchResponse(...)`
in `inboundReady.then(() => dispatchResponse({...})).catch(...)` with S's two-line comment. Test:
S's `startup-order.test.ts` (the `respond`/`adoptedAtResponse` state, `getResponseHandlers: () =>
[state.respond]`, `channel.onAction('question', 'approve', 'fixture:user')`). Its
`host-lifecycle.js` mock gaining `onHostStart`/`onHostShutdown` is needed once any module calls
them at import (commit 13 / 12); harmless to add now.
**Verify:** `pnpm vitest run src/startup-order.test.ts`.

## Commit 5 - Per-agent compact window

### 5.1 Column as an idempotent module migration [ADAPT]
**Intent:** keep the per-agent `container_configs.auto_compact_window` column (NULL = default); the
live install has per-agent values, applied under the old core name
`container-configs-auto-compact-window` (D9).
**Files:** S `src/db/migrations/026-auto-compact-window.ts` and its two lines in
`src/db/migrations/index.ts` [DROP as core migration]; `src/db/container-configs.ts`.
**How to apply on U:** do not add a core migration. Register it at module scope in
`src/db/container-configs.ts`, next to the rich-messages migration from commit 7 (section 03):
`createContainerConfig` inserts the column, so the registration must load wherever that module
does (DB tests and scripts never import the modules barrel):
```ts
import { registerMigration } from './migrations/index.js'; // check `pnpm run build` for an import cycle

// Fork column; installs that ran the old core migration already have it, so skip when present.
registerMigration({
  version: 26,
  name: 'module:auto-compact-window:column',
  async up(db) {
    if ((await db.columnOwners?.('auto_compact_window'))?.includes('container_configs')) return;
    await db.exec('ALTER TABLE container_configs ADD COLUMN auto_compact_window INTEGER');
  },
});
```
`columnOwners` is implemented by U's SQLite driver (`src/db/drivers/sqlite.ts:144`). U's
`scripts/migrate.ts` does not load the module barrel; module migrations run at host start (SQLite
`auto` mode migrates).
**Verify:** `pnpm vitest run src/db`; on a copy of a fork DB the migration records itself and the
column keeps its values; on a fresh DB the column exists.

### 5.2 Row type, scalar writes, backfill, CLI [MERGE]
**Files:** `src/types.ts`, `src/db/container-configs.ts`, `src/backfill-container-configs.ts`,
`src/db/db-v2.test.ts`, `src/cli/resources/groups.ts`.
**How to apply on U:**
- `types.ts` `ContainerConfigRow`: `auto_compact_window: number | null;` after
  `max_messages_per_prompt` (U:29).
- `container-configs.ts`: `'auto_compact_window'` in `SCALAR_COLUMNS` after
  `'max_messages_per_prompt'` (U:11); `auto_compact_window` / `@auto_compact_window` after
  `max_messages_per_prompt` in the `createContainerConfig` INSERT column and value lists
  (U:31, U:35); `| 'auto_compact_window'` in the `updateContainerConfigScalars` Pick (U:87).
- `backfill-container-configs.ts`: `auto_compact_window: null,` after `max_messages_per_prompt`
  (U:61). `db-v2.test.ts` full-row fixture: `auto_compact_window: null,`.
- `groups.ts`: `presentConfig` shows `auto_compact_window: row.auto_compact_window,` (after U:84);
  add `--auto-compact-window` to the config-update description list (U:430) and the "Nothing to
  update" list (U:480); `| 'auto_compact_window'` in the updates Pick (U:448); after the
  `max_messages_per_prompt` line (U:469), using the canonical key only (U's `normalizeArgs`):
```ts
        if (args.auto_compact_window !== undefined) {
          const window = Number(args.auto_compact_window);
          if (!Number.isInteger(window) || window <= 0) {
            throw new Error('--auto-compact-window must be a positive integer (tokens)');
          }
          updates.auto_compact_window = window;
        }
```
**Verify:** `ncl groups config update --id <group> --auto-compact-window 400000` then
`ncl groups config get --id <group>` shows it; `pnpm vitest run src/cli src/db`.

### 5.3 Container env from the claude provider hook [ADAPT]
**Intent:** the group's value becomes `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the container env at
spawn; precedence group value, then the operator's env/.env value, then the runner's default.
**Files:** `src/providers/claude.ts` (upstream file), `src/providers/claude.test.ts`.
**How to apply on U:** confirmed against U: `registerProviderContainerConfig` throws on a second
registration for a name (`src/providers/provider-container-registry.ts:98-107`) and U's
`src/providers/claude.ts:14` already registers `'claude'`, so edit that existing callback (minimal,
unavoidable edit of an upstream file). `ctx.agentGroupId` is set on every spawn
(`src/container-runner.ts:1132`).
```ts
import { getContainerConfig } from '../db/container-configs.js';
...
registerProviderContainerConfig('claude', async (ctx) => {
  // Per-agent value (container_configs.auto_compact_window) wins over the operator default.
  let perAgent: number | null | undefined;
  try {
    perAgent = (await getContainerConfig(ctx.agentGroupId))?.auto_compact_window;
  } catch (err) {
    log.warn(`Could not read the group's ${KEY}; using the operator default`, { agentGroupId: ctx.agentGroupId, err });
  }
  if (perAgent != null && Number.isInteger(perAgent) && perAgent > 0) return { env: { [KEY]: String(perAgent) } };
  const value = ctx.hostEnv[KEY]?.trim() || readEnvFile([KEY])[KEY]?.trim();
  // ...U's existing validation and return, unchanged
});
```
The try/catch keeps U's `claude.test.ts` (no central DB) green (inferred). Add a test that runs
`initTestDb()` + `runMigrations()`, seeds a group with `auto_compact_window = 300000` while the
host env says `900000`, and expects `300000`; and NULL falls back to the env value.
**Verify:** `pnpm vitest run src/providers/claude.test.ts`.

### 5.4 Runner and container.json plumbing [DROP]
**Intent dropped:** S also threaded the value through `container.json` (`autoCompactWindow` in
`src/container-config.ts` `ContainerConfig` and `configFromDb`) into runner options. U's runner
already reads `process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`, so the host env from 5.3 is enough.
Do not add the `ContainerConfig.autoCompactWindow` field or its `configFromDb` line; the runner
hunks are dropped in section 02.

## Commit 3 - Turn state and typing (pointer)

The host half of upstream PR #3786 and the fork's typing extras are documented in section 02
(02-runner-typing.md, items 3.4 and 3.5); do not re-derive them here. In these files that is:
`src/mailbox/model.ts` + `model.test.ts` (`TurnState`, `optionalNullableOneOf`, `turn` on
`ContainerRecord`), `src/mailbox/types.ts`, `src/mailbox/index.ts`, `src/mailbox/sqlite/{index,schema,session-db}.ts`,
`src/mailbox/sqlite/sqlite.test.ts`, `src/delivery.ts` (`readPresence`, `notePresence`, the
`clearTyping`/`addReaction`/`removeReaction`/`typingRequiresThread` adapter members),
`src/delivery.test.ts` (turn cases), `src/host-sweep.test.ts` (`turn: null`, `updatedAt`),
`src/channels/adapter.ts`, `src/channels/channel-registry.ts` (+test),
`src/channels/chat-sdk-bridge.ts` (+test: `normalizeStatusText`, `setTyping(status)`,
`addReaction`, `removeReaction`, `clearTyping`), `docs/db-session.md`. Also the router's typing ack:
pass `event.message.id` as the new 7th `startTypingRefresh(...)` argument (U:648-655); the
`event.agentGroupId ? undefined :` guard around it is commit 12's. The status-text half
(`getState?`, `getSessionState`, `StateValue`, `live_status` tests) is dropped there.

## Commit 6 - Host chat commands (hunks in these files)

- `src/command-gate.ts` [ADAPT]: add S's `host` action (`GateResult` gains
  `{ action: 'pass'; normalizedText?: string }` and `{ action: 'host'; command: CommandName; args: string }`),
  `HOST_COMMANDS` from `COMMANDS` (`./commands/types.js`), `COMMAND_ALIASES = { '/new': '/clear' }`,
  `BANG_PREFIX_CHANNELS = new Set(['slack'])`, `KNOWN_COMMANDS`, `normalizeCommandText`,
  `commandArgs`, `classifyHostCommandFromText`, `classifyHostCommand(content, channelType)`,
  `applyNormalizedText`, and `gateCommand(content, userId, agentGroupId, channelType = null)`.
  On U, build them on `commandText` / `slashCommandName` from `src/slash-command.ts` instead of S's
  `extractText` / `commandToken` (U's parser already strips `@botname`); keep S's header comment
  (ASCII). Tests: S's added describes in `src/command-gate.test.ts` (use a placeholder bot name in
  the `@botname` case).
- `src/router.ts`: import `applyNormalizedText, classifyHostCommand, gateCommand` and
  `runHostCommand` from `./commands/fallback.js`; step 3b after `const agents = ...` (U:346) as in
  S; in `deliverToAgent` pass `event.channelType` to `gateCommand`, return on `gate.action ===
  'host'`, keep `normalizedText`, and store `applyNormalizedText(...)` before `stampSenderRole`
  (S order: materialize, normalize, stamp). Keep U's deny branch (direct deliver). `export` the
  `deliverToAgent` function (used by `src/commands/fallback.ts`).
- `src/modules/interactive/index.ts`: S's early `if (payload.questionId.startsWith('hcmd-')) return false;`
  with its comment.
- `CLAUDE.md`: S's `## Chat Commands` section (the `/voice` wording joins in commit 12).

## Commit 7 - Telegram (hunks in these files)

- `package.json` deps: `grammy` 1.46.0, `@grammyjs/auto-retry` 2.0.2, `@grammyjs/files` 1.2.0,
  `@grammyjs/parse-mode` 2.3.0, `effect` 4.0.0-beta.52, `mediabunny` 1.40.1, `openai` ^6.34.0
  (voice-note transcription, `src/transcription.ts`). The native command binding uses
  `@grammyjs/commands` 1.3.2 and `@grammyjs/menu` 1.3.1 (commit 6 or 7, whichever lands
  `telegram-grammy/commands/`).
- `tsconfig.json`: `target` and `lib` `ES2023` (Effect v4); keep U's `incremental` lines.
- `eslint.config.js`: `linterOptions: { reportUnusedDisableDirectives: 'off' }` (with S's comment),
  `'no-catch-all/no-catch-all': 'off'` (with S's rationale) and the `src/channels/telegram-grammy/**`
  override pinning `no-floating-promises` / `no-misused-promises` to `error`. eslint.config.js is
  unchanged B..U.
- `src/channels/index.ts`: S's telegram-grammy import with its two-line comment.
- `src/modules/index.ts`: `import './topic-autowire/index.js';`.
- `src/channels/adapter.ts`: `materialize?: () => Promise<void>` on `InboundEvent` and
  `InboundMessage`; `ResolvedReaction` and `resolveReaction?(emoji)` with S's comments.
  `src/channels/channel-registry.ts`: `resolveReaction(channelType, emoji, instance)` (import
  `ResolvedReaction`). `src/channels/ask-question.ts`: S's `OptionStyle` comment (Telegram maps
  primary to blue).
- `src/index.ts` `onInbound`: build the `InboundEvent` first and, when `message.materialize` is
  set, attach a memoized `event.materialize` that re-serializes `message.content` in `finally`
  (S verbatim); then `inboundReady.then(() => routeInbound(event))`.
- `src/router.ts` `deliverToAgent`: `try { await event.materialize?.(); } catch (err) { log.warn('Inbound message materialization failed', ...) }`
  after `messageIdForAgent`, before content is built. `src/host-core.test.ts`: S's two
  materialize tests.
- Staged attachments [ADAPT]: `src/inbox-safety.ts` no longer exists on U. Put S's
  `inboundStagingRoot()` (`<DATA_DIR>/inbound-staging`, host-only, never mounted),
  `STAGING_MAX_AGE_MS` and `sweepInboundStaging()` in a new `src/inbound-staging.ts` (name
  inferred). In U's `extractAttachmentFiles` (U `src/session-manager.ts:356`): first strip every
  `att.stagedPath` into a map (a host path never reaches the container, even when
  `inboxFolderName` refuses the id, so return `JSON.stringify(parsed)` then); take an attachment
  with `data` or a staged path; validate with S's `containedStagedFile` (lstat regular file,
  realpath inside the realpath of the staging root) else `att.error = 'the file is no longer available'`;
  name it `path.basename(staged)` and keep `att.name` (display label); write through the anchored
  inbox with `copyRegularFile(AnchoredDir.open(path.dirname(source), [])!, path.basename(source), inbox, filename)`
  (sync streaming copy; S's async `copyFile` + FICLONE is not replayed), EEXIST skips, any other
  error sets `att.error = \`could not be saved (${code})\``; `localPath` uses U's
  `inbox/${folder}/${filename}`. Tests: S's `extractAttachmentFiles: staged adapter downloads` and
  `sweepInboundStaging` in `src/session-manager.attachments.test.ts` (import the sweep from the new
  file).
- `src/host-sweep.ts`: `singleton:inbound-staging` running `sweepInboundStaging()` (try/catch,
  `log.error('Inbound staging sweep failed')`) and `tickQueue.add('singleton:inbound-staging')`;
  `src/reconcile.ts` `SINGLETON_KEYS` and `src/reconcile-queue.test.ts` (both noop maps) gain the key.
- `src/modules/agent-to-agent/agent-route.ts`: `withoutHostStamps` also strips each
  attachment's `stagedPath` (S's version); test `drops a stagedPath the sending agent put on an attachment`.
- Reactions: `src/delivery.ts` `resolveReaction?` on `ChannelDeliveryAdapter`, S's
  `writeOutboundNote` (non-waking `kind: 'chat'`, `channelType: 'agent'`, `sender: 'system'`,
  id `reaction-note-<msgId>`; drop the comment's canvas-actions reference, D7),
  `ReactionOutcome` / `resolveOutboundReaction`, the guard before reading outbox files (a `drop`
  writes its note and returns), `if (reaction.kind === 'substituted') rewritten.emoji = reaction.emoji;`
  and the substituted note after a successful `deliver`. Tests: S's `reaction fallback and feedback`.
- Rich messages: `src/types.ts` `rich_messages: number;`, `src/db/container-configs.ts`
  (`SCALAR_COLUMNS`, INSERT, Pick), `src/backfill-container-configs.ts` `rich_messages: 0,`,
  `src/db/db-v2.test.ts`, `src/container-config.ts` (`richMessages?: true` and
  `...(row.rich_messages === 1 ? { richMessages: true as const } : {})` in `configFromDb`),
  `src/cli/resources/groups.ts` (`rich_messages` shown `on`/`off`, `--rich-messages on|off`
  accepting on/true/1 and off/false/0 via `args.rich_messages`, else
  `'--rich-messages must be on or off'`) + S's groups.test describe, `src/delivery.ts` S's
  `richAllowed` with `rich: _rich` added to the destructure and `'rich' in content` to the
  re-serialize condition, and its two delivery tests. The column's migration
  (S 028, applied as `container-config-rich-messages`) becomes a module migration like 5.1 (D9),
  registered by the Telegram module; drop S's core import/array lines in `src/db/migrations/index.ts`.
- `src/db/messaging-groups.ts`: S's `isAgentWiredToChannel(agentGroupId, channelType)` (used by
  Telegram agent-docs, later Slack).
- Runner [ADAPT, D12]: put `send_media_group` in a new `runner:mcp-tools/media-group.ts`
  (`registerTools([sendMediaGroup])`, S's tool verbatim with a module-local
  `outboxRoot = () => process.env.NANOCLAW_OUTBOX_DIR ?? '/workspace/outbox'`) plus
  `media-group.instructions.md` holding S's `### Sending an album` paragraph (composed as
  `NanoClaw Module: media-group`; optionally gate it with
  `registerModuleSectionGate('media-group', (g) => isAgentWiredToChannel(g.id, 'telegram'))`).
  Leave `core.ts`'s header, `sendFile` and `registerTools` line as U has them. Import the new file
  from `runner:mcp-tools/index.ts` after `./core.js` (section 02's file).
  Rich: put `offerRichMessages()` in a new `runner:mcp-tools/rich-messages.ts` calling
  `extendTool('send_message', { properties: { rich: {...S's schema...} } })` once; the only
  `core.ts` edit is in `sendMessage`'s content:
  `...(args.rich === true && 'rich' in (sendMessage.tool.inputSchema.properties ?? {}) ? { rich: true } : {})`
  (passthrough cannot carry it: `kind: 'chat'`). The host still strips it unless the group allows.
  Section 02's `mcp-tools/index.ts` call then imports from `./rich-messages.js`.
- `runner:mcp-tools/core.ts` `add_reaction`: S's `TELEGRAM_REACTION_GLYPHS` constant and the
  longer `emoji` description (copy from S; its glyph list must match
  `ALLOWED_REACTION_GLYPHS` in the island's `reactions.ts`, whose test asserts it).
  `core.instructions.md`: S's add_reaction wording (`ok_hand` = done, fixed glyph set) and the
  Telegram mention sentence (`[Name](tg://user?id=<user_id>)`, never guess a handle).
  `core.test.ts`: S's `send_media_group` describe (needs S's `os`/`path` imports, `testRoot`,
  `agentDir`, `outboxDir` and the `NANOCLAW_OUTBOX_DIR` setup/teardown; import from
  `./media-group.js`) and `send_message - rich`.
- `runner:formatter.ts` `formatAttachments`: S's `error` branch (`[type: name <sep> failed: <error>]`)
  and `transcript: "..."` suffix on the saved and url/plain forms; use the same separator character
  U already uses in its `saved to` line. Tests: S's `attachment rendering` describe.
- `src/project-doc-compose.test.ts`: S's Telegram cases (`composes the Telegram formatting
  guide...`, `puts the formatting guide before the Rich messages section`, `composes the Rich
  Messages section only for...`) with the `wire` and `withRealContainer` helpers they need.
- `docs/db-central.md`: S's `rich_messages` column line, paragraph and Readers list; the
  migration-table row should name the module migration, not core "28".

## Commit 8 - Pond (hunks in these files)

- `src/container-runner.ts`: `import { pondStoreMounts } from './pond-stores.js';` and, before
  `return mounts;` in `buildMounts` (U:1367), `mounts.push(...pondStoreMounts(agentGroup.id, DATA_DIR));`
  with S's two-line comment.

## Commit 9 - Container (hunks in these files)

- `src/project-doc-compose.test.ts`: S's `carries the fork rules once, inside the Rules for every
  agent block` (needs `withRealContainer` and `composedSection`).

## Commit 10 - Slack (hunks in these files)

- `package.json`: `@chat-adapter/slack` comes from re-running `/add-slack` on U (pins 4.41.1,
  matching U's `chat`); do not carry S's 4.29.0.
- `src/channels/index.ts`: `import './slack.js'; import './slack-a2a-guard.js'; import './slack-a2a.js';`
  (dedupe against what `/add-slack` appends). `src/modules/index.ts`:
  `import './slack-room-membership/index.js'; import './slack-onboarding/index.js';`.
- `src/channels/chat-sdk-bridge.ts`: `type StateAdapter` import from `chat`, `MessageAuthor` type
  (and its use in the author projection and `onDirectMessage`, U:624, U:707-723),
  `InboundTextRewriter`, `rewriteInboundText?` on `ChatSdkBridgeConfig`, exported
  `applyTextRewrite`, and the rewrite call inside `if (message.raw)` before `appendRawText` (U:610).
  Tests: S's `rewriteInboundText` describe in `chat-sdk-bridge-inbound-policy.test.ts` (with the
  `makeMessage(text, raw?)` change) and `applyTextRewrite` describe in
  `chat-sdk-bridge-raw-text.test.ts`. Verify against chat 4.41.1 with `pnpm run build`.
- `src/project-doc-compose.test.ts`: S's Slack skills case, keeping only `slack-construct` in
  `SLACK_ONLY_SKILLS`.
- `.claude/skills/add-slack/REMOVE.md`: keep U's (it lists `slack-raw-text.*`, which the fork's
  Slack ships).

## Commit 11 - Jev gate (hunks in these files)

- `src/config.ts`: S's three Jev settings (endpoint, model, key) in the `readEnvFile` list and as
  exports, with S's comment.
- `src/router.ts`: `import { runJevGate } from './modules/jev-gate/index.js';`; in the fan-out
  split S's `ruleEngages` (rule result, gates key off it, and the accumulate condition
  `!(ruleEngages && (!accessOk || !scopeOk))`) from a mutable `engages`, plus the gate block and
  per-delivery `deliveryEvent` passed to both `deliverToAgent` calls.
- `src/cli/guard.ts`: `GROUP_JEV_GATE_COMMANDS` and the `groupJevGateCommand` allowance. U's guard
  now requires `group` to equal the caller for every group-scoped command, so S's extra
  "must name --group" DENY is redundant (inferred; keep it only if a test needs it).
  `src/cli/registry.ts` `GROUP_SCOPE_PARTIAL_RESOURCES = new Set(['wirings', 'jev-gate'])` and
  `src/cli/commands/help.ts` listing them for group scope. `src/cli/resources/index.ts`:
  `import './jev-gate.js';`.
- `src/project-doc-compose.test.ts`: S's jev-gate note cases (`writeGateEntry`,
  `resetGateConfigCache`, the `DATA_DIR` mock).

## Commit 12 - Voice-mode (pending; hunks in these files)

Recorded for the voice rebuild; re-check against the `/meet` work before replaying.
- `src/channels/adapter.ts`: `import type { Session }`, `routeInboundEvent?`, `agentGroupId?`,
  `onStored?`. `src/index.ts`: `routeInboundEvent: (event) => inboundReady.then(() => routeInbound(event)),`.
- `src/router.ts`: no interceptors for an `agentGroupId` event; skip other agents in the fan-out;
  `ruleEngages = !!event.agentGroupId || await evaluateEngage(...)`; `event.onStored?.(session)`
  after `writeSessionMessage`; the `event.agentGroupId ? undefined :` typing-ack guard.
  `src/router-session-created.test.ts`: S's `an event addressed to one agent group` describe.
- `src/channels/channel-defaults.ts`: `wiringThreadsEnabled(wiring, mg)` (imports
  `getChannelAdapter`, `MessagingGroupAgent`).
- `src/delivery.ts`: `expediteDelivery` / `stopExpediting` (and the call in `stopDeliveryPolls`),
  `OutboundAddress`, `OutboundPresentation`, `setOutboundPresentation`, `presentOutbound` wrapping
  the delivered content; tests in `delivery-poll.test.ts` and `delivery.test.ts` (`outbound presentation`).
- `src/request-wake.ts` (`'voice-call'` reason, delegation with the reason),
  `src/container-runner.ts` (`wakeContainer(session, reason?)`, `spawnContainer(session, wakeReason?)`,
  `ComposeSessionSpecInput.wakeReason`, `NANOCLAW_WAKE_REASON` in the env), and their tests
  (`request-wake.test.ts`, `container-restart.test.ts`, `container-runner.test.ts`).
- `src/group-persona.ts`: the optional `fileName` parameter.
- `src/channels/index.ts`: the voice-mode import. `package.json`: `@google/genai` 2.24.0,
  `@livekit/agents` (+ `-plugin-elevenlabs`, `-plugin-google`, `-plugin-silero`) 1.9.2,
  `@livekit/rtc-node` 1.1.0, `livekit-server-sdk` 2.19.1, `onnxruntime-node` 1.24.3, `zod` 4.6.5
  (added with the LiveKit path; a peer for the agents SDK, inferred) and the `voice-mode-worker`
  script. `pnpm-workspace.yaml`'s temporary `minimumReleaseAgeExclude` block is DROP: it expired
  2026-10-12 and those versions pass the age gate.
- `src/project-doc-compose.test.ts`: S's voice-mode-formatting cases.
- `.gitignore`: `.voice-mode-upgrade-backup/`. `docs/SECURITY.md`: S's `### 6. Sealed Host Secrets`.
  `docs/agent-runner-details.md`: `startsIdle` and the voice idle paragraph.

## Commit 13 - HTTP mailbox (hunks in these files)

- `src/mailbox/sqlite/index.ts`: `export function sqliteTimestamp`. `src/mailbox/sqlite/session-db.ts`:
  `openOutboundDbRw(dbPath, options?: Database.Options)`. The HTTP host mailbox must also serve
  `getReplyTarget` (2.6).
- `src/test-setup.ts`: the free-port `NANOCLAW_MAILBOX_HTTP_BIND` / `_PORT` lines (needs
  `src/test-utils/free-port.ts`). `setup/mailbox-compatibility.test.ts`: S's check
  (`typeof getAgentMailbox().session === 'function'`) instead of `instanceof SqliteAgentMailbox`.
- `docs/build-and-runtime.md`: S's `## Registry images (GHCR)` section (the fork's published images).

## Commit 14 - Docs (hunks in these files)

- `.gitignore`: `.claude/scheduled_tasks.lock` and `.eval-worktrees/` with their comments.
- `CLAUDE.md`: S's lint paragraph (`pnpm lint`, `no-catch-all` off, the island's stricter rules)
  and S's `## Per-agent Claude config` section, corrected (inferred): name
  `ncl groups config update --auto-compact-window` for the compact window instead of listing
  `autoCompactWindow` as a settings.json key, since the env pin shadows it.
- `docs/SECURITY.md`: S's `minimumReleaseAgeExclude` example in pnpm 10's list form
  (`- "some-package@1.2.3"`); U still shows the map form.

## Dropped in these files

- `CLAUDE.md` `### Credential grants (OneCLI, ...)`, `.claude/skills/debug/SKILL.md` auth
  paragraph and `docs/v1-to-v2-changes.md` OneCLI note: U rewrote the same text for the current
  grant model; take U's (D10).
- `src/modules/index.ts` `canvas-actions` and `slack-agent-flow` imports (D7).
- `src/project-doc-compose.test.ts` Slack-only module cases (`canvas`, `create-agent-slack`,
  `rooms`) and the `slack-construct-agents` skill (D7).
- `src/db/migrations/index.ts` (all three fork core imports and array entries; D9 module migrations instead).
- `package.json` `@onecli-sh/sdk` (installed and pinned by `/add-onecli`, commit 0).
- The `live_status` status-text read (see section 02).

## Cross-section notes

- Section 02 owns the runner mailbox `findSeqByPlatformMessageId` (commit 2), which 2.2 depends on,
  and the `runner:mcp-tools/index.ts` lines for commit 7; with 7's `rich-messages.ts` and
  `media-group.ts` files, that barrel imports `./media-group.js` and takes `offerRichMessages`
  from `./rich-messages.js`.
- Commit 6/7's `/context` and `/config` read and write `auto_compact_window` through
  `updateContainerConfigScalars`; that relies on 5.2's `SCALAR_COLUMNS` entry.
- Section 03 owns S `025-telegram-command-scopes.ts` and `028-container-config-rich-messages.ts`;
  both become `registerMigration` module migrations skipping an existing table/column (D9). Only
  the old core registrations in `src/db/migrations/index.ts` (this file) are dropped here.
- Every commit that registers prose (7, 10, 11, 12) uses 1.1's hooks; `isAgentWiredToChannel`
  lands with commit 7.
- Commit 13's HTTP host mailbox implements `getReplyTarget` (2.6) and returns `turn`/`updatedAt`
  (commit 3).
- Unplanned fixes placed by this section: 1.3 (persona read hardening) and 2.7 (button clicks
  wait for inbound readiness). Move them if the coordinator prefers a separate fix commit.
- Lockfile: never copy S's `pnpm-lock.yaml`; each commit that adds a dependency runs `pnpm install`
  and commits the regenerated lockfile.

## Files covered

.claude/skills/add-slack/REMOVE.md -> DROP (keep U's)
.claude/skills/debug/SKILL.md -> DROP (U rewrote the paragraph)
.gitignore -> 12 (.voice-mode-upgrade-backup); 14 (scheduled_tasks.lock, .eval-worktrees)
CLAUDE.md -> 6 (Chat Commands); 14 (lint note, per-agent config); DROP (Credential grants)
container/agent-runner/src/formatter.test.ts -> 2; 7 (attachment rendering)
container/agent-runner/src/formatter.ts -> 2; 7 (attachment error/transcript)
container/agent-runner/src/mcp-tools/core.instructions.md -> 2 (replies); 7 (album, reactions, Telegram mention)
container/agent-runner/src/mcp-tools/core.test.ts -> 2 (reply_to/quote); 7 (media group, rich)
container/agent-runner/src/mcp-tools/core.ts -> 2 (reply_to, quote, resolveSeqTarget); 7 (rich line, reaction glyphs; send_media_group moves to media-group.ts)
docs/SECURITY.md -> 12 (sealed secrets); 14 (minimumReleaseAgeExclude list form)
docs/agent-runner-details.md -> 12
docs/build-and-runtime.md -> 13
docs/db-central.md -> 7
docs/db-session.md -> 3 (section 02)
docs/v1-to-v2-changes.md -> DROP (U rewrote the line)
eslint.config.js -> 7
package.json -> 6/7 (grammY, effect, mediabunny, openai); 10 (via /add-slack); 12 (LiveKit, genai, onnxruntime, zod, script); 0 (@onecli-sh/sdk via /add-onecli)
pnpm-lock.yaml -> n/a (regenerated by pnpm install per commit)
pnpm-workspace.yaml -> DROP (expired temporary age exclusion)
setup/mailbox-compatibility.test.ts -> 13
src/backfill-container-configs.ts -> 5; 7
src/channels/adapter.ts -> 2 (inReplyTo, threadsReplies); 3 (section 02); 7 (materialize, resolveReaction); 12 (routeInboundEvent, agentGroupId, onStored)
src/channels/ask-question.ts -> 7
src/channels/channel-defaults.ts -> 12
src/channels/channel-registry.test.ts -> 3 (section 02)
src/channels/channel-registry.ts -> 2 (deliver inReplyTo, threadsReplies); 3 (section 02); 7 (resolveReaction)
src/channels/chat-sdk-bridge-inbound-policy.test.ts -> 10
src/channels/chat-sdk-bridge-raw-text.test.ts -> 10
src/channels/chat-sdk-bridge.test.ts -> 3 (section 02)
src/channels/chat-sdk-bridge.ts -> 3 (section 02); 10 (rewriteInboundText, MessageAuthor)
src/channels/index.ts -> 7; 10; 12
src/cli/commands/help.ts -> 11
src/cli/guard.ts -> 11
src/cli/registry.ts -> 11
src/cli/resources/groups.test.ts -> 7
src/cli/resources/groups.ts -> 5 (auto_compact_window); 7 (rich_messages)
src/cli/resources/index.ts -> 11
src/command-gate.test.ts -> 6
src/command-gate.ts -> 6
src/config.ts -> 11
src/container-config.ts -> 7 (richMessages); DROP (autoCompactWindow, 5.4)
src/container-restart.test.ts -> 12
src/container-runner.test.ts -> 12
src/container-runner.ts -> 1 (resolved skills); 8 (pondStoreMounts); 12 (wake reason)
src/db/container-configs.ts -> 5; 7
src/db/db-v2.test.ts -> 5; 7
src/db/messaging-groups.ts -> 7
src/db/migrations/026-auto-compact-window.ts -> 5 (becomes a module migration)
src/db/migrations/index.ts -> DROP (D9)
src/delivery-poll.test.ts -> 12
src/delivery.test.ts -> 2; 3 (section 02); 7; 12; DROP (live_status cases)
src/delivery.ts -> 2; 3 (section 02); 7; 12
src/group-persona.test.ts -> 1
src/group-persona.ts -> 1 (hardening); 12 (fileName)
src/host-core.test.ts -> 7
src/host-sweep.test.ts -> 3 (section 02)
src/host-sweep.ts -> 7
src/inbox-safety.ts -> 7 (ADAPT: moves to a new staging file; U deleted inbox-safety.ts)
src/index.ts -> 2 (onAction readiness); 7 (materialize); 12 (routeInboundEvent)
src/mailbox/index.ts -> 3 (section 02); DROP (StateValue)
src/mailbox/model.test.ts -> 3 (section 02)
src/mailbox/model.ts -> 3 (section 02)
src/mailbox/sqlite/index.ts -> 2 (getReplyTarget); 3 (section 02); 13 (sqliteTimestamp export); DROP (getState)
src/mailbox/sqlite/schema.ts -> 2 (delivered index); 3 (section 02)
src/mailbox/sqlite/session-db.test.ts -> 2
src/mailbox/sqlite/session-db.ts -> 2 (getReplyTarget, delivered index); 3 (section 02); 13 (openOutboundDbRw options); DROP (getSessionState)
src/mailbox/sqlite/sqlite.test.ts -> 3 (section 02); DROP (session state read)
src/mailbox/types.ts -> 2 (ReplyTarget); 3 (section 02); DROP (StateValue, getState)
src/modules/agent-to-agent/agent-route.test.ts -> 2; 7
src/modules/agent-to-agent/agent-route.ts -> 2 (comment, senderRole strip); 7 (stagedPath strip)
src/modules/index.ts -> 5 (auto-compact-window module); 7; 10; DROP (canvas-actions, slack-agent-flow)
src/modules/interactive/index.ts -> 6
src/modules/permissions/db/user-roles.ts -> 2
src/platform-id.test.ts -> 2
src/platform-id.ts -> 2
src/project-doc-compose.test.ts -> 1; 7; 9; 10; 11; 12; DROP (Slack-only modules, slack-construct-agents)
src/project-doc-compose.ts -> 1
src/providers/claude.test.ts -> 1; 5
src/reconcile-queue.test.ts -> 7
src/reconcile.ts -> 7
src/request-wake.test.ts -> 12
src/request-wake.ts -> 12
src/router-sender-role.test.ts -> 2
src/router-session-created.test.ts -> 12
src/router.ts -> 2; 3 (typing ack arg); 6; 7 (materialize); 11; 12
src/session-manager.attachments.test.ts -> 7
src/session-manager.ts -> 7 (ADAPT onto AnchoredDir)
src/startup-order.test.ts -> 2
src/test-setup.ts -> 13
src/types.ts -> 5; 7
tsconfig.json -> 7
