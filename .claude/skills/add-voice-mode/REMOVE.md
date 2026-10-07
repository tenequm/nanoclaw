# Remove voice mode

Close this page's admission front, finish active calls and stop the host before removal. Privately back up the central DB and `.env`; never print credentials. Stop a terminal worker with Ctrl-C. Remove the persistent worker using the installer while its script exists:

```bash
pnpm exec tsx scripts/voice-mode-install.ts service-remove
```

Remove only this checkout's HTTPS `/voice` route and any dedicated worker callback front. Preserve shared LiveKit services and other routes.

## Retire links and guidance

With the installed payload still present, retire the module's hashed links and remove its guidance from explicit group lists using core DB/config helpers:

```bash
pnpm exec tsx scripts/voice-mode-install.ts retire
```

This deletes rows only in `voice_mode_lines` and preserves the empty table and named migration record for reinstall. It removes only `voice-mode-formatting` from explicit lists, preserving other entries. It does not delete core identities, roles, memberships, chats or sessions. A partial installation without the table is accepted.

## Restore core and delete the payload

The installer reverses every core import, call and export it added, and the worker package script, before its own file is deleted. It tolerates reapplication and refuses changed anchors rather than editing unfamiliar core code.

```bash
pnpm exec tsx scripts/voice-mode-install.ts remove
rm -f src/channels/voice-mode-adapter.test.ts \
  src/channels/voice-mode-call-session.test.ts \
  src/channels/voice-mode-command.test.ts \
  src/channels/voice-mode-command.ts \
  src/channels/voice-mode-gemini-live.test.ts \
  src/channels/voice-mode-gemini-live.ts \
  src/channels/voice-mode-integration.test.ts \
  src/channels/voice-mode-integration.ts \
  src/channels/voice-mode-line-roles.test.ts \
  src/channels/voice-mode-line.ts \
  src/channels/voice-mode-livekit.test.ts \
  src/channels/voice-mode-livekit.ts \
  src/channels/voice-mode-page.test.ts \
  src/channels/voice-mode-page.ts \
  src/channels/voice-mode-third-party-notices.txt \
  src/channels/voice-mode-protocol.ts \
  src/channels/voice-mode-registration.test.ts \
  src/channels/voice-mode-review-page.test.ts \
  src/channels/voice-mode-route.test.ts \
  src/channels/voice-mode-route.ts \
  src/channels/voice-mode-wakeword.test.ts \
  src/channels/voice-mode-wakeword.ts \
  src/channels/voice-mode-worker.test.ts \
  src/channels/voice-mode-worker.ts \
  src/channels/voice-mode.ts \
  src/channels/voice-mode-wakeword-fixtures/negative.wav \
  src/channels/voice-mode-wakeword-fixtures/positive.wav \
  src/db/voice-mode-lines.ts \
  scripts/voice-mode-install.ts \
  scripts/voice-mode-install.test.ts \
  assets/voice-mode-wakeword/LICENSE \
  assets/voice-mode-wakeword/NOTICE \
  assets/voice-mode-wakeword/embedding_model.onnx \
  assets/voice-mode-wakeword/hey_livekit.onnx \
  assets/voice-mode-wakeword/melspectrogram.onnx \
  container/skills/voice-mode-formatting/instructions.md \
  logs/voice-mode-worker.log
rmdir src/channels/voice-mode-wakeword-fixtures assets/voice-mode-wakeword container/skills/voice-mode-formatting
```

Remove compiled counterparts under `dist/channels/voice-mode*` and `dist/db/voice-mode-lines.*`; preserve every unrelated artifact. Retain operator-owned recordings, vocabulary and custom classifiers unless the operator is retiring that data. The skill definition and browser maintainer sources may stay installed for reinstallation.

## Dependencies and configuration

Inspect remaining imports with `rg` and consumers with `pnpm why <package>` for each package below. Remove a direct dependency only when no other integration uses it. In a voice-only fresh installation all seven can be removed:

```bash
pnpm remove @livekit/agents @livekit/agents-plugin-google @livekit/agents-plugin-silero @livekit/rtc-node livekit-server-sdk onnxruntime-node zod
```

Privately delete this skill's `VOICE_MODE_*` entries from `.env`. Remove `LIVEKIT_*` and `GEMINI_API_KEY` only if no remaining integration uses them; otherwise preserve them. Preserve all other configuration.

```bash
pnpm run build
bash setup/lib/restart.sh
```

Confirm unrelated channels still work and calls cannot start. Reinstallation creates new links and safely reuses the retained empty module table. The removal commands require the copied installer until the core edits are reversed; after files are absent, skip those already-completed steps.
