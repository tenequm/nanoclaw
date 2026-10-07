# Voice mode upgrade and rollback

This is an operator runbook. No server actions are performed by building this
branch. Use the complete fork build, with matching host and worker, and update
native clients to protocol 6 before admitting new calls. Browser bookmarks
keep their URLs and receive the new page after reload.

## Main protocol 4 and env-backed links

The adapter still reads the original tokens from `.env`. It derives the same
`voice:<SHA-256 first twelve hex characters>` platform id, resolves the same
named caller, strict line wiring, group membership and original call-chat
binding. Tokens are not printed or written into the DB. There is no automatic
re-mint, identity rewrite or destructive DB migration.

Plain `/voice` from an existing line owner moves its old call-chat binding and
keeps its saved links. Other admins cannot move that person's line. `/voice new`
creates a hashed-token line for the authorized caller and deliberately retires
all old env-backed links for that agent; active old calls fail their next access
check. New lines use core roles. A newly minted line's token is shown only once,
privately to its caller, so keep an old link unless replacement is intentional.

Keep the old `.env` entries until replacement is intentional. A legacy line's
voice user and messaging-group rows must not be removed just because its new
adapter name is `voice-mode`. Legacy calls with no chat deliver into their
original session, with replies addressed to the new adapter.

### Configuration rename

Every old `VOICE_<suffix>` read by host or worker is accepted as
`VOICE_MODE_<suffix>`, with a warning naming keys only. An explicit new value
wins when both are present. The existing `.env` parser ignores empty values;
use documented `off`/`0` switches rather than an empty line to disable a setting.

| Main key | Protocol 6 key |
| --- | --- |
| `VOICE_PUBLIC_URL` | `VOICE_MODE_PUBLIC_URL` |
| `VOICE_LINK_TOKEN` | `VOICE_MODE_LINK_TOKEN` |
| `VOICE_UI` | `VOICE_MODE_UI` |
| `VOICE_MAX_CALL_SECONDS` | `VOICE_MODE_MAX_CALL_SECONDS` |
| `VOICE_MAX_CALLS_PER_HOUR` | `VOICE_MODE_MAX_CALLS_PER_HOUR` |
| `VOICE_MAX_MINUTES_PER_DAY` | `VOICE_MODE_MAX_MINUTES_PER_DAY` |
| `VOICE_ALLOW_NON_LOOPBACK` | `VOICE_MODE_ALLOW_NON_LOOPBACK` |
| `VOICE_TRUSTED_PROXY_CIDRS` | `VOICE_MODE_TRUSTED_PROXY_CIDRS` |
| `VOICE_ALLOWED_CLIENT_CIDRS` | `VOICE_MODE_ALLOWED_CLIENT_CIDRS` |
| `VOICE_VOCABULARY` | `VOICE_MODE_VOCABULARY` |
| `VOICE_STT_MODEL` | `VOICE_MODE_STT_MODEL` |
| `VOICE_STT_FALLBACK_MODEL` | `VOICE_MODE_STT_FALLBACK_MODEL` |
| `VOICE_TTS_MODEL` | `VOICE_MODE_TTS_MODEL` |
| `VOICE_TTS_FALLBACK_MODEL` | `VOICE_MODE_TTS_FALLBACK_MODEL` |
| `VOICE_TTS_VOICE` | `VOICE_MODE_TTS_VOICE` |
| `VOICE_SILENCE_MS` | `VOICE_MODE_SILENCE_MS` |
| `VOICE_MIRROR` | `VOICE_MODE_MIRROR` |
| `VOICE_WAKE_MODEL` | `VOICE_MODE_WAKE_MODEL` |
| `VOICE_WAKE_PHRASE` | `VOICE_MODE_WAKE_PHRASE` |
| `VOICE_WAKE_THRESHOLD` | `VOICE_MODE_WAKE_THRESHOLD` |
| `VOICE_WAKE_START_SECONDS` | `VOICE_MODE_WAKE_START_SECONDS` |
| `VOICE_WAKE_IDLE_SECONDS` | `VOICE_MODE_WAKE_IDLE_SECONDS` |
| `VOICE_RECORDINGS_DAYS` | `VOICE_MODE_RECORDINGS_DAYS` |
| `VOICE_MAX_SPOKEN_CHARS` | `VOICE_MODE_MAX_SPOKEN_CHARS` |
| `VOICE_TTS_DEESS` | `VOICE_MODE_TTS_DEESS` |
| `VOICE_TTS_NOTCH` | `VOICE_MODE_TTS_NOTCH` |
| `VOICE_WORKER_HEALTH_PORT` | `VOICE_MODE_WORKER_HEALTH_PORT` |

