# Slack and the Jev wake-gate

Covers commits: 10, 11. Source S=098ed630, target U=f7440e85.

Reference used below: C=`c19e78fe` is the tip of upstream's `channels` branch at writing time
(the branch `/add-slack` copies its payload from). Run `git fetch upstream channels` in the
replay checkout first.

## How the fork's Slack tree maps onto upstream

Almost every Slack file at S is an upstream skill payload, not fork code:

- `/add-slack` (in-tree at U, payload copied from `channels`): `src/channels/slack.ts`,
  `slack-lib.ts`, `slack-a2a-guard.ts`, `slack-raw-text.ts`, their tests,
  `src/provisioning/slack-app.ts`, `container/skills/slack-formatting/`. The native
  `SLACK_INSTANCES` loop is in this payload (`slackInstanceBridgeFactory`), so multi-instance
  needs no fork code.
- `/slack-a2a-rooms` (in-tree at U): `src/channels/slack-a2a.ts` + test,
  `scripts/open-a2a-room.ts`. The fork's copies differ from U only in comments (`<bot_id>` vs
  `<botId>`); take U's.
- `/slack-agent-flow` (in-tree at U): step 3 copies room membership, onboarding, canvas,
  `slack-construct`, `src/env-file.ts` from `channels`; step 4 copies the flow itself
  (`src/modules/slack-agent-flow/`, `rooms`, `create-agent-slack`, `slack-construct-agents`,
  the finish script).

So: section 00 applies `/add-slack` and `/slack-a2a-rooms` (NOT `/slack-agent-flow`). Commit 10
hand-copies only the kept part of `/slack-agent-flow`'s step 3 (room membership, onboarding,
`slack-construct`) and adds the fork's real patches. Where S lags `channels` (C is newer in
`slack.ts`, `slack-a2a-guard.ts`, `slack-raw-text.ts`, `membership.ts`), take C and re-apply only
the fork hunks listed here.

