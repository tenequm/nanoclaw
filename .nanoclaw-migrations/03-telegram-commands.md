# Host chat commands and the Telegram grammY channel

Covers commits: 6, 7. Source S=098ed630, target U=f7440e85.

Commit 6 is channel-agnostic: the command service, the router backstop that answers commands on any
channel, and the gate changes. Commit 7 adds the Telegram island, which also binds the same commands
natively (menus, popup scopes). Commit 6 depends on commit 5 (the `auto_compact_window` column);
commit 7 depends on commits 1, 2, 5 and 6.

Upstream changes the replay must fit (checked B=66f0823a -> U):

- `src/channels/adapter.ts`, `channel-registry.ts`, `channel-defaults.ts` and `src/channels/index.ts`
  are byte-identical B -> U. The adapter contract did not move; every fork addition to it is a
  fork hunk (listed below with its commit).
- `chat` went 4.29.0 -> 4.41.1, and upstream's `/add-telegram` now pins `@chat-adapter/telegram@4.41.1`.
  The island does not use a Chat SDK adapter, but `formatter.ts` imports markdown helpers from
  `chat`. Every name it imports (`parseMarkdown`, `walkAst`, `tableToAscii`, `toPlainText`, the
  `is*Node` guards, `link`, `paragraph`, `strong`, `text`, `MdastTable`, `TableCell`, `Content`,
  `List`, `Root`) is still exported from `chat@4.41.1`'s main entry (checked against the published
  `dist/index.d.ts`).
