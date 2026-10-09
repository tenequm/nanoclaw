# Remove voice mode

Removal disables calls and invalidates links. Keep a private backup of the
central DB and `.env` first. Work on this checkout only. Shared LiveKit,
Gemini credentials, core roles and other integrations stay operator-owned.
Every removal step tolerates a missing target; do not run it as part of an
upgrade.

## 1. Stop the worker and remove its front

Stop a terminal worker with Ctrl-C. Disable the unit this install actually
uses, including an old `nanoclaw-voice-worker.service` if retained on upgrade.
For the new Linux unit:

```bash
systemctl --user disable --now nanoclaw-voice-mode-worker.service
rm -f ~/.config/systemd/user/nanoclaw-voice-mode-worker.service
systemctl --user daemon-reload
```

On macOS unload and delete only this install's worker LaunchAgent. Remove
only this page's reverse-proxy route or Tailscale Serve mount:

```bash
tailscale serve --https=443 --set-path=/voice off
tailscale serve status
```

Remove the legacy `/webhook/voice` mount only if this install owned it. Keep
other mounts and a LiveKit service used elsewhere.

## 2. Retire line credentials

With the host DB available:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM voice_mode_lines"
```

A partial install without the table has nothing to retire. The empty table
and its named migration record stay deliberately: dropping only the table
would prevent reinstall from recreating it. The legacy `voice_lines` and
`voice_line_owners` tables belong to the fork and remain; remove its legacy
`VOICE_LINK_TOKEN`/`VOICE_MODE_LINK_TOKEN` settings to invalidate those links.
Do not delete chat users, roles, memberships or shared sessions automatically.

## 3. Remove registration and copied files

Delete `import './voice-mode.js';` from `src/channels/index.ts`:

```bash
sed -i.bak "/^import '\.\/voice-mode\.js';$/d" src/channels/index.ts
rm -f src/channels/index.ts.bak
```

Remove these skill-owned files:

```bash
rm -f src/channels/voice-mode-adapter.test.ts \
  src/channels/voice-mode-call-session.test.ts \
  src/channels/voice-mode-command.test.ts \
  src/channels/voice-mode-command.ts \
  src/channels/voice-mode-line-roles.test.ts \
  src/channels/voice-mode-line.test.ts \
  src/channels/voice-mode-line.ts \
  src/channels/voice-mode-livekit.test.ts \
  src/channels/voice-mode-livekit.ts \
  src/channels/voice-mode-page.test.ts \
  src/channels/voice-mode-page.ts \
  src/channels/voice-mode-protocol.ts \
  src/channels/voice-mode-registration.test.ts \
  src/channels/voice-mode-review-page.test.ts \
  src/channels/voice-mode-route.test.ts \
  src/channels/voice-mode-route.ts \
  src/channels/voice-mode-tts-catalog.test.ts \
  src/channels/voice-mode-tts-catalog.ts \
  src/channels/voice-mode-tts.fixtures.json \
  src/channels/voice-mode.ts \
  src/voice-mode-gemini-live.test.ts \
  src/voice-mode-gemini-live.ts \
  src/voice-mode-jev-turn.test.ts \
  src/voice-mode-jev-turn.ts \
  src/voice-mode-tts.test.ts \
  src/voice-mode-tts.ts \
  src/voice-mode-wakeword.test.ts \
  src/voice-mode-wakeword.ts \
  src/voice-mode-worker.test.ts \
  src/voice-mode-worker.ts \
  src/db/voice-mode-lines.ts
rm -rf src/voice-mode-wakeword-fixtures assets/voice-mode-wakeword container/skills/voice-mode-formatting
```

Keep operator-owned acoustic models and recordings unless explicitly retiring
that data. Remove `voice-mode-formatting` from explicit group skill lists in
`container_configs.skills`, through the query wrapper rather than `sqlite3`:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs SET skills = (SELECT json_group_array(value) FROM json_each(skills) WHERE value != 'voice-mode-formatting'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE json_valid(skills) AND json_type(skills) = 'array' AND skills LIKE '%\"voice-mode-formatting\"%'"
pnpm exec tsx scripts/q.ts data/v2.db "SELECT agent_group_id FROM container_configs WHERE skills LIKE '%voice-mode-formatting%'"
```

The second query must print nothing.
The old core line admin commands and legacy tables are retained for rollback.
The native Telegram structural handler and router export are safe without the
voice adapter and need not be removed.

## 4. Remove dependencies only when unused

For each of `@livekit/agents`, `@livekit/agents-plugin-elevenlabs`,
`@livekit/agents-plugin-google`, `@livekit/agents-plugin-silero`,
`@livekit/rtc-node`, `livekit-server-sdk`, `onnxruntime-node` and `zod`,
inspect remaining imports with `rg` and consumers with `pnpm why <package>`.
Use `pnpm remove <package>` only when no remaining source or dependency needs
it. Do not remove shared packages blindly.
Remove `scripts.voice-mode-worker` from package.json, or retain it if another
worker now uses that entry. Preserve all other scripts and lockfile changes.

## 5. Remove configuration and rebuild

Privately back up `.env`. Delete this skill's `VOICE_MODE_*` entries (the
provider keys `VOICE_MODE_GEMINI_API_KEY` and `VOICE_MODE_ELEVENLABS_API_KEY`
included) and legacy `VOICE_*` entries. Keep `LIVEKIT_*`, `GEMINI_API_KEY` and
`JEV_*` values used by other integrations. Do not display the file or its values.

```bash
pnpm run build
bash setup/lib/restart.sh
rm -f dist/channels/voice-mode*.* dist/voice-mode*.* dist/db/voice-mode-lines.*
```

If older compiled voice files were left by migration, remove only their
voice-specific counterparts too. Confirm the host still builds and calls no
longer start. Retire a dedicated LiveKit project/service separately only if
nothing else uses it. Reinstallation reuses the empty module table safely.