`LIVEKIT_*`, `GEMINI_API_KEY` and optional `JEV_*` names stay unchanged.
`VOICE_MODE_PORT=3100` adds a separate page listener; main's existing
`/voice` and `/webhook/voice/livekit` fronts still work on `WEBHOOK_PORT`.
Do not move a working front during the compatibility upgrade. A configured
custom wake model remains operator-owned at its current path; preserve its
phrase, threshold and vocabulary. The bundled assets moved from
`assets/voice-wakeword` to `assets/voice-mode-wakeword`: update a setting that
explicitly names the old bundled path. An external acoustic `hey dan` model
needs no rename. `off` retains transcript `hey <agent>` wake.

`LIVEKIT_AGENT_NAME` must be the same on host and worker. An explicit old
`nanoclaw-voice` override remains supported on both. The new default is
`nanoclaw-voice-mode`; a worker of another build/name must not remain running.

### Backup and cutover

1. In the running checkout, record `git rev-parse HEAD` in a private backup
   directory. Record the installed worker unit's name and keep its file, the
   central DB, `.env`, agent skill selections, vocabulary and custom models.
   Do not print secret values. For another central backend, use its backup
   procedure instead of the SQLite example below.
2. Identify this checkout's host service:

   ```bash
   source setup/lib/install-slug.sh
   voice_host_unit="$(systemd_unit).service"
   systemctl --user list-unit-files 'nanoclaw*'
   ```

   The host is `nanoclaw-v2-<install slug>.service`; the slug derives from this
   checkout's path. Do not rename or restart another install's host. Older
   custom installs may use a manually chosen unit; honor that actual name.
3. Stop admission and both processes before replacing the build. Choose the
   actual worker unit rather than stopping both blindly:

   ```bash
   systemctl --user stop nanoclaw-voice-worker.service
   systemctl --user stop "$voice_host_unit"
   ```

   If the worker already has its new name, stop
   `nanoclaw-voice-mode-worker.service` instead. A terminal worker must stop
   too. Keep a stopped old unit disabled during any new-unit transition.
4. With both stopped, make the SQLite backup consistent. Run from the checkout:

   ```bash
   umask 077
   mkdir -p .voice-mode-upgrade-backup
   git rev-parse HEAD > .voice-mode-upgrade-backup/revision
   cp -p .env .voice-mode-upgrade-backup/env
   python3 - <<'PY'
   import sqlite3
   with sqlite3.connect('file:data/v2.db?mode=ro', uri=True) as source:
       with sqlite3.connect('.voice-mode-upgrade-backup/central.db') as backup:
           source.backup(backup)
   PY
   ```

   Keep this directory private and untracked, preferably outside the checkout
   after creating it. Do not commit it or copy it to an agent's workspace.
