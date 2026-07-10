# Chat Commands

NanoClaw exposes four host-owned slash commands that let an operator inspect and
retune an agent group straight from chat, without shelling into the host for
`ncl`. The commands are answered by the host, never by the container agent: the
router claims them before the per-agent fan-out, and on Telegram a native
binding handles them at the adapter.

| Command | Who can run it | What it does |
|---------|----------------|--------------|
| `/status` | Any group member (agent_group_members gate) | Read-only Hermes-style card: model + effort, live context vs compact window, session output/turns, this chat's activation, session/queue/task counts, and config updated-at. Non-default provider / cli_scope / max-messages surface as extra lines. |
| `/model` | Admin only | Bare `/model` opens a model picker (active model checkmarked). `/model <alias-or-id>` switches directly. |
| `/config` | Admin only | Bare `/config` opens the config menu (Model / Effort / Compact window / Activation / Restart). `/config set <field> <value>` writes one field. |
| `/restart` | Admin only | Restarts the agent's running container(s) immediately. |

## Status card

The `/status` card is assembled from three sources, all read-only and best-effort
(any missing piece is simply omitted, never an error):

| Segment | Source |
|---------|--------|
| Model + effort, compact window, provider, cli_scope, max messages | `container_configs` row for the agent group |
| Activation (`mention, known senders`, `pattern /re/`, `always on`) | the wiring row for this (messaging group, agent) pair: `engage_mode` + `engage_pattern` + `sender_scope` |
| Context `113k / 400k (28%)`, Session `46k out over 214 turns` | the session's SDK transcript (`.claude-shared/projects/*/<sdk-id>.jsonl`), mapped via the session's `outbound.db` `session_state` (`continuation:<provider>`, legacy `sdk_session_id`), newest `.jsonl` as fallback |
| `Sessions: N`, `Queue: N`, `Tasks: N` | active sessions for the group; `Queue` = undelivered due inbound messages for the resolved session (omitted when 0); `Tasks` = live (pending/paused) task series (omitted when 0) |
| `Updated: 2026-07-10 00:32 (2h ago)` | `container_configs.updated_at`, rendered absolute-plus-relative |

Token counts use the OpenClaw compaction heuristic (`formatTokens`): `>=1m -> '1.2m'`,
`>=10k -> '46k'`, `>=1k -> '4.5k'`. The window renders as `400k`, not `400000`.
Timestamps render as local `YYYY-MM-DD HH:MM` plus a relative suffix (`formatDateRel`).
Context/Session lines appear only when transcript data exists; the Activation line
only when the read has a chat context (a wired chat).

