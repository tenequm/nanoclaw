# Voice mode upgrade and rollback

This is an operator runbook. No server actions are performed by building this
branch. Use the complete fork build, with matching host and worker. Update
native clients before the server cutover (Hey Dan 0.4.0 speaks protocol 4 and
6), and close or reload every open browser tab afterwards. Browser bookmarks
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
adapter name is `voice-mode`. Legacy calls with no chat keep their original
`voice` chat and session; the host registers a `voice` compatibility adapter
that hands their replies, typing and call links to the live voice-mode engine.
`ncl` status therefore lists both `voice-mode` and `voice`.

### Configuration rename

Every old key in the table below is accepted as its `VOICE_MODE_<suffix>`
name, with a warning naming keys only; no other `VOICE_*` key is. An explicit
new value wins when both are present, and the old key is reported as ignored. The existing `.env` parser ignores empty values;
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
The build adds a separate page listener on `127.0.0.1:3100` (`VOICE_MODE_PORT`,
`VOICE_MODE_PAGE_HOST`); main's existing `/voice` and `/webhook/voice/livekit`
fronts still work on `WEBHOOK_PORT`. Do not move a working front during the
compatibility upgrade. An install whose front already forwards `/voice` to the
webhook port does not need the listener: set `VOICE_MODE_PORT=off`.
`LIVEKIT_HOST_URL` must be a local http(s) origin (`localhost`, `127.0.0.1` or
`[::1]`); the worker refuses to start with anything else. A configured
custom wake model remains operator-owned at its current path; preserve its
phrase, threshold and vocabulary. The bundled assets moved from
`assets/voice-wakeword` to `assets/voice-mode-wakeword`: update a setting that
explicitly names the old bundled path. An external acoustic `hey dan` model
needs no rename. `off` retains transcript `hey <agent>` wake.

`LIVEKIT_AGENT_NAME` must be the same on host and worker. An explicit old
`nanoclaw-voice` override remains supported on both. The new default is
`nanoclaw-voice-mode`; a worker of another build/name must not remain running.

### Log events

Saved log queries need the new names. Worker events `voice.turn`,
`voice.reply`, `voice.call` and `voice.command near-miss` are now
`voice-mode.turn`, `voice-mode.reply`, `voice-mode.call` and
`voice-mode.command near-miss`; the Jev shadow's `voice.turn-end jev ...`
lines are `voice-mode.turn-end jev ...`. Message prefixes moved the same way:
`voice worker:` to `voice-mode worker:`, `livekit-voice:` to
`livekit-voice-mode:` and `voice:` to `voice-mode:`. A selector on the worker
unit's name must follow a renamed unit too.

The Jev shadow's daily cap now counts in `data/jev-turn-usage-<day>` files.
Main's `data/jev-turn-usage.json` and its `.lock` are removed automatically by
the first judgement of a day; nothing needs deleting by hand.

### Backup and cutover

1. Update native clients first. Install the Hey Dan build that speaks
   protocol 4 and 6 (0.4.0 or later) and confirm it still calls the old
   server. A protocol-4-only app cannot call after the cutover, and a
   protocol-6-only app could not call before it.
2. Identify this checkout's host service:

   ```bash
   source setup/lib/install-slug.sh
   voice_host_unit="$(systemd_unit).service"
   systemctl --user list-unit-files 'nanoclaw*'
   ```

   The host is `nanoclaw-v2-<install slug>.service`; the slug derives from this
   checkout's path. Do not rename or restart another install's host. Older
   custom installs may use a manually chosen unit; honor that actual name.
   Below, `old_worker` is the worker unit this install runs today, normally
   `nanoclaw-voice-worker.service`.
3. Stop admission and both processes before replacing the build:

   ```bash
   old_worker=nanoclaw-voice-worker.service
   systemctl --user stop "$old_worker"
   systemctl --user stop "$voice_host_unit"
   ```

   A terminal worker must stop too.
4. With both stopped, record the revision, service state and configuration,
   and make the SQLite backup consistent. Run from the checkout:

   ```bash
   umask 077
   b=.voice-mode-upgrade-backup
   mkdir -p "$b/units"
   git rev-parse HEAD > "$b/revision"
   cp -p .env "$b/env"
   for u in "$voice_host_unit" "$old_worker"; do
     printf '%s %s\n' "$u" "$(systemctl --user is-enabled "$u" 2>&1)" >> "$b/enablement"
   done
   systemctl --user show -p FragmentPath -p DropInPaths "$old_worker" > "$b/worker-unit-paths"
   cp -p ~/.config/systemd/user/"$old_worker" "$b/units/"
   [ -d ~/.config/systemd/user/"$old_worker".d ] && cp -Rp ~/.config/systemd/user/"$old_worker".d "$b/units/"
   pnpm exec tsx scripts/q.ts data/v2.db "SELECT agent_group_id, skills FROM container_configs" > "$b/skills"
   python3 - <<'PY'
   import sqlite3
   with sqlite3.connect('file:data/v2.db?mode=ro', uri=True) as source:
       with sqlite3.connect('.voice-mode-upgrade-backup/central.db') as backup:
           source.backup(backup)
   PY
   ```

   If `worker-unit-paths` names a unit file or drop-in elsewhere, copy that
   path instead. Keep vocabulary files and custom wake models where they are.
   Keep this directory private and untracked, preferably outside the checkout
   after creating it. Do not commit it, print it or copy it to an agent's
   workspace. For another central backend, use its backup procedure instead of
   the SQLite example. On macOS record `$(launchd_label)` and the worker's
   label, and copy their plists from `~/Library/LaunchAgents/` instead of the
   systemd files.