The live install has one provisioned extra Slack instance (listed in `SLACK_INSTANCES`, its
tokens under `SLACK_*_<NAME>` keys) and a2a rooms set (`SLACK_A2A_ROOMS`). Both keep working
with no fork code: `slack.ts` reads `SLACK_INSTANCES` once at load (restart after an edit; the
flow's hot-start leaves with the flow), `slack-a2a.ts` re-reads `SLACK_A2A_ROOMS` /
`SLACK_A2A_MAX_HOPS` through `readEnvFile` on a ~30 s cache, and room membership reads and
appends `SLACK_A2A_ROOMS` through its own `readEnvValue` / `appendToEnvList`. Extra keys the flow
wrote (`SLACK_APP_ID_<NAME>`, `SLACK_INSTALL_URL_<NAME>`) become inert; leave `.env` alone.

## Commit 10 - Slack: multi-instance, a2a guard, room membership, onboarding

### Mention ids on inbound text [MERGE]
**Intent:** the adapter renders `<@U123>` as `@Display Name`, so agents could not mention people
back; the bridge re-attaches the id (`@Name (<@U123>)`), read from the adapter's own user cache
only.
**Files:** `src/channels/chat-sdk-bridge.ts`, `src/channels/chat-sdk-bridge-inbound-policy.test.ts`,
`src/channels/chat-sdk-bridge-raw-text.test.ts`, `src/channels/slack-raw-text.ts`,
`src/channels/slack-raw-text.test.ts`, `src/channels/slack.ts`,
`container/skills/slack-formatting/SKILL.md`.
**How to apply on U:**
1. The bridge seam and its tests apply cleanly to U (checked with `git apply --check`):
   `git show 54613f7c -- src/channels/chat-sdk-bridge.ts src/channels/chat-sdk-bridge-inbound-policy.test.ts src/channels/chat-sdk-bridge-raw-text.test.ts container/skills/slack-formatting/SKILL.md | git apply`.
   It adds `type StateAdapter` to the `chat` import, `export type InboundTextRewriter` after
   U's `RawTextExtractor` (`chat-sdk-bridge.ts:234`), `rewriteInboundText?: InboundTextRewriter`
   after `extractRawText?` in `ChatSdkBridgeConfig` (`:356`), `export function applyTextRewrite`
   before `createChatSdkBridge` (`:544`), and, inside `if (message.raw) {` just before the
   `appendRawText(...)` call (`:611`), the try/catch that runs
   `config.rewriteInboundText(message.raw, state)` and logs `Inbound text rewrite failed; keeping
   the adapter text` on throw. `chat-sdk-bridge.ts` is a core file; this hunk is commit 10's.
   The SKILL.md hunk adds one line after the `<!channel>` example:
   ``Incoming messages show a user mention as `@Display Name (<@U1234567890>)`. To mention that person back, write the `<@U1234567890>` part.``
2. `slack-raw-text.ts` (does NOT patch cleanly - C added `slackRawTextExtractor`): keep C's file
   and its `slackRawTextExtractor`, then add `import type { InboundTextRewriter } from './chat-sdk-bridge.js';`,
   `const USER_MENTION_RE = /<@([A-Z0-9_]+)(?:\|[^<>]*)?>/g;` under `MAX_TABLE_CHARS`, and append
   S's three exports verbatim at the end:
   `git show 098ed630:src/channels/slack-raw-text.ts | sed -n '58,120p'`
   (`slackMentionedUserIds`, `slackMentionAnnotator`, `createSlackMentionRewriter`). Update the
   header comment to name both recoveries (tables, mention ids).
3. `slack-raw-text.test.ts`: keep C's file; add `import type { StateAdapter } from 'chat';`, `vi`
   to the vitest import, `applyTextRewrite` to the bridge import, and
   `createSlackMentionRewriter, slackMentionAnnotator, slackMentionedUserIds` to the
   slack-raw-text import; append S's mention block verbatim:
   `git show 098ed630:src/channels/slack-raw-text.test.ts | sed -n '97,$p'`. In C's source-pin
   case ("keeps the default Slack factory wired to the extractor") change the import expectation
   to `"import { createSlackMentionRewriter, slackRawTextExtractor } from './slack-raw-text.js';"`
   and add `expect(source).toContain('rewriteInboundText: createSlackMentionRewriter(');`.
4. `slack.ts` (C's file from commit 0): change the import to
   `import { createSlackMentionRewriter, slackRawTextExtractor } from './slack-raw-text.js';` and
   add, right after `extractRawText: slackRawTextExtractor(slackAdapter),` in `createSlackBridge`:
   ```ts
       rewriteInboundText: createSlackMentionRewriter(() => slackAdapter.botUserId),
   ```
   Do not take S's `extractRawText: extractSlackRawText` (C's extractor skips table recovery on
   adapters >= 4.38.1, which U pins at 4.41.1) and do not drop C's `setSlackAuthorIsBotResolver`
   / `slackAuthorIsBot` (upstream additions S never had).
**Verify:** `pnpm exec vitest run src/channels/slack-raw-text.test.ts src/channels/chat-sdk-bridge-raw-text.test.ts src/channels/chat-sdk-bridge-inbound-policy.test.ts`.
The case "keeps the mentioned user id through the real adapter parse" proves the
`slack:user:<id>` cache key still holds on `@chat-adapter/slack` 4.41.1 (the fork ran 4.29.0).

### Form-encoded Web API reads [MERGE]
**Intent:** Slack read methods (`conversations.members`, ...) reject JSON bodies with
`invalid_arguments`; `slackCall` form-encodes an all-primitive body and keeps JSON for nested
ones. Room membership depends on it.
**Files:** `src/channels/slack-lib.ts`, `src/channels/slack-lib.test.ts`.
**How to apply on U:** applies cleanly onto C's files:
`git show 54613f7c -- src/channels/slack-lib.ts src/channels/slack-lib.test.ts | git apply`
(adds `encodeSlackBody()` above `slackCall` and uses its `contentType` / `encoded`; the tests
add `formBody()` and three request-shaping cases).
**Verify:** `pnpm exec vitest run src/channels/slack-lib.test.ts`.

### Resident-skill gate for `slack-construct` [MERGE]
**Intent:** the Slack room prose reaches only Slack-wired agents, whatever their skill
selection; named `slack-<name>` instances share `channel_type` `slack`.
**Files:** `src/channels/slack.ts`.
**How to apply on U:** needs commit 1's `registerResidentSkillGate` and
`isAgentWiredToChannel` (`src/db/messaging-groups.ts`). Add the imports
`import { isAgentWiredToChannel } from '../db/messaging-groups.js';` and
`import { registerResidentSkillGate } from '../project-doc-compose.js';` and append at the end
of the file:
```ts
// The Slack room prose reaches only Slack-wired agents, whatever their skill
// selection; every named slack-<name> instance shares channel_type 'slack'.
registerResidentSkillGate('slack-construct', (group) => isAgentWiredToChannel(group.id, 'slack'));
```
This is the only gate that survives: the `canvas`, `create-agent-slack`, `rooms` module gates
and the `slack-construct-agents` gate lived in dropped modules.
**Verify:** `src/project-doc-compose.test.ts` (commit 1's file) case "composes the Slack skills
for a Slack-wired agent on "all", and leaves them out for a Telegram-only one", with
`SLACK_ONLY_SKILLS = ['slack-construct']`.

### Room membership [COPY]
**Intent:** invite-to-room adoption, group-DM fork carry-over (including `SLACK_A2A_ROOMS`),
detach on removal, owner-presence access rule, polite decline + owner FYI for unknown DM
senders.
**Files:** `src/modules/slack-room-membership/{index.ts,membership.ts,membership.test.ts,env-file.ts,env-file.test.ts}`.
**How to apply on U:** no fork patches; S is an older `channels` copy. Take C:
`git show c19e78fe:src/modules/slack-room-membership/<file>` for all five (C's `membership.ts`
adds upstream's channels-only-bot DM pointer; it needs `fyiText` on `declineAndNotify`, present
at U). `env-file.ts` is the module's own two-helper copy (`readEnvValue`, `appendToEnvList`;
imports only `fs`/`path`) - D8's survivor. Append to `src/modules/index.ts`, after commit 7's
`import './topic-autowire/index.js';`:
```ts
import './slack-room-membership/index.js';
import './slack-onboarding/index.js';
```
**Verify:** `pnpm exec vitest run src/modules/slack-room-membership`.

### DM onboarding [COPY]
**Intent:** get-started suggested prompts in the agent DM and per-thread DM titles.
**Files:** `src/modules/slack-onboarding/{index.ts,onboarding.test.ts,thread-title.test.ts}`.
**How to apply on U:** `git show 098ed630:<path>` for all three (`index.ts` and
`onboarding.test.ts` equal C; `thread-title.test.ts` is C plus `void` before each
`sessionCreated(...)` call for the floating-promise lint). Registered by the barrel line above.
**Verify:** `pnpm exec vitest run src/modules/slack-onboarding`.

### `slack-construct` container skill [ADAPT]
**Intent:** standing Slack room rules (mention-driven engagement, owner-presence access, one
reply per prompt, `<dm-history>` continuity) composed for Slack-wired agents; the canvas rules
go with the dropped canvas tools.
**Files:** `container/skills/slack-construct/{SKILL.md,instructions.md}`.
**How to apply on U:** copy from S (equals C), then cut every canvas reference:
- `instructions.md`: heading becomes `## Slack rooms: mentions, access, ambient context`; drop
  ", each with its own canvas" from the intro sentence; drop the last sentence of the first
  bullet ("Comments channels differ - see the canvas rules."); delete the four bullets
  "The room canvas IS the room's contract", "Canvas comments reach every room agent", "Canvas
  edits follow the `canvas-work` skill", "Chat stays short; large output goes to the canvas"
  (inferred: the container rules block already covers brevity). Keep "Rooms engage only on
  @-mention", "One reply per prompt", "Access follows owner presence", "Persist durable facts",
  "`<dm-history>` lines" (U's runner renders `<dm-history>`).
- `SKILL.md`: description drops "room canvases"; body drops the `canvas-work` scope note (so
  "Two scope notes" becomes one) and replaces the stale `src/claude-md-compose.ts` with
  `src/project-doc-compose.ts`.
**Verify:** `rg -n -i 'canvas' container/skills/slack-construct` returns nothing.

### Slack unfurls pinned off [COPY]
**Intent:** every Slack post goes out with `unfurl_links: false` / `unfurl_media: false`; a
`@chat-adapter/slack` bump that drops it must fail a test (a call link in a reply must never be
fetched by Slack's unfurler).
**Files:** `src/channels/slack-unfurl.test.ts`.
**How to apply on U:** `git show 098ed630:src/channels/slack-unfurl.test.ts`. It reaches into
the adapter's private `_client.chat.postMessage`; if 4.41.1 renamed it, fix the stub, not the
assertion.
**Verify:** `pnpm exec vitest run src/channels/slack-unfurl.test.ts`.

### `slack-multi-instance` skill [COPY]
**Intent:** documents the native `SLACK_INSTANCES` key convention that U's `/add-slack` refers
to as `/slack-multi-instance`; there is no code to fold (the loop is in C's `slack.ts`).
**Files:** `.claude/skills/slack-multi-instance/SKILL.md`.
**How to apply on U:** `git show 098ed630:.claude/skills/slack-multi-instance/SKILL.md` (equals
C's copy).
**Verify:** `pnpm exec vitest run src/channels/slack-instances-registration.test.ts`.

### Payload files of the base skills that only the dropped flow used [KEEP as upstream ships them]
**Intent:** owner decision 2026-11-04: keep them. They are byte-identical upstream skill payload,
nothing kept imports them, and removing them would fight `/update-skills`, which copies them back.
**Files:** `src/provisioning/slack-app.ts`, `src/provisioning/slack-app.test.ts` (from
`/add-slack`), `scripts/open-a2a-room.ts` (from `/slack-a2a-rooms`).
**How to apply on U:** commit 0 applies both skills whole; commit 10 leaves these three alone. The
adapter path never loads `slack-app.ts`, U's setup wizard (`setup/channels/slack-auto.ts`
`loadProvisioningCore`) re-fetches it from `channels` on demand, and `open-a2a-room.ts` is only
named in `slack-a2a.ts` comments.

### Agent flow and canvas tools [DROP]
**Intent:** D7/D8 - the provisioned-sibling-bot `create_agent` wrapper, `create_room` /
`add_to_room`, room canvases, `canvas_read` / `canvas_update` and their prose leave the tree.
**Files:** `src/modules/slack-agent-flow/**`, `src/modules/canvas-actions/**`,
`container/agent-runner/src/mcp-tools/{canvas.ts,canvas.test.ts,canvas.instructions.md,rooms.ts,rooms.test.ts,rooms.instructions.md,create-agent-slack.instructions.md}`,
`container/skills/slack-construct-agents/**`, `scripts/slack-agent-flow-finish.ts`,
`src/env-file.ts`, `src/env-file.test.ts`, and the fork's edit to
`.claude/skills/slack-agent-flow/src/modules/slack-agent-flow/index.ts` (U's in-tree skill stays
exactly as U ships it).
**How to apply on U:** do not apply `/slack-agent-flow`; copy none of these. Kept-file hunks
that existed only for them, and must not be carried:
- `src/modules/index.ts`: `import './canvas-actions/index.js';` and
  `import './slack-agent-flow/index.js';` (S lines 29, 31).
- `container/agent-runner/src/mcp-tools/index.ts`: `import './canvas.js';` and
  `import './rooms.js';` (S lines 43-44).
- `container/skills/slack-construct/*` canvas prose (handled above).
- `src/project-doc-compose.test.ts` (commit 1): see Cross-section notes.
Proof at S (`git grep` over `src container setup scripts`): the dropped modules are imported
only by other dropped files, by the two barrel lines above, and by `src/project-doc-compose.test.ts:56-57`.
`src/env-file.js` is imported only by `src/env-file.test.ts` and
`src/modules/canvas-actions/handlers.ts:30`; `slack-room-membership/membership.ts:70` imports
its own `./env-file.js`. No kept file (`src/channels/slack*.ts`, room membership, onboarding,
`slack-construct`) imports anything dropped; the remaining mentions are comments
(`src/delivery.ts:467`, `src/channels/slack-a2a.ts`) and U trunk's own references
(`setup/channels/slack-auto*.ts`, `scripts/skill-directives.test.ts`, `channel-registry.ts`
hot-start comments).
**Verify:**
`rg -n "slack-agent-flow|canvas-actions|canvas_read|canvas_update|canvas-work|create_room|add_to_room|slack-construct-agents|env-file" src/channels src/modules/slack-room-membership src/modules/slack-onboarding src/modules/index.ts container/skills/slack-construct container/agent-runner/src/mcp-tools`
must print only `slack-room-membership`'s own `env-file` lines. `test ! -e src/env-file.ts`.

### Archive branch for the dropped code
Create it from S before the rebuild replaces main (it keeps every path at S):
```bash
git branch archive/slack-agent-flow 098ed630
git push origin archive/slack-agent-flow
```
Paths that matter on it: `src/modules/slack-agent-flow/` (15 files), `src/modules/canvas-actions/`
(4), `container/agent-runner/src/mcp-tools/{canvas,rooms}.{ts,test.ts,instructions.md}`,
`container/agent-runner/src/mcp-tools/create-agent-slack.instructions.md`,
`container/skills/slack-construct-agents/`, `container/skills/slack-construct/` (canvas prose
intact), `container/skills/canvas-work/`, `container/skills/welcome/addenda/teams-tour.md`,
`scripts/slack-agent-flow-finish.ts`, `scripts/open-a2a-room.ts`, `src/provisioning/slack-app.ts`
(+ test), `src/env-file.ts` (+ test), `.claude/skills/slack-agent-flow/`.

The seam it hooks: `src/modules/slack-agent-flow/index.ts` re-registers U's `create_agent`
delivery action over the one in `src/modules/agent-to-agent/index.ts`
(`registerDeliveryAction('create_agent', slackAwareCreateAgent, { guardAction: agentsCreate, precheck: validateCreateAgent, requestHold: ... })`),
and its wrapper runs `createAgent(content, session, { suppressCreatedNotify: true })` from
`agent-to-agent/create-agent.js` before the Slack leg; `agentsCreate` comes from
`agent-to-agent/guard.js`. It therefore must be imported after `./agent-to-agent/index.js` in
the modules barrel (boot logs `Delivery action handler overwritten` for `create_agent`). It also
registers `create_room` / `add_to_room` actions and a delivery batch preview, and needs U's
`startChannelAdapter` hot-start. To re-add later: apply U's in-tree `/slack-agent-flow` (it is
newer than S's copy - template-aware hold payload), then restore from the archive the prose
gates (`git show archive/slack-agent-flow:src/modules/slack-agent-flow/index.ts | tail -7`, the
`registerModuleSectionGate('canvas', ...)` line in `canvas-actions/index.ts`) and the canvas
bullets of `slack-construct/instructions.md`, and the files D7 removed above.

## Commit 11 - Jev ambient wake-gate

### Module [COPY]
**Intent:** a wiring widened to pattern-everything engages on every group message; the gate asks
Jev (typed-judgment API) per non-mention message and turns a `silent` verdict into accumulate,
fail-silent on any error, with daily cap / cooldown / bot-streak levers re-derived from a
host-written `jev` content key. Config is `data/jev-gate.json`, hot-reloaded.
**Files:** `src/modules/jev-gate/{index.ts,config.ts,history.ts,jev.ts,gate.test.ts}`,
`docs/jev-gate.md`.
**How to apply on U:** `git show 098ed630:<path>` for each. Not a barrel module: `router.ts`
imports it, and that import runs its `registerProjectDocSection` (commit 1 hook) adding the
"NanoClaw Module: jev-gate" note for agents whose gate is `live`. Dependencies: `history.ts`
imports `ALBUM_PREFIX`, `EDIT_LINK_SENDER`, `EDITED_PREFIX`, `REACTION_LINK_SENDER` from
`src/channels/telegram-grammy/inbound.ts` (commit 7); `findSessionForAgent`,
`withExistingMailboxSession`, `UserRoleKind` have the same signatures at U.
`docs/jev-gate.md` "Decision flow" step 5 is stale: say the verdict lands only in the host-written
`jev` metadata key and the host log, never in `text` (matches `index.ts`'s header; inferred fix).
**Verify:** `pnpm exec vitest run src/modules/jev-gate`.

### Config keys [MERGE]
**Intent:** `JEV_API_KEY` (no default: without it every judgment is silent), `JEV_URL`,
`JEV_MODEL` from `.env` or the process env.
**Files:** `src/config.ts`.
**How to apply on U:** add `'JEV_API_KEY', 'JEV_URL', 'JEV_MODEL',` to the `readEnvFile([...])`
list (`config.ts:10`) and the three exports after `EGRESS_NETWORK`:
`git show 098ed630:src/config.ts | sed -n '113,118p'`. Kept in `config.ts` (not the module)
because both test files mock `config.js` to set `JEV_API_KEY`.
**Verify:** `pnpm run build`.

### Router hook [MERGE]
**Intent:** after the access/scope gates, put a non-mention group message on a gated wiring to
Jev; a silent verdict flips `engages` off so it accumulates; the verdict rides a per-delivery
copy of the event (the fan-out loop shares `event` across wirings).
**Files:** `src/router.ts`, `src/router-jev-gate.test.ts`.
**How to apply on U:** U has no per-wiring engage seam, so this is an unavoidable upstream edit.
Add `import { runJevGate } from './modules/jev-gate/index.js';`. In `routeInbound`'s wiring loop
(U `router.ts:394-432`) rename `const engages = await evaluateEngage(...)` to `ruleEngages`,
compute `accessOk` / `scopeOk` from `ruleEngages`, then insert before `if (engages && accessOk && scopeOk) {`:
```ts
    let engages = ruleEngages;
    let deliveryEvent = event;
    const senderRole = await resolveSenderRole(event, userId, agent.agent_group_id);
    // is_group follows the file-wide convention: 0 means DM, anything else
    // (1 or a legacy NULL row) is a group - `=== 1` skipped real groups.
    if (ruleEngages && accessOk && scopeOk && !isMention && mg.is_group !== 0) {
      const gated = await runJevGate({ agent, mg, event, threadId: effectiveThreadId, senderRole });
      if (gated) {
        log.info('Jev gate', { agentGroupId: agent.agent_group_id, verdict: gated.annotation });
        deliveryEvent = gated.event;
        if (gated.silence) engages = false;
      }
    }
```
(the `is_group` comment's dash is ASCII-ized here; plus S's explanatory comment,
`git show 098ed630:src/router.ts | sed -n '468,474p'`). Both
`deliverToAgent(...)` calls pass `deliveryEvent` instead of `event`, and the accumulate
condition becomes `!(ruleEngages && (!accessOk || !scopeOk))`. `resolveSenderRole` and the
`senderRole` argument of `deliverToAgent` are commit 2's; if commit 2 already declares
`senderRole` in the loop, keep one declaration above the gate. Commit 12 later prefixes
`ruleEngages` with `!!event.agentGroupId ||` - not here. Copy the test from S.
**Verify:** `pnpm exec vitest run src/router-jev-gate.test.ts` (needs commit 7's staged
attachments for its attachment cases).

### `ncl jev-gate` resource [COPY + MERGE]
**Intent:** operator surface `ncl jev-gate get|update --group <id>`; a group-scoped agent may read
and, with approval, change only its own group's gate, and `ncl help` lists it.
**Files:** `src/cli/resources/jev-gate.ts`, `src/cli/resources/jev-gate.test.ts` [COPY];
`src/cli/resources/index.ts`, `src/cli/guard.ts`, `src/cli/registry.ts`,
`src/cli/commands/help.ts` [MERGE].
**How to apply on U:** copy the two resource files from S. Then:
- `resources/index.ts`: append `import './jev-gate.js';` (after U's `import './templates.js';`).
- `registry.ts`, after `GROUP_SCOPE_RESOURCES` (`:20`):
  ```ts
  // Resources a group-scoped agent may touch only through guard special-cases
  // (own-group wiring engage fields; own-group jev-gate with approval). Help
  // must list them or the agent cannot discover capabilities it actually has.
  export const GROUP_SCOPE_PARTIAL_RESOURCES = new Set(['wirings', 'jev-gate']);
  ```
- `help.ts`: import `GROUP_SCOPE_PARTIAL_RESOURCES` and widen the group-scope filter (`:27`) to
  `(r) => GROUP_SCOPE_RESOURCES.has(r.plural) || GROUP_SCOPE_PARTIAL_RESOURCES.has(r.plural)`.
  Leave U's per-resource auto-fill note (`:102`) as is.
- `guard.ts`: after `GROUP_WIRING_UPDATE_ARGS` (`:24`) add
  `const GROUP_JEV_GATE_COMMANDS = new Set(['jev-gate-get', 'jev-gate-update']);` with S's
  comment (`git show 098ed630:src/cli/guard.ts | sed -n '25,30p'`); in `commandDecide`'s
  `cliScope === 'group'` block add
  `const groupJevGateCommand = cmd.resource === 'jev-gate' && GROUP_JEV_GATE_COMMANDS.has(cmd.name);`,
  append `&& !groupJevGateCommand` to the whitelist DENY condition (`:80`), and right after that
  DENY:
  ```ts
    if (groupJevGateCommand && args.help !== true && args.group === undefined) {
      return DENY('Jev-gate commands must name the agent group with --group.');
    }
  ```
**Verify:** `pnpm exec vitest run src/cli/resources/jev-gate.test.ts`.

### Voice and `/meet` [n/a]
Nothing Jev-related at S is voice-specific any more (the voice end-of-turn shadow was removed
in `d6f79803`). The router's `event.agentGroupId` engage, and voice docs that mention `JEV_*`,
ride with the voice rebuild (commit 12).

## Cross-section notes

- **00:** Yes, `src/channels/slack.ts` is the `/add-slack` payload plus fork patches. Commit 0
  applies U's in-tree `/add-slack` (payload from `channels`, pins `@chat-adapter/slack@4.41.1`)
  and `/slack-a2a-rooms` (adds `import './slack-a2a.js';` to `src/channels/index.ts`). Do NOT
  apply `/slack-agent-flow`, and do not run the setup wizard's Slack leg on the rebuilt tree: U's
  wizard registers `/slack-a2a-rooms` + `/slack-agent-flow` as companions and would re-apply
  the flow. Runtime effect of the adapter jump 4.29.0 -> 4.41.1: sibling bots in a2a rooms now
  arrive as `slack:bot:U...` instead of `slack:bot:B...`; in a room whose
  `unknown_sender_policy` is not `public`, approve each sibling sender once more.
- **01:** `isAgentWiredToChannel` (`src/db/messaging-groups.ts`) is needed by commit 10's gate
  (and Telegram's). In `src/project-doc-compose.test.ts`: drop the imports
  `./modules/canvas-actions/index.js` and `./modules/slack-agent-flow/index.js` (S:56-57);
  `SLACK_ONLY_MODULES` has no members left (delete the module-gate cases or make them assert
  absence); `SLACK_ONLY_SKILLS` becomes `['slack-construct']`. The test also imports
  `./channels/slack.js` (S:55), which exists from commit 0 but registers its gate only after
  commit 10, and the jev-gate cases plus `resetGateConfigCache, writeGateEntry` import (S:13,
  47, 378-435) need commit 11 - land those test hunks with 10 and 11, or order the test edits
  accordingly.
- **02:** commit 11 consumes `resolveSenderRole(event, userId, agentGroupId)` and the
  `senderRole` parameter of `deliverToAgent`.
- **03:** the Slack typing overrides live in `src/channels/slack.ts` (this section's file): after
  `bridge.resolveChannelName = ...;` in `createSlackBridge` add
  `git show 098ed630:src/channels/slack.ts | sed -n '199,216p'` (`typingRequiresThread = true`,
  the `setTyping` wrapper defaulting the status to `SLACK_TYPING_STATUS`, and `clearTyping` via
  `setAssistantStatus(channel, threadTs, '')`) plus the `SLACK_TYPING_STATUS = 'is thinking...'`
  const (S:26-27); fit the `setTyping` wrapper to the signature commit 3 lands (it drops the
  status-text part). `src/channels/slack-typing.test.ts` is commit 3's [COPY].
- **04 / runner barrel:** `container/agent-runner/src/mcp-tools/index.ts` must not gain
  `./canvas.js` or `./rooms.js`.
- **07:** commit 11's `history.ts` imports four constants from
  `telegram-grammy/inbound.ts`; `router-jev-gate.test.ts` relies on staged inbound attachments.
- **09:** `container/skills/canvas-work/` and `container/skills/welcome/addenda/teams-tour.md`
  are dropped-flow payload: DROP them (they are on the archive branch).
  `container/skills/welcome/addenda/slack.md` "Shared rooms" mentions the room's canvas tab:
  cut that sentence (inferred).
- **Core (`src/delivery.ts`):** the `writeOutboundNote` comment names
  `canvas-actions/handlers.ts`; drop that reference (cosmetic).
- **12:** `slack-unfurl.test.ts` came from a voice commit but has no voice dependency; it is
  commit 10's.

## Files covered

```
.claude/skills/slack-agent-flow/src/modules/slack-agent-flow/index.ts -> DROP
.claude/skills/slack-multi-instance/SKILL.md -> 10
container/agent-runner/src/mcp-tools/canvas.instructions.md -> DROP
container/agent-runner/src/mcp-tools/canvas.test.ts -> DROP
container/agent-runner/src/mcp-tools/canvas.ts -> DROP
container/agent-runner/src/mcp-tools/create-agent-slack.instructions.md -> DROP
container/agent-runner/src/mcp-tools/rooms.instructions.md -> DROP
container/agent-runner/src/mcp-tools/rooms.test.ts -> DROP
container/agent-runner/src/mcp-tools/rooms.ts -> DROP
container/skills/slack-construct-agents/SKILL.md -> DROP
container/skills/slack-construct-agents/instructions.md -> DROP
container/skills/slack-construct/SKILL.md -> 10
container/skills/slack-construct/instructions.md -> 10
container/skills/slack-formatting/SKILL.md -> 10 (file from commit 0 /add-slack; one line here)
docs/jev-gate.md -> 11
scripts/open-a2a-room.ts -> 0 (upstream /slack-a2a-rooms payload, kept as shipped)
scripts/slack-agent-flow-finish.ts -> DROP
src/channels/slack-a2a-guard.test.ts -> n/a (commit 0 /add-slack payload; no fork patch, C is newer)
src/channels/slack-a2a-guard.ts -> n/a (commit 0 /add-slack payload; no fork patch, C is newer)
src/channels/slack-a2a.test.ts -> n/a (commit 0 /slack-a2a-rooms payload, identical)
src/channels/slack-a2a.ts -> n/a (commit 0 /slack-a2a-rooms payload; fork diff is comments only)
src/channels/slack-instances-registration.test.ts -> n/a (commit 0 /add-slack payload, identical)
src/channels/slack-lib.test.ts -> 10
src/channels/slack-lib.ts -> 10
src/channels/slack-raw-text.test.ts -> 10
src/channels/slack-raw-text.ts -> 10
src/channels/slack-registration.test.ts -> n/a (commit 0 /add-slack payload; no fork patch, C is newer)
src/channels/slack-typing.test.ts -> 3
src/channels/slack-unfurl.test.ts -> 10
src/channels/slack.ts -> 10 (file from commit 0; typing hunk -> 3)
src/cli/resources/jev-gate.test.ts -> 11
src/cli/resources/jev-gate.ts -> 11
src/env-file.test.ts -> DROP
src/env-file.ts -> DROP
src/modules/canvas-actions/canvas-actions.test.ts -> DROP
src/modules/canvas-actions/canvas-api.ts -> DROP
src/modules/canvas-actions/handlers.ts -> DROP
src/modules/canvas-actions/index.ts -> DROP
src/modules/jev-gate/config.ts -> 11
src/modules/jev-gate/gate.test.ts -> 11
src/modules/jev-gate/history.ts -> 11
src/modules/jev-gate/index.ts -> 11
src/modules/jev-gate/jev.ts -> 11
src/modules/slack-agent-flow/env-file.test.ts -> DROP
src/modules/slack-agent-flow/env-file.ts -> DROP
src/modules/slack-agent-flow/guard.ts -> DROP
src/modules/slack-agent-flow/index.ts -> DROP
src/modules/slack-agent-flow/orchestrate.test.ts -> DROP
src/modules/slack-agent-flow/orchestrate.ts -> DROP
src/modules/slack-agent-flow/provision.congruence.test.ts -> DROP
src/modules/slack-agent-flow/provision.prefetch.test.ts -> DROP
src/modules/slack-agent-flow/provision.ts -> DROP
src/modules/slack-agent-flow/room-actions.test.ts -> DROP
src/modules/slack-agent-flow/room-actions.ts -> DROP
src/modules/slack-agent-flow/room-canvas.test.ts -> DROP
src/modules/slack-agent-flow/room-canvas.ts -> DROP
src/modules/slack-agent-flow/slack-deps.ts -> DROP
src/modules/slack-agent-flow/types.ts -> DROP
src/modules/slack-onboarding/index.ts -> 10
src/modules/slack-onboarding/onboarding.test.ts -> 10
src/modules/slack-onboarding/thread-title.test.ts -> 10
src/modules/slack-room-membership/env-file.test.ts -> 10
src/modules/slack-room-membership/env-file.ts -> 10
src/modules/slack-room-membership/index.ts -> 10
src/modules/slack-room-membership/membership.test.ts -> 10
src/modules/slack-room-membership/membership.ts -> 10
src/provisioning/slack-app.test.ts -> 0 (upstream /add-slack payload, kept as shipped)
src/provisioning/slack-app.ts -> 0 (upstream /add-slack payload, kept as shipped)
src/router-jev-gate.test.ts -> 11
```