Only `/status` is member-runnable; `/model`, `/config`, and `/restart` require
admin privilege over the target agent group. On Telegram, unprivileged members
never see the commands in the popup at all (see [Telegram popup
registration](#telegram-popup-registration)), but a typed `/status` still works.

## Authorization

Auth is re-checked server-side on EVERY command and EVERY menu tap. This is
defense in depth: any structural scoping (the Telegram plugin's command scopes,
the popup registration) is treated as a hint only. The real gate is
`hasAdminPrivilege(actorUserId, agentGroupId)`, re-run inside the host service
on every write (`setModel`, `setConfigValue`, `restartAgent`) and inside every
menu-tap handler. A menu left open and tapped by a non-admin is refused with an
explicit alert, never silently ignored.

For `/status`, the member gate uses `canAccessAgentGroup`. Unknown senders (no
`users` row) are dropped silently, mirroring how the router treats their normal
messages; known non-members get an explicit refusal.

The pressing user is authoritative on a menu tap: the handler re-checks the
tapper's privilege, NOT the original requester's. Someone who opened a picker
cannot hand the buttons to a non-admin.

## Apply semantics

There are two distinct apply paths.

| Trigger | Container behavior | Wake message | Visible confirmation |
|---------|--------------------|--------------|----------------------|
| `/model` write, `/config` write | Instant kill of running containers, LAZY respawn | No | The card/menu edit ("applies from her next reply") |
| `/restart` | Immediate respawn NOW | Yes | Restart confirmation |

A `/model` or `/config` write kills the agent group's running containers
immediately but does NOT respawn them. The container comes back on the next user
message and picks up the new config from `container_configs`. There is no wake
message and no agent acknowledgment in chat; the menu/card edit is the sole
confirmation (for example "Switched to Opus 4.8, applies from her next reply").

`/restart` follows the self-mod restart pattern: it respawns the container
immediately and writes a wake message, so the agent resumes right away rather
than waiting for the next user turn.

Typed `/restart` is immediate with no confirmation. The `/config` menu's Restart
button has one confirm step (a Yes/Cancel submenu) before it fires.

Activation changes are a THIRD path. Because engage rules are evaluated host-side
on the next inbound message, `setActivation` does NOT kill the container: the
change takes effect immediately in that chat. Its confirmations say so ("Applies
immediately in this chat.") to distinguish them from container-config writes
("Applies from her next reply.").

### Collapse + toast (Telegram menus)

A terminal menu tap (a model / effort / compact-window / activation-mode pick, or
the restart confirm) collapses the menu and confirms in one edit: the handler
calls `ctx.menu.close()` (the `@grammyjs/menu` control-panel method, which is
LAZY - it injects an empty keyboard into the next `editMessageText`), then edits
the message to the confirmation (removing the keyboard in that same API call),
then answers the callback with a short toast (`Model switched`, `Activation
updated`, ...). Failure taps keep the keyboard and show an alert toast instead.
Navigation taps (submenus, Back) are unchanged.

## /config surface

`/config` deliberately exposes only a subset of the full container config, plus
the two per-chat activation fields. Fields writable via chat:

| Field | Accepted values | Applies |
|-------|-----------------|---------|
| `model` | A catalog alias (`sonnet`, `opus`, `fable`) or a raw model id | next reply (container config) |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` | next reply (container config) |
| `auto-compact-window` | A positive integer token count (presets: 165k, 200k, 400k, 600k, 800k) | next reply (container config) |
| `max-messages-per-prompt` | A positive integer | next reply (container config) |
| `activation` | `mention`, `mention-sticky`, `pattern` | immediately (wiring row) |
| `pattern` | A regular expression (switches the mode to `pattern` and sets the source) | immediately (wiring row) |

`activation` and `pattern` write the chat's wiring row (`engage_mode` /
`engage_pattern`), not container config, so they apply immediately with no
container kill. `pattern` mode needs a typed regex, so it cannot ride a menu
button: the Activation submenu's `pattern` entry only hints at `/config set
pattern <regex>`. The regex is validated with `new RegExp(...)`; an uncompilable
value is rejected with the compile error. The `.` pattern is the "match every
message" sentinel and renders as `always on`.

The remaining container-config fields are ncl-only and are never reachable from
chat: `cli_scope`, `provider`, `image_tag`, `mounts`, `packages`,
`mcp_servers`. The reasons:

- `cli_scope` controls what the agent can do with `ncl` from inside its own
  container. Exposing it to chat would let an agent (or a chat participant)
  escalate its own privilege.
- `packages` and `mcp_servers` are owned by the self-mod approval flow, which
  runs a single admin approval per request and rebuilds the image when needed.
  A chat write would bypass that gate.
- `provider`, `image_tag`, and `mounts` are install-topology decisions that
  belong to an operator at the host, not a chat quick-tweak.

`/status` displays `cli_scope` and `provider` read-only so an operator can see
the current values, but they can only be changed with `ncl groups config
update`.

## Model catalog

Three catalogued models, addressable by short alias:

| Alias | Label | Raw id |
|-------|-------|--------|
| `sonnet` | Sonnet 5 | `claude-sonnet-5` |
| `opus` | Opus 4.8 | `claude-opus-4-8` |
| `fable` | Fable 5 | `claude-fable-5` |

Raw-id escape hatch: `/model <id>` (or `/config set model <id>`) accepts any id
matching `^[a-z0-9][a-z0-9.-]+$` between 3 and 64 characters, so an operator can
pin a model id not yet in the catalog. Catalogued ids render with their friendly
label; raw ids render as the bare id.

## Architecture

The design is a model/view split at the channel-adapter seam.

- **`HostCommandService` (`src/commands/`)** owns ALL semantics: the command
  registry, model catalog, validation, target resolution, authorization, and the
  domain reads/writes against `container_configs`. It is channel-agnostic and
  returns view-model DATA, never formatted text. `types.ts` defines the view
  models and pure helpers; `service.ts` implements the reads/writes. Popup-grant
  computation is telegram-specific and lives in the adapter (see below).
- **Router fallback (`src/commands/fallback.ts`)** renders those view models as
  plain-text replies, or (for the bare `/model` picker) a single `ask_question`
  card, and writes them straight to the session outbound DB via
  `writeOutboundDirect`. This is the uniform backstop for every channel with no
  native command binding.
- **telegram-grammy binding (`src/channels/telegram-grammy/commands/`)** handles
  the commands natively using `@grammyjs/commands` (a CommandGroup for handling)
  and `@grammyjs/menu` (stateless inline-keyboard menus). It is view code only;
  every tap re-enters the host service.

The approvals flow is untouched. The fallback's host-authored `ask_question`
card rides the exact same delivery pipeline as a container-authored one, but its
`questionId` carries an `hcmd-` prefix. The `hcmd-` response handler is
registered before the generic interactive handler and claims (and deletes) every
`hcmd-` pending row up front, so the two namespaces (`hcmd-` and `ncq:`)
coexist without the interactive module ever routing a host-command tap into a
container.

### Gate integration

`src/command-gate.ts` classifies inbound slash commands. `classifyHostCommand`
is a pure, agent-independent text classifier that recognizes the four commands
(any casing, with or without a Telegram `@botname` suffix) and extracts the
argument string. The router calls it once per message, before the per-agent
fan-out, and hands a match to `runHostCommand`. Host commands must NOT leak to
the container: the Claude SDK ships native `/model` and `/status` handlers that
would shadow ours, and whose effects are not persisted (they vanish on the next
respawn).

## Telegram popup registration

The Telegram command popup (`setMyCommands`) is admin-only and is computed from
the central DB, not hard-coded. `computeCommandGrants`
(`src/channels/telegram-grammy/commands/grants.ts`) reads `user_roles` and the
messaging-group wirings and emits a grant list:

- **Group chats:** one `chat_member` grant per (admin user, chat). "Admin" means
  owner, global admin, or a scoped admin of any agent wired to that chat.
- **Private DM chats:** one `chat` grant when the DM's own user is an admin/owner
  over a wired agent.

Grants are per chat, never per topic (Telegram command scopes cannot target a
forum topic), so multiple topics that share one chat id are folded together and
their wired-agent admin sets are unioned.

### Startup scope janitor

`src/channels/telegram-grammy/commands/scope-sync.ts` reconciles Telegram's
server-side scopes with the current grants at adapter startup:

1. Compute the current grants and resolve them to Telegram scopes.
2. Load the scopes THIS install last applied from `telegram_command_scopes`
   (migration 020).
3. `deleteMyCommands` for the always-stale broad scopes (`default`,
   `all_private_chats`, `all_group_chats`, `all_chat_administrators`) plus every
   previously-applied per-chat scope no longer granted (revoked admins, unwired
   chats).
4. `setMyCommands` for each current grant scope.
5. Persist the applied scope set back to `telegram_command_scopes` for the next
   run's diff.

The broad-scope purge matters because the bot token may carry stale command
registrations from a previous install (this token inherited 63 commands at the
default scope from an OpenClaw install). Persisting the applied set is what lets
the janitor delete scopes that Telegram remembers but the DB no longer grants.

The whole janitor is failure-tolerant: any Telegram call that fails is logged
and skipped, so a Telegram outage at startup can never crash the host. Grant
changes take effect on the NEXT service restart, not live, because the janitor
runs only at adapter startup.

## Multi-agent chats

A chat can be wired to more than one agent (for example one Telegram chat with a
topic per agent). Target resolution (`resolveTargets`) returns `single`,
`multiple`, or `none`, with the `multiple` list DETERMINISTICALLY sorted by
agent name (agent group id as tiebreaker). Telegram pickers index into this
sorted order.

- **Telegram:** when a chat has more than one wired agent, the command shows an
  agent-picker menu first. The picker button payload is a short INDEX into the
  sorted agent list (not the agent group id, to stay under the 64-byte callback
  budget). Single-agent chats skip the picker entirely.
- **Fallback:** `/status` shows all wired agents' statuses in one reply. Writes
  (`/model`, `/config`, `/restart`) refuse politely with a hint to run the
  command in the agent's own topic or use `ncl` from the host.

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| Popup does not show the commands | Grants apply only at adapter startup. Restart the service, then check the host log for `telegram-grammy: command scopes synced`. If the line is absent, the janitor did not run (Telegram outage or adapter not loaded). |
| A command is answered by the container agent instead of the host | The gate should claim all four commands before fan-out. If a command reaches the container, the classifier missed it. This should not happen for `/status /model /config /restart`; check `classifyHostCommand` and confirm the message kind is `chat` or `chat-sdk`. |
| A menu says it is outdated when tapped | The agent's config changed elsewhere (a concurrent `/config` write, an `ncl` change, or a new wiring). The menu fingerprint folds in model, effort, window, cli_scope, and the wiring set, so a stale menu self-detects. Re-run the command to get a fresh menu. |