- `src/slash-command.ts` (new, #4062): `commandText(content)` and `slashCommandName(text)` are the
  one parse shared by the gate and the runner (`container/agent-runner/src/slash-command.generated.ts`).
  `command-gate.ts` must use them (commit 6). Do not edit `slash-command.ts`.
- Router #4119: the gate's permission-denied reply now goes out through `getDeliveryAdapter().deliver`
  instead of `writeOutboundDirect`; `writeOutboundDirect`'s doc now says outbound.db belongs to the
  container (a concurrent host write can be lost on a VM file share such as Docker Desktop).
- `src/inbox-safety.ts` is deleted (#4063, replaced by `src/anchored-dir.ts`), and
  `extractAttachmentFiles` in `session-manager.ts` was rewritten around anchored dirs and
  `inboxFolderName()`. The fork's staged-attachment helpers lived in `inbox-safety.ts`.
- Delivery now stamps `fromAgent: true` onto every `ask_question` read from outbound.db (#4136), and
  the Chat SDK bridge escapes host-built card text and splits long cards. The island ignores
  `fromAgent` and already splits long card bodies, so nothing changes in it.
- `src/db/migrations/index.ts` already uses version 25 for upstream's `025-container-config-speed`.
  The fork's file-number collision goes away with D9 (module migrations).

## Commit 6 - Host chat commands

### Command service and router fallback [COPY]
**Intent:** host-owned `/status` (members), `/model`, `/config`, `/restart`, `/voice` (admins) inspect
and retune an agent from chat without waking or reaching the container. The SDK's native `/model` and
`/status` would shadow them otherwise, and their effects would not persist.
**Files:** `src/commands/auth.ts`, `cards.ts`, `fallback.ts`, `format.ts`, `format.test.ts`,
`index.ts`, `service.ts`, `service.test.ts`, `transcript.ts`, `transcript.test.ts`, `types.ts`,
`types.test.ts`, `typography.test.ts`; `docs/chat-commands.md`.
**How to apply on U:** `git show 098ed630:<path> > <path>` for each. Every import resolves at U
unchanged (checked symbol by symbol: `openInboundDb`, `openOutboundDb`, `countDueMessages`,
`inboundDbPath`, `outboundDbPath`, `sessionsBaseDir`, `writeOutboundDirect`, `resolveSession`,
`restartAgentGroupContainers`, `isContainerRunning`, `killContainer`, `registerResponseHandler`,
`getRegisteredChannelNames` all exist with the same signatures). Then:
- The commit 5 dependency: `service.ts` reads and writes `container_configs.auto_compact_window`
  (`getStatus` shows context used against the window, `setConfigValue('auto-compact-window')` writes
  it through `updateContainerConfigScalars`). There is no `/context` command; the window shows on
  `/status` and is set from `/config`. `DEFAULT_AUTO_COMPACT_WINDOW = 165000` in `types.ts` mirrors
  U's runner default (`container/agent-runner/src/providers/claude.ts`), still 165000 at U.
- Comment fixes for commit 5's mechanism (the column now reaches the container through the host's
  `registerProviderContainerConfig('claude')` env, not container.json and the runner): the header
  paragraph of `service.ts` ("threaded into the container env ... container.json -> agent-runner")
  and `docs/chat-commands.md` (the paragraph starting "`auto-compact-window` is a `container_configs`
  column"). Rewrite both to: the column is read at spawn by the host and set as
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the container env; NULL means the runner's 165k default.
- `docs/chat-commands.md` "Startup scope janitor" step 2 says "(migration 025)"; change it to the
  module migration name from commit 7 (`module:telegram:command-scopes`).
- `fallback.ts` keeps `writeOutboundDirect` on purpose: the `/model` picker card must go through
  delivery so it persists a `pending_questions` row. Fix its header sentence "exactly as the router's
  permission-deny path does" (no longer true at U). Known U caveat: these host writes can race a
  running container's outbound.db writes on a VM file share; on a Linux host they are safe (inferred).
- `/voice` needs no voice files here: `fallback.ts` logs and drops it when the voice-mode skill
  did not answer first, and `offersVoiceCommand()` only checks `getRegisteredChannelNames()`.
**Verify:** `pnpm run build`; `pnpm exec vitest run src/commands`.

### Command gate: host commands, bang prefix, `/new` alias [MERGE]
**Intent:** classify the five host commands so the router can claim them once per message; let Slack
users type `!status` etc. (Slack's client eats unknown `/`); alias `/new` to `/clear`; rewrite a
bang/alias admin command to its canonical slash form so the container only sees canonical commands.
**Files:** `src/command-gate.ts` (and its test hunks in `src/command-gate.test.ts`, owned by section
01, which belong to this commit).
**How to apply on U:** start from U's file (it already imports `commandText, slashCommandName` from
`./slash-command.js`). Keep U's `FILTERED_COMMANDS`, `ADMIN_COMMANDS` and `isAdmin`. Add the S
header bullets (host commands are claimed by the host; bang prefix on channels whose client eats
`/`; ASCII-only typography rule). Replace S's private `extractText` with U's `commandText` and S's
private `commandToken` with `slashCommandName(...) ?? ''`. The result:

```ts
import { COMMANDS, type CommandName } from './commands/types.js';
// ...U's other imports unchanged...

export type GateResult =
  | { action: 'pass'; normalizedText?: string }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'host'; command: CommandName; args: string };

// ...U's FILTERED_COMMANDS and ADMIN_COMMANDS...

/** Bare command names the host claims (/model, /status, /config, /restart, /voice). */
const HOST_COMMANDS = new Set<string>(Object.keys(COMMANDS));

/** Typed name -> canonical command. Applied on both prefixes, all channels. */
const COMMAND_ALIASES: Record<string, string> = { '/new': '/clear' };

/** Channels whose client eats '/' - '!' is accepted as a command prefix there. */
const BANG_PREFIX_CHANNELS = new Set(['slack']);

const KNOWN_COMMANDS = new Set([
  ...FILTERED_COMMANDS,
  ...ADMIN_COMMANDS,
  ...[...HOST_COMMANDS].map((name) => `/${name}`),
]);

/** Everything after the first whitespace run, trimmed. '' when there is none. */
function commandArgs(text: string): string {
  const m = text.match(/^\S+\s+([\s\S]*)$/);
  return m ? m[1].trim() : '';
}

/**
 * Rewrite `!name` (bang channels) and aliased names to the canonical `/name`,
 * preserving everything after the first token. Returns null when no rewrite
 * applies - unknown `!foo` stays untouched by design.
 */
function normalizeCommandText(text: string, channelType: string | null): string | null {
  const match = text.match(/^\S+/);
  if (!match) return null;
  const token = match[0];

  let canonical: string | null = null;
  if (token.startsWith('!')) {
    if (!channelType || !BANG_PREFIX_CHANNELS.has(channelType)) return null;
    const slashed = `/${token.slice(1).toLowerCase()}`;
    const resolved = COMMAND_ALIASES[slashed] ?? slashed;
    if (KNOWN_COMMANDS.has(resolved)) canonical = resolved;
  } else if (token.startsWith('/')) {
    canonical = COMMAND_ALIASES[slashCommandName(text) ?? ''] ?? null;
  }

  if (!canonical || canonical === token) return null;
  return canonical + text.slice(token.length);
}

/** Host-command classification from bare text, split out so the router can claim it before the fan-out. */
export function classifyHostCommandFromText(
  text: string,
  channelType: string | null = null,
): { command: CommandName; args: string } | null {
  const normalized = normalizeCommandText(text, channelType) ?? text;
  const name = slashCommandName(normalized)?.slice(1);
  if (!name || !HOST_COMMANDS.has(name)) return null;
  return { command: name as CommandName, args: commandArgs(normalized) };
}

/** Router-facing wrapper: classify from a raw content envelope (JSON or plain). */
export function classifyHostCommand(
  content: string,
  channelType: string | null = null,
): { command: CommandName; args: string } | null {
  return classifyHostCommandFromText(commandText(content), channelType);
}

export async function gateCommand(
  content: string,
  userId: string | null,
  agentGroupId: string,
  channelType: string | null = null,
): Promise<GateResult> {
  let text = commandText(content);
  const normalizedText = normalizeCommandText(text, channelType);
  if (normalizedText !== null) text = normalizedText;

  // The runner names commands with the same parse, so what is gated here is
  // exactly what it executes.
  const command = slashCommandName(text);
  if (command === null) return { action: 'pass' };

  const host = classifyHostCommandFromText(text);
  if (host) return { action: 'host', command: host.command, args: host.args };

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (await isAdmin(userId, agentGroupId)) {
      return normalizedText !== null ? { action: 'pass', normalizedText } : { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  return { action: 'pass' };
}
```

Then copy `applyNormalizedText(content, normalizedText)` verbatim from S (it sits between
`gateCommand` and `isAdmin`; it rewrites only the `text` field of JSON content, or returns
`normalizedText` for plain content). S's comment on `commandToken` names a concrete bot username;
use a placeholder (`/model@examplebot`) if any such comment is kept.
**Verify:** `pnpm exec vitest run src/command-gate.test.ts` with the fork's added cases (bang prefix,
alias, `host` action, `@bot` suffix); `rg -n "extractText|function commandToken" src/command-gate.ts`
returns nothing.

### Router: claim host commands before the fan-out [MERGE]
**Intent:** answer a host command once per message, independent of per-agent engage rules, and never
store it inbound; store bang/alias admin commands in canonical form.
**Files:** `src/router.ts`.
**How to apply on U:**
1. Imports: `import { applyNormalizedText, classifyHostCommand, gateCommand } from './command-gate.js';`
   and `import { runHostCommand } from './commands/fallback.js';`.
2. In `routeInbound`, right after `const agents = await getMessagingGroupAgents(mg.id);` (U
   `src/router.ts:346`, before the "4. Fan-out" comment), insert verbatim from S:

```ts
  // 3b. Host chat-commands (/model, /status, /config, /restart, /voice) are owned by
  //     the host and answered ONCE per message, independent of per-agent
  //     engage rules (a slash command need not @mention the bot to be
  //     honored). On Telegram the native binding intercepts these at the
  //     adapter so they never reach here; this is the channel-agnostic
  //     backstop for every other channel (Slack types them as `!name`,
  //     normalized by the gate), and for Telegram when the native binding is
  //     absent. No channel-specific branching: the fallback renders uniformly.
  if (event.message.kind === 'chat' || event.message.kind === 'chat-sdk') {
    const host = classifyHostCommand(event.message.content, event.channelType);
    if (host) {
      try {
        await runHostCommand({
          command: host.command,
          args: host.args,
          mg,
          event,
          userId,
          agents,
          adapterSupportsThreads: adapter?.supportsThreads === true,
        });
      } catch (err) {
        log.error('Host command handler threw', { command: host.command, messagingGroupId: mg.id, err });
      }
      return;
    }
  }
```
   `adapter` is U's `const adapter = getChannelAdapter(...)` (`src/router.ts:229`). If U's
   `no-catch-all` rule is still `warn` at this point, add U's disable-comment style above `catch`.
3. In `deliverToAgent`, the gate block (U `src/router.ts:563`): pass `event.channelType` as the 4th
   argument; declare `let normalizedText: string | undefined;` before the block; inside it add, after
   the `filter` branch,

```ts
    if (gate.action === 'host') {
      // Claimed once per message at step 3b; a 'host' row reaching the per-agent
      // gate came by another entry path (e.g. CLI replay) - drop it, never store it.
      return;
    }
    if (gate.action === 'pass' && gate.normalizedText !== undefined) {
      normalizedText = gate.normalizedText;
    }
```
   Keep U's `deny` branch (direct delivery) as is.
4. Before `writeSessionMessage`, compute
   `const rawContent = normalizedText !== undefined ? applyNormalizedText(event.message.content, normalizedText) : event.message.content;`
   and feed `rawContent` into commit 2's sender-role stamp, so the line reads
   `const content = isChat ? stampSenderRole(rawContent, senderRole) : rawContent;` (S shape).
   The rewrite must run after commit 7's `event.materialize?.()` call, which replaces
   `event.message.content`; commit 7 inserts that call above this line.
**Verify:** `pnpm exec vitest run src/router*.test.ts src/command-gate.test.ts`;
`rg -n "3b. Host chat-commands" src/router.ts`.

### Interactive module skips host-command cards [MERGE]
**Intent:** `hcmd-` questionIds belong to `src/commands/fallback.ts`; the generic handler must not
route their taps into a container that never asked.
**Files:** `src/modules/interactive/index.ts` (unchanged B -> U).
**How to apply on U:** first statement of `handleInteractiveResponse` (U line 20), before the
`hasTable` check:

```ts
  // Host-command cards ('hcmd-' questionIds) are owned by the host command
  // fallback handler (src/commands/fallback.ts), which routes the tap without
  // ever waking a container. Skip them here so registration order between the
  // two handlers never matters.
  if (payload.questionId.startsWith('hcmd-')) return false;
```
**Verify:** `rg -n "hcmd-" src/modules/interactive/index.ts src/commands/fallback.ts`; tap a `/model`
picker button on a non-Telegram channel and see the model change with no container wake.

## Commit 7 - Telegram grammY channel

### The island [COPY]
**Intent:** native grammY adapter in an Effect-TS v4 island that sends `{text, entities}` (never
`parse_mode`), with forum topics as per-topic messaging groups (`telegram:<chatId>:<topicId>`),
voice-note transcription, albums, self-hosted Bot API support, colored ask-question buttons that
reflect the tapped option, nearest-allowed reaction fallback, opt-in Rich Messages, and the native
chat-command binding. It replaces upstream's Chat SDK Telegram adapter (D1).
**Files:** `src/channels/telegram-grammy/` - `agent-docs.ts`, `ask-question.ts`, `attachments.ts`,
`errors.ts`, `formatter.ts`, `inbound.ts`, `index.ts`, `layers.ts`, `media-meta.ts`, `outbound.ts`,
`pairing-interceptor.ts`, `reactions.ts`, `runtime.ts`, `services.ts`, `supervise.ts`,
`topic-map.ts`, their `.test.ts` files, and `commands/` (`command-group.ts`, `commands.test.ts`,
`context.ts`, `grants.ts`, `grants.test.ts`, `index.ts`, `menus.ts`, `render.ts`, `scope-sync.ts`).
**How to apply on U:** `git show 098ed630:<path> > <path>` for each, then:
- `attachments.ts`: `import { inboundStagingRoot } from '../../inbox-safety.js';` no longer resolves
  (U deleted that file). Point it at wherever the staging root lands (item "Deferred downloads and
  staged attachments" below).
- `commands/context.ts` is the grammY-Context helper module, not a `/context` command.
- Scrub fixtures while copying: `commands/commands.test.ts` fixtures, the `commands/grants.ts` doc
  comment and the migration-025 header comment carry concrete Telegram chat and user ids; replace
  them with neutral ones (`-1000000000001`, `1000001`), as `inbound.test.ts` already does.
- Every other import resolves at U, except the four core symbols added by fork hunks:
  `registerProjectDocSection` (commit 1), `isAgentWiredToChannel` (commit 1, see below),
  `ResolvedReaction` (this commit) and `inboundStagingRoot` (this commit).
- Adapter contract the island implements (U's `ChannelAdapter`, unchanged B -> U, plus fork fields):
  `name`/`channelType = 'telegram'`, `supportsThreads = false` (topics are separate messaging groups,
  not threads), `threadsReplies = true` (commit 2 field), `defaults = TELEGRAM_DEFAULTS` (DM:
  `pattern` `.`; group: `mention`; both `threads: false`, `unknownSenderPolicy: 'strict'`;
  `mentions: 'platform'`), `setup`, `teardown`, `isConnected`, `deliver`, `setTyping`,
  `resolveReaction` (this commit), `syncConversations` returning `[]`. No `clearTyping` and no
  `addReaction`/`removeReaction` (Telegram's chat action expires by itself).
- Registration: `registerChannelAdapter('telegram', { defaults: TELEGRAM_DEFAULTS, factory })` at the
  bottom of `index.ts`; the factory reads `TELEGRAM_BOT_TOKEN`, `TELEGRAM_API_ROOT`,
  `TELEGRAM_MAX_FILE_MB`, `TELEGRAM_LOCAL_FILES_DIR` through `readEnvFile` and returns null without
  a token. Transcription reads `OPENAI_API_KEY`. The live install's `.env` already has these keys.
**Verify:** `pnpm run build`; `pnpm exec vitest run src/channels/telegram-grammy`;
`pnpm lint` (the island's promise rules are errors).

### Barrel lines; do not apply `/add-telegram` [MERGE]
**Intent:** register the island and the topic autowire module with one line each; never install
upstream's Chat SDK Telegram adapter, which registers the same `telegram` channel type.
**Files:** `src/channels/index.ts`, `src/modules/index.ts`.
**How to apply on U:** append to `src/channels/index.ts` (after `import './cli.js';`):

```ts
// Telegram - grammY + Effect-TS v4 implementation. Parse-error-immune (sends
// entities[] instead of parse_mode, so Telegram never runs a parser).
import './telegram-grammy/index.js';
```
In `src/modules/index.ts` insert
`import './topic-autowire/index.js';` after `import './self-mod/index.js';`, before
`community-portal` (S order). Commit 0 must not run `/add-telegram`, and must not copy
`src/channels/telegram.ts` or `@chat-adapter/telegram` from the `channels` branch.
**Verify:** `rg -n "telegram" src/channels/index.ts` shows only the island line;
`rg -n "chat-adapter/telegram" package.json` returns nothing.

### Pairing module from upstream [COPY]
**Intent:** keep upstream's pairing code path (6-digit codes, `data/telegram-pairings.json`), which
U's core `setup/pair-telegram.ts` step (already in U's `setup/index.ts` STEPS) imports; the island's
`pairing-interceptor.ts` consumes codes through it.
**Files:** `src/channels/telegram-pairing.ts`, `src/channels/telegram-pairing.test.ts`.
**How to apply on U:** `git show upstream/channels:src/channels/telegram-pairing.ts` (identical to S
at generation; take the branch's current copy). The test: take S's copy, which differs from the
branch only by four `void tryConsume(...)` prefixes the `no-floating-promises` rule needs.
**Verify:** `pnpm exec vitest run src/channels/telegram-pairing.test.ts`; `pnpm run build` (proves
`setup/pair-telegram.ts` resolves its import).

### Transcription and topic autowire [COPY]
**Intent:** voice notes arrive as text (OpenAI `gpt-transcribe`, 25 MB cap, off without a key); a
new forum topic of an already-wired chat clones the base chat's wirings, so it works with no
approval round-trip.
**Files:** `src/transcription.ts`, `src/modules/topic-autowire/index.ts`, `index.test.ts`.
**How to apply on U:** copy from S. `transcription.ts` uses `envValue` from `src/env.ts` (exists at
U). `topic-autowire` registers a `registerMessageInterceptor` that never claims (returns false) and
imports `parseTopicId` from the island, so it ships in the same commit. U's `createMessagingGroup` /
`createMessagingGroupAgent` row shapes are unchanged B -> U.
**Verify:** `pnpm exec vitest run src/modules/topic-autowire`.

### Module migrations for command scopes and rich messages [ADAPT]
**Intent (D9):** the two fork core migrations become module migrations, idempotent because the live
DB recorded them under their old names (`telegram-command-scopes`, `container-config-rich-messages`)
and the new names will be pending there.
**Files:** `src/db/telegram-command-scopes.ts` (S copy plus the registration),
`src/db/container-configs.ts` (section 01's file; this hunk is commit 7). The S files
`src/db/migrations/025-telegram-command-scopes.ts` and `028-container-config-rich-messages.ts` are
not copied, and `src/db/migrations/index.ts` gets no fork lines.
**How to apply on U:** U's API is `registerMigration(migration: ModuleMigration)` in
`src/db/migrations/index.ts`: the name must match `module:<id>:<name>` (lowercase), `version` is
only an ordering hint, module migrations run after every built-in in import order, and a duplicate
name throws. Register each at module top level in the file that owns the table or column, so it is
registered by any entry point that can touch it (host, tests, setup scripts all import these
statically):

```ts
// src/db/telegram-command-scopes.ts, after its imports
import { registerMigration } from './migrations/index.js';

// Installs that ran the fork's core migration 'telegram-command-scopes' already have the table.
registerMigration({
  version: 25,
  name: 'module:telegram:command-scopes',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_command_scopes (
        scope_key  TEXT PRIMARY KEY,
        scope_json TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
  },
});
```

```ts
// src/db/container-configs.ts, after its imports
import { registerMigration } from './migrations/index.js';

// Registered here, not in the island: createContainerConfig inserts the column. Installs that ran
// the fork's core migration 'container-config-rich-messages' already have it.
registerMigration({
  version: 28,
  name: 'module:telegram:rich-messages',
  async up(db) {
    if ((await db.columnOwners?.('rich_messages'))?.includes('container_configs')) return;
    await db.exec('ALTER TABLE container_configs ADD COLUMN rich_messages INTEGER NOT NULL DEFAULT 0');
  },
});
```
`columnOwners` is the `DbDriver` method U's SQLite driver implements with `pragma_table_info`;
`hasTable` exists too but the table case is simpler as `IF NOT EXISTS`. No import cycle:
`connection.ts` already imports `migrations/index.ts`, and no migration file imports
`container-configs.ts`. Note `pnpm run migrate` (`scripts/migrate.ts`) imports neither file, so it
does not see module migrations; on SQLite the host applies them at startup (`mode: 'auto'`).
**Verify:** `pnpm exec vitest run src/channels/telegram-grammy/commands src/cli/resources/groups.test.ts`;
on a copy of the live central DB, start the host once and check
`SELECT name FROM schema_version WHERE name LIKE 'module:telegram:%'` returns both names with no
error in the log, and `PRAGMA table_info(container_configs)` lists `rich_messages` once.

### Agent-doc prose through the commit-1 hooks [MERGE]
**Intent:** every Telegram-wired agent gets the "Telegram formatting" section in its composed project
doc whatever its skill selection, then "Rich messages" only when its group has `rich_messages = 1`.
**Files:** `src/channels/telegram-grammy/agent-docs.ts` (copied above; imported by the island's
`index.ts` as `import './agent-docs.js';`), `src/db/messaging-groups.ts` (section 01's file).
**How to apply on U:** needs commit 1's `registerProjectDocSection(provider)` from
`src/project-doc-compose.ts`, where a provider is `(group: AgentGroup) => {name, body} | null`
(sync or async) and registration order is document order. Also needs
`isAgentWiredToChannel(agentGroupId, channelType)` in `src/db/messaging-groups.ts`, which commits 7
and 10 both use; it belongs with commit 1. If it is not there, add it in this commit, after
`deleteMessagingGroupAgent`:

```ts
/** Whether an agent group is wired to at least one messaging group of `channelType`. */
export async function isAgentWiredToChannel(agentGroupId: string, channelType: string): Promise<boolean> {
  const row = await getDb().get<{ wired: number }>(
    `SELECT EXISTS (
       SELECT 1 FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE mga.agent_group_id = ? AND mg.channel_type = ?
     ) AS wired`,
    agentGroupId,
    channelType,
  );
  return row?.wired === 1;
}
```
**Verify:** `pnpm exec vitest run src/channels/telegram-grammy/formatter.test.ts` (it checks that
every syntax the guide teaches renders as described); compose a Telegram-wired group's doc and see
both sections after `ncl groups config update --id <group> --rich-messages on`.

### Deps and build config [MERGE]
**Intent:** the island's packages and lint guard.
**Files:** `package.json`, `pnpm-lock.yaml`, `eslint.config.js`, `tsconfig.json` (section 01's files;
these hunks are commit 7).
**How to apply on U:** `pnpm add grammy@1.46.0 @grammyjs/auto-retry@2.0.2 @grammyjs/commands@1.3.2
@grammyjs/files@1.2.0 @grammyjs/menu@1.3.1 @grammyjs/parse-mode@2.3.0 effect@4.0.0-beta.52
mediabunny@1.40.1 openai@6.49.0`. All exact: U's supply-chain policy rejects ranges, so S's
`openai ^6.34.0` becomes the version S's lockfile resolved. `grammy` 1.46.0 is Bot API 10.3 (rich
messages, button `style`, `date_time` entities). In `eslint.config.js` append the island block:

```js
  // telegram-grammy/ is an Effect-TS v4 island. The Effect.runPromise / runFork boundary must be
  // explicit, so the promise rules are pinned to 'error' here as well as globally: relaxing the
  // global rules must not silently relax them for this folder.
  {
    files: ['src/channels/telegram-grammy/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
```
In `tsconfig.json` set `"target": "ES2023"` and `"lib": ["ES2023"]`, keeping U's new `incremental`
and `tsBuildInfoFile` keys (the fork carried ES2023 for Effect v4; inferred still needed - drop it
only if `pnpm run build` passes without it). The global `no-catch-all` change and its
`reportUnusedDisableDirectives` line are not Telegram-specific (section 01).
**Verify:** `pnpm install --frozen-lockfile` after commit; `pnpm run build`; `pnpm lint`.

### Reaction fallback in the contract and in delivery [MERGE]
**Intent:** Telegram allows a fixed reaction set; delivery resolves the agent's emoji before sending,
sends the nearest allowed glyph and tells the agent, or drops it and tells the agent the allowed set.
**Files:** `src/channels/adapter.ts`, `src/channels/channel-registry.ts`, `src/delivery.ts`
(section 01's files; these hunks are commit 7).
**How to apply on U:** from `git diff 66f0823a 098ed630 -- <file>`:
- `adapter.ts`: add after `OutboundMessage`

```ts
/** An outbound reaction measured against a platform's fixed reaction set - see `ChannelAdapter.resolveReaction`. */
export interface ResolvedReaction {
  /** Glyph to actually send, or null when the set has no stand-in for the intent. */
  emoji: string | null;
  /** true when `emoji` is a nearest-allowed stand-in, not what the agent asked for. */
  substituted: boolean;
  /** Platform whose set applied, for the note the host writes back to the agent. */
  platform: string;
  /** The full allowed set, spelled out to the agent when nothing maps. */
  allowed: readonly string[];
}
```
  and `resolveReaction?(emoji: string): ResolvedReaction;` on `ChannelAdapter` (with S's doc
  comment, placed before `syncConversations`).
- `channel-registry.ts` `createChannelDeliveryAdapter()`: add the `ResolvedReaction` type import and
  the `resolveReaction(channelType, emoji, instance)` method (looks up
  `getChannelAdapterExact(instance ?? channelType)` and returns `adapter?.resolveReaction?.(emoji)`).
- `delivery.ts`: `resolveReaction?` on `ChannelDeliveryAdapter`; copy `writeOutboundNote`,
  `ReactionOutcome` and `resolveOutboundReaction` verbatim from S; in `deliverMessage`, after the
  "Channel delivery" routing-field check and before "Read file attachments from outbox", call
  `resolveOutboundReaction(...)` and on `drop` write the note and return; set
  `rewritten.emoji = reaction.emoji` on `substituted`; after a successful `deliver`, write the
  substitution note. The `rewritten`/`outboundContent` block is commit 2's; this commit adds only
  the emoji line and the two note writes.
**Verify:** the fork's `src/delivery.test.ts` describe "reaction fallback and feedback" (commit 7
cases); `pnpm exec vitest run src/channels/telegram-grammy/reactions.test.ts`.

### Rich messages plumbing [MERGE]
**Intent:** a per-group `rich_messages` toggle (default off) lets an agent send a Telegram Rich
Message; the host, not the untrusted container, decides.
**Files (section 01's; hunks are commit 7):** `src/types.ts` (`rich_messages: number` on
`ContainerConfigRow`), `src/db/container-configs.ts` (`'rich_messages'` in `SCALAR_COLUMNS`, the
insert column list and the `updateContainerConfigScalars` key union), `src/backfill-container-configs.ts`
(`rich_messages: 0`), `src/container-config.ts` (`richMessages?: true` on `ContainerConfig`, set in
`configFromDb` only when `row.rich_messages === 1`), `src/cli/resources/groups.ts`
(`--rich-messages on|off`, shown as on/off), `src/delivery.ts` (`richAllowed()`),
`container/agent-runner/src/config.ts` (`richMessages`), `container/agent-runner/src/mcp-tools/core.ts`
(the `rich` property on `send_message`, offered only when on).
**How to apply on U:** none of these files changed B -> U in the touched spots except `delivery.ts`,
where U's `fromAgent` stamping must survive: when merging commit 2's content rewrite, keep marking
`ask_question` rows `fromAgent: true`. In `deliverMessage` this commit adds
`if (await richAllowed(msg.id, content, session)) rewritten.rich = true;` and strips a stored `rich`
along with commit 2's stored `threadReply`. `richAllowed` verbatim from S:

```ts
async function richAllowed(messageId: string, content: Record<string, unknown>, session: Session): Promise<boolean> {
  const isEdit = content.operation === 'edit';
  if (!isEdit && content.rich !== true) return false;
  if ((await getContainerConfig(session.agent_group_id))?.rich_messages === 1) return true;
  if (isEdit) return false;
  log.warn('Rich message requested by a group without rich_messages; sending it as a normal message', {
    id: messageId,
    agentGroupId: session.agent_group_id,
  });
  return false;
}
```
**Verify:** the fork's `delivery.test.ts` "carries rich only for a group with rich_messages on" and
"lets the rich_messages setting alone decide whether an edit is rich"; `groups.test.ts` rich cases;
`cd container/agent-runner && bun test src/config.test.ts src/mcp-tools/core.test.ts`.

### Deferred downloads and staged attachments [MERGE]
**Intent:** the island downloads and transcribes only after the engage, access and scope gates pass
(a refused sender never costs a download), and stages bytes host-side; core copies them into each
session's inbox, so a message routed to several agents lands in each one's inbox.
**Files (section 01's; hunks are commit 7 unless section 01 already placed them):**
`src/channels/adapter.ts` (`materialize?: () => Promise<void>` on `InboundMessage` and
`InboundEvent`), `src/index.ts` (`onInbound` builds the event first and wraps `message.materialize`
memoized, re-serializing `event.message.content` from `message.content` in a `finally`; see S
`src/index.ts` around `if (message.materialize)`), `src/router.ts` (in `deliverToAgent`, after
`messageIdForAgent`, `try { await event.materialize?.(); } catch (err) { log.warn('Inbound message
materialization failed', ...) }` before commit 6's `rawContent` line), the staging root and sweep,
`src/session-manager.ts` `extractAttachmentFiles`, `src/host-sweep.ts` + `src/reconcile.ts`
(`singleton:inbound-staging`), `src/modules/agent-to-agent/agent-route.ts` (`withoutHostStamps`
strips `stagedPath`, so agents cannot pass one).
**How to apply on U:** U deleted `src/inbox-safety.ts`. Put `inboundStagingRoot()` (=
`path.join(DATA_DIR, 'inbound-staging')`) and `sweepInboundStaging()` (S bodies, 1 h max age,
entries `<root>/<adapter>/<entry>`) in a surviving host module (suggested: `src/attachment-safety.ts`),
and change the import in the island's `attachments.ts` and in `host-sweep.ts` to match. The staged
copy in U's rewritten `extractAttachmentFiles` must go through U's anchored inbox dir
(`inboxFolderName(messageId)`), accept a `stagedPath` only when its realpath is under the staging
root, copy exclusively, set `localPath`, keep `att.name`, record a per-attachment `att.error` on
failure, and delete `stagedPath` from every attachment before the content is stored. What the
island puts on `content.attachments[]`: `type`, `fileId`, `name`, `mimeType`, `size`, `width`,
`height`, `durationSeconds`, and after `materialize` either `stagedPath` (+ `transcript` for voice
and audio) or `error`.
**Verify:** `pnpm exec vitest run src/channels/telegram-grammy/attachments.test.ts
src/session-manager.attachments.test.ts` (with the fork's "staged adapter downloads" cases);
send a photo and a voice note to a wired Telegram chat and see `inbox/...` files and a transcript.

## Cross-section notes

- **Section 01 (core) - hunks in its files that are commit 6:** `src/command-gate.ts` and its test,
  the `src/router.ts` 3b block plus the `host`/`normalizedText` handling in `deliverToAgent`,
  `src/modules/interactive/index.ts` (`hcmd-` skip), and the `CLAUDE.md` chat-commands paragraph
  (or commit 14). All documented above.
- **Section 01 - hunks in its files that are commit 7:** barrel lines in `src/channels/index.ts` and
  `src/modules/index.ts`; `package.json`/lock deps; the eslint island block and tsconfig ES2023;
  `ResolvedReaction`/`resolveReaction` in `adapter.ts`, `channel-registry.ts`, `delivery.ts`; the
  rich-messages plumbing (types, container-configs incl. the module migration, backfill,
  container-config, groups CLI, `richAllowed`, `db-v2.test.ts` fixture `rich_messages: 0`, runner
  `config.ts`); `materialize` (`adapter.ts`, `src/index.ts`, `router.ts`); staged attachments
  (staging root + sweep, `session-manager.ts`, `host-sweep.ts`, `reconcile.ts`, `agent-route.ts`).
  `threadsReplies`, `inReplyTo`, `threadReply` and `platformMessageId` are commit 2;
  `clearTyping`/`typingRequiresThread`/`addReaction` are commit 3.
- **Section 01 - commit 1:** please land `isAgentWiredToChannel` with the hooks (used by 7 and 10).
- **Section 01 - commit 5:** `auto_compact_window` (migration 026) has the same constraint as
  `rich_messages`: `createContainerConfig` inserts the column, so register its module migration from
  `src/db/container-configs.ts` (with a `columnOwners` guard for the live name
  `container-configs-auto-compact-window`), not from a module only the host imports.
- **Section 01 - runner `mcp-tools/core.ts` and `formatter.ts`, payloads the island consumes**
  (`outbound.ts` `viewContent`):
  - default message: `text` (or `markdown`), optional `files` (outbox filenames), `rich: true`
    (host-set only), `threadReply: { quote? }` plus `OutboundMessage.inReplyTo` (commit 2);
  - `{ operation: 'edit', messageId, text }` (rich form when the host sets `rich`);
  - `{ operation: 'reaction', messageId, emoji }` (empty emoji clears; already resolved by delivery);
  - `{ operation: 'send_media_group', items: [{ path, caption? }], files: [...] }` with 2-10 items,
    each `path` the outbox filename (the island matches `basename(path)` to `files[].filename`), as
    S's `send_media_group` handler writes it (dedupes basenames as `<index>-<name>`);
  - `{ type: 'ask_question', questionId, title, question?, options }` (button `style` honored);
    `{ type: 'card', fallbackText }`.
  - `add_reaction`'s schema keeps the literal `const TELEGRAM_REACTION_GLYPHS = '...'` in
    `container/agent-runner/src/mcp-tools/core.ts`: `reactions.test.ts` reads that exact file and
    regex. If the tool moves to a `registerTools`/`extendTool` file, update the test's path.
  - Inbound: the runner formatter renders an attachment's `transcript` as ` transcript: "..."`
    after the saved-file line (fork hunk in `container/agent-runner/src/formatter.ts`, commit 7).
- **Section 05 (Slack, commit 10):** Slack's `!status` relies on commit 6's `BANG_PREFIX_CHANNELS`.
  `@chat-adapter/slack` must move to U's 4.41.1 with `chat`.
- **Section 07 (voice, commit 12):** voice depends on commits 6 and 7: `COMMANDS.voice`, the
  island's `/voice` binding (calls `handleVoiceCommand` on the `voice-mode` adapter, else dynamically
  imports `../../voice-mode-command.js`), `offersVoiceCommand()`, and `voice-mode-livekit.ts` skipping
  `hcmd-` reply ids. `inbound.ts` `redactVoiceLinks` ships with the island.
- **Section 00:** do not apply `/add-telegram`; `setup/pair-telegram.ts` is core at U and works with
  the island once `telegram-pairing.ts` is copied.

## Files covered

```
docs/chat-commands.md -> 6
src/channels/telegram-grammy/agent-docs.ts -> 7
src/channels/telegram-grammy/ask-question.test.ts -> 7
src/channels/telegram-grammy/ask-question.ts -> 7
src/channels/telegram-grammy/attachments.test.ts -> 7
src/channels/telegram-grammy/attachments.ts -> 7
src/channels/telegram-grammy/commands/command-group.ts -> 7
src/channels/telegram-grammy/commands/commands.test.ts -> 7
src/channels/telegram-grammy/commands/context.ts -> 7
src/channels/telegram-grammy/commands/grants.test.ts -> 7
src/channels/telegram-grammy/commands/grants.ts -> 7
src/channels/telegram-grammy/commands/index.ts -> 7
src/channels/telegram-grammy/commands/menus.ts -> 7
src/channels/telegram-grammy/commands/render.ts -> 7
src/channels/telegram-grammy/commands/scope-sync.ts -> 7
src/channels/telegram-grammy/errors.test.ts -> 7
src/channels/telegram-grammy/errors.ts -> 7
src/channels/telegram-grammy/formatter.test.ts -> 7
src/channels/telegram-grammy/formatter.ts -> 7
src/channels/telegram-grammy/inbound.test.ts -> 7
src/channels/telegram-grammy/inbound.ts -> 7
src/channels/telegram-grammy/index.test.ts -> 7
src/channels/telegram-grammy/index.ts -> 7
src/channels/telegram-grammy/layers.ts -> 7
src/channels/telegram-grammy/media-meta.test.ts -> 7
src/channels/telegram-grammy/media-meta.ts -> 7
src/channels/telegram-grammy/outbound.test.ts -> 7
src/channels/telegram-grammy/outbound.ts -> 7
src/channels/telegram-grammy/pairing-interceptor.ts -> 7
src/channels/telegram-grammy/reactions.test.ts -> 7
src/channels/telegram-grammy/reactions.ts -> 7
src/channels/telegram-grammy/runtime.ts -> 7
src/channels/telegram-grammy/services.ts -> 7
src/channels/telegram-grammy/supervise.ts -> 7
src/channels/telegram-grammy/topic-map.test.ts -> 7
src/channels/telegram-grammy/topic-map.ts -> 7
src/channels/telegram-pairing.test.ts -> 7
src/channels/telegram-pairing.ts -> 7 (from upstream/channels)
src/commands/auth.ts -> 6
src/commands/cards.ts -> 6
src/commands/fallback.ts -> 6
src/commands/format.test.ts -> 6
src/commands/format.ts -> 6
src/commands/index.ts -> 6
src/commands/service.test.ts -> 6
src/commands/service.ts -> 6
src/commands/transcript.test.ts -> 6
src/commands/transcript.ts -> 6
src/commands/types.test.ts -> 6
src/commands/types.ts -> 6
src/commands/typography.test.ts -> 6
src/db/migrations/025-telegram-command-scopes.ts -> DROP (replaced by module migration in src/db/telegram-command-scopes.ts, commit 7)
src/db/migrations/028-container-config-rich-messages.ts -> DROP (replaced by module migration in src/db/container-configs.ts, commit 7)
src/db/telegram-command-scopes.ts -> 7
src/modules/topic-autowire/index.test.ts -> 7
src/modules/topic-autowire/index.ts -> 7
src/transcription.ts -> 7
```