5. Install the reviewed revision from the voice-mode rebuild branch, with a
   clean checkout. Preserve local configuration and data; do not merge the
   shared registry branch into a customized install. Clear the old build so
   `dist/voice-livekit-worker.js` cannot keep running, install the locked
   dependencies, build, check the output, run the voice tests, then stamp the
   upgrade marker. The host refuses to start (and its unit crash-loops) when
   the code changed and the marker was not stamped:

   ```bash
   rm -rf dist
   pnpm install --frozen-lockfile
   pnpm run build
   test ! -e dist/voice-livekit-worker.js && test -e dist/voice-mode-worker.js
   pnpm exec vitest run src/channels/voice-mode*.test.ts src/voice-mode*.test.ts
   pnpm exec tsx scripts/upgrade-state.ts set
   ```

6. Move explicit agent skill selections from `voice-formatting` to
   `voice-mode-formatting`. They live in `container_configs.skills`; there is
   no `ncl` verb for skill lists, so use the in-tree query wrapper (never the
   `sqlite3` binary). A group on `all` needs nothing:

   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db "SELECT agent_group_id, skills FROM container_configs WHERE skills LIKE '%\"voice-formatting\"%'"
   pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs SET skills = replace(skills, '\"voice-formatting\"', '\"voice-mode-formatting\"'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE skills LIKE '%\"voice-formatting\"%'"
   pnpm exec tsx scripts/q.ts data/v2.db "SELECT agent_group_id, skills FROM container_configs WHERE skills LIKE '%voice%formatting%'"
   ```

   The last query must list every group from the first one, now with
   `voice-mode-formatting` and no `voice-formatting`. Once the host runs,
   `bin/ncl groups config get --id <group>` shows the same list; a container
   still running from before picks it up on `bin/ncl groups restart --id <group>`.
   Rename `.env` keys privately if desired, preserving exact values, commas
   and quoting; aliases allow deferring this step.
7. Point the worker at the new build. Either:

   - **Keep the unit.** Change only `nanoclaw-voice-worker.service`'s
     ExecStart to `node dist/voice-mode-worker.js start` (same Node path as
     before). `new_worker=nanoclaw-voice-worker.service`.
   - **Rename the unit.** Install `nanoclaw-voice-mode-worker.service` from
     the skill's unit, then `systemctl --user disable "$old_worker"` and
     `systemctl --user enable nanoclaw-voice-mode-worker.service`.
     `new_worker=nanoclaw-voice-mode-worker.service`.

   WorkingDirectory must be this checkout. Do not add `EnvironmentFile=`; both
   processes read `.env` directly. The host unit's name and ExecStart remain
   its existing ones.
8. Reload units and start host, then worker:

   ```bash
   systemctl --user daemon-reload
   systemctl --user start "$voice_host_unit"
   systemctl --user start "$new_worker"
   ```

   On macOS the host label is `$(launchd_label)` from the same helper:
   `launchctl bootout gui/$(id -u)/<label>` and `launchctl bootstrap
   gui/$(id -u) ~/Library/LaunchAgents/<label>.plist` for that install's
   LaunchAgent and the chosen worker LaunchAgent, updating only the worker
   executable path. New worker label: `com.nanoclaw-voice-mode-worker`;
   retain an old custom label if desired.
9. Before reopening calls, assert what runs:

   ```bash
   ps -o args= -p "$(systemctl --user show -p MainPID --value "$new_worker")"
   curl -s http://127.0.0.1:8089/worker
   journalctl --user -u "$new_worker" --since -10min | grep 'voice-mode worker: protocol v6'
   journalctl --user -u "$voice_host_unit" --since -10min | grep 'voice-mode: ready'
   ```

   The worker's arguments must end in `dist/voice-mode-worker.js start`.
   `/worker` (on `VOICE_MODE_WORKER_HEALTH_PORT` if set) must report
   `agent_name` equal to the dispatch name in both log lines
   (`nanoclaw-voice-mode` unless `LIVEKIT_AGENT_NAME` overrides it), the
   worker line must name the expected host URL, and the host's ready line
   must show `protocol` 6 and that `agentName`. Check for missing-key or failed-model warnings. On
   macOS read the arguments from `launchctl print gui/$(id -u)/<worker label>`
   and the lines from the log files its plist names.
10. Close or reload every browser tab that had a call page open. A tab still
    running the old protocol 4 page is refused with HTTP 426 and shows the
    generic "Could not start the call (HTTP 426)." on every retry, which never
    succeeds until the page reloads.
11. Reload a saved browser bookmark; check the correct caller and agent, one
    spoken send, review draft, discard, captions, reply, reconnect and hangup.
    Test the updated native app separately; its start request must include
    `v=6`. Plain `/voice` must leave the original saved link usable; do not
    test `/voice new` on a saved line unless retirement is intended. After the
    first call, confirm a `voice-mode.turn` line reaches the log store.

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
Preserve `VOICE_MODE_PORT` or its default 3100. The page listener now binds
`127.0.0.1` instead of every interface: a front that reaches it over another
address (a container bridge, the LAN) needs `VOICE_MODE_PAGE_HOST` set to that
address. Reload the browser page so it requests protocol 6. Old protocol 5 starts are refused with 426 before a room
or cost-bearing worker is created.

Behavior changes from that worker: own Gemini Live manual activities replace
AgentSession STT, unary fallback is ignored, wake is on by default, review and
spoken commands are available, and worker-side cues/captions/reconnect are
retained from main. Turn wake off in the page for pause-send operation.
Set `VOICE_MODE_LANGUAGES=en-US` if keeping the shared English default is
intended; protocol 6 defaults to main's Ukrainian/English hints. Recordings
stay off unless explicitly enabled. Replies are spoken in full unless capped.

## Rollback

Stop the new worker and host first. Switch the clean checkout back to the
recorded revision with ordinary `git checkout <recorded revision>`; do not
reset or force-push branches. Then rebuild the old code from scratch, so no
`dist/voice-mode-*` file survives, and stamp the marker for it:

```bash
b=.voice-mode-upgrade-backup
systemctl --user stop "$new_worker" "$voice_host_unit"
git checkout "$(cat "$b/revision")"
cp -p "$b/env" .env
rm -rf dist
pnpm install --frozen-lockfile
pnpm run build
test -e dist/voice-livekit-worker.js && test ! -e dist/voice-mode-worker.js
pnpm exec tsx scripts/upgrade-state.ts set
```

Restore the service manager's state for the branch taken in step 7:

- **Kept unit.** Copy the captured `nanoclaw-voice-worker.service` (and its
  `.d` drop-ins) back over the edited one, then
  `systemctl --user daemon-reload`, or systemd keeps running the cached new
  ExecStart.
- **Renamed unit.** `systemctl --user disable --now
  nanoclaw-voice-mode-worker.service`, remove its unit file, copy the
  captured old unit and drop-ins back, `systemctl --user daemon-reload`, and
  restore the old unit's enablement recorded in `$b/enablement`
  (`systemctl --user enable "$old_worker"` if it was `enabled`), so a login or
  reboot cannot revive the new worker.

Move any skill selection back, then start the recorded pair, host first:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs SET skills = replace(skills, '\"voice-mode-formatting\"', '\"voice-formatting\"'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE skills LIKE '%\"voice-mode-formatting\"%'"
systemctl --user start "$voice_host_unit"
systemctl --user start "$old_worker"
ps -o args= -p "$(systemctl --user show -p MainPID --value "$old_worker")"
curl -s http://127.0.0.1:8089/worker
journalctl --user -u "$old_worker" --since -10min | grep 'voice worker: protocol v4'
```

The arguments must end in `dist/voice-livekit-worker.js start` and
`agent_name` must be the old dispatch name (`nanoclaw-voice` unless
overridden). Compare `systemctl --user is-enabled` for both units with
`$b/enablement`. On macOS: `launchctl bootout gui/$(id -u)/<new worker label>`
and delete its plist if the label was new, copy the captured plists back,
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist` for
the host and the old worker, and check the worker's arguments in
`launchctl print gui/$(id -u)/<old worker label>`. Reload every browser tab
and switch the native app to the build that speaks protocol 4. Keep the same
public front.

The new module table is additive, so an old main build can ignore it. Prefer
keeping the current DB to preserve messages created after cutover; restore the
stopped DB snapshot only for a DB failure or a deliberate full-state rollback,
which discards later changes. Back up current state before restoring it.
For a shared rollback, preserve the existing module rows and migration record.

Links minted by protocol 6 do not work under old main. Restoring old main and
its env tokens can reactivate links retired with `/voice new`; account for that
explicitly when rollback involves a leaked link. A native app must speak
protocol 4 for old main, or protocol 5 for the shared worker. Never run both
worker builds against the same dispatch name.