5. Install the reviewed revision from the voice-mode rebuild branch, with a
   clean checkout. Preserve local configuration and data; do not merge the
   shared registry branch into a customized install. Install the locked host
   dependencies, build the host and confirm the voice tests pass:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run build
   pnpm exec vitest run src/channels/voice-mode*.test.ts src/voice-mode*.test.ts
   ```

   Update explicit group skill lists from `voice-formatting` to
   `voice-mode-formatting`. Rename `.env` keys privately if desired, preserving
   exact values, commas and quoting; aliases allow deferring this step.
6. Either retain `nanoclaw-voice-worker.service` and change only its ExecStart
   to `node dist/voice-mode-worker.js start`, or install
   `nanoclaw-voice-mode-worker.service` using the skill's unit, disable the old
   one, and start only the new one. WorkingDirectory must be this checkout.
   Do not add `EnvironmentFile=`; both processes read `.env` directly.
   The host unit's name and ExecStart remain its existing ones.
7. Reload units and start host and chosen worker together:

   ```bash
   systemctl --user daemon-reload
   systemctl --user start "$voice_host_unit"
   systemctl --user start nanoclaw-voice-mode-worker.service
   ```

   Substitute the retained old worker name if that is the chosen option.
   On macOS the host label is `$(launchd_label)` from the same helper; unload
   and load that install's LaunchAgent and its chosen worker LaunchAgent,
   updating only the worker executable path. New worker label:
   `com.nanoclaw-voice-mode-worker`; retain an old custom label if desired.
8. Confirm protocol 6 in worker startup logs, the expected host URL and dispatch
   name, and no missing-key or failed-model warning. Reload a saved browser
   bookmark; check the correct caller and agent, one spoken send, review draft,
   discard, captions, reply, reconnect and hangup. Test the updated native app
   separately. Its start request must include `v=6`. Plain `/voice` must leave
   the original saved link usable; do not test `/voice new` on a saved line
   unless retirement is intended.

The optional Jev shadow remains off without enabled `data/jev-turn.json`.
Keep an existing generic endpoint/model configuration only if the operator
wants that experiment. It is not part of voice service readiness.

## Shared protocol 5 AgentSession installations

Keep the existing `voice_mode_lines` table, named module migration record,
caller roles, `.env`, page origin, port and saved links. The table's shape and
token hash format are unchanged; the current host registers its migration
before DB startup and does not mint replacement links automatically.

Use the same backup and stopped host/worker build replacement above. Keep
`VOICE_MODE_*` names. Preserve an explicit `LIVEKIT_AGENT_NAME` on both sides;
otherwise both now use `nanoclaw-voice-mode`. Keep the existing worker unit
filename if desired, but its executable is `dist/voice-mode-worker.js`.
Preserve `VOICE_MODE_PORT` or its default 3100. Reload the browser page so it
requests protocol 6. Old protocol 5 starts are refused with 409 before a room
or cost-bearing worker is created.

Behavior changes from that worker: own Gemini Live manual activities replace
AgentSession STT, unary fallback is ignored, wake is on by default, review and
spoken commands are available, and worker-side cues/captions/reconnect are
retained from main. Turn wake off in the page for pause-send operation.
Set `VOICE_MODE_LANGUAGES=en-US` if keeping the shared English default is
intended; protocol 6 defaults to main's Ukrainian/English hints. Recordings
stay off unless explicitly enabled. Replies are spoken in full unless capped.

## Rollback

Stop the new worker and host. Switch the clean checkout back to the recorded
revision using ordinary `git checkout <recorded revision>`; do not reset or
force-push branches. Restore the private original `.env`, worker service file
and explicit group skill selections, install its frozen lockfile and build.
Start the matching old host/worker pair and reload that build's page/client.
Keep the same public front.

The new module table is additive, so an old main build can ignore it. Prefer
keeping the current DB to preserve messages created after cutover; restore the
stopped DB snapshot only for a DB failure or a deliberate full-state rollback,
which discards later changes. Back up current state before restoring it.
For a shared rollback, preserve the existing module rows and migration record.

Links minted by protocol 6 do not work under old main. Restoring old main and
its env tokens can reactivate links retired with `/voice new`; account for that
explicitly when rollback involves a leaked link. A protocol 6 native app must
switch back to its protocol 4 build for old main, or protocol 5 for the shared
worker. Never run both worker builds against the same dispatch name.
