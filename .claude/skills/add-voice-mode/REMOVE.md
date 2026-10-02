# Remove Voice mode

Reverses `/add-voice-mode`. Every step is idempotent: safe to re-run, and to skip
when its target is already gone.

## 1. Stop the worker

```bash
# Linux
systemctl --user disable --now nanoclaw-voice-mode-worker.service
rm -f ~/.config/systemd/user/nanoclaw-voice-mode-worker.service && systemctl --user daemon-reload
# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw-voice-mode-worker.plist
rm -f ~/Library/LaunchAgents/com.nanoclaw-voice-mode-worker.plist
```

Remove the `tailscale serve` mount or proxy route for `/voice` (and, with a
self-hosted LiveKit, for `/rtc` and the TURN name) too.

## 2. Retire the lines

With the host still running, invalidate every call link (the table holds only
token hashes, the caller and the bound chat). The empty table stays, so a later
reinstall starts with no working links:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM voice_mode_lines"
```

Turn recordings (`VOICE_MODE_RECORDINGS_DAYS`) are under `data/voice-recordings/`;
delete that directory if you do not want them. Roles granted for `/voice` are
core's and stay; revoke any you no longer want with `ncl roles revoke`.

## 3. Remove the registration

Delete the line `import './voice-mode.js';` from `src/channels/index.ts`:

```bash
sed -i.bak "/^import '\.\/voice-mode\.js';$/d" src/channels/index.ts && rm -f src/channels/index.ts.bak
```

## 4. Remove the copied files

```bash
rm -f src/channels/voice-mode.ts src/channels/voice-mode-page.ts src/channels/voice-mode-command.ts \
  src/channels/voice-mode-line.ts src/channels/voice-mode-livekit.ts src/channels/voice-mode-protocol.ts \
  src/channels/voice-mode-route.ts src/voice-mode-worker.ts src/db/voice-mode-lines.ts \
  src/channels/voice-mode-registration.test.ts src/channels/voice-mode-adapter.test.ts \
  src/channels/voice-mode-page.test.ts src/channels/voice-mode-command.test.ts \
  src/channels/voice-mode-line.test.ts src/channels/voice-mode-livekit.test.ts \
  src/channels/voice-mode-route.test.ts src/voice-mode-worker.test.ts
rm -rf container/skills/voice-mode-formatting
```

## 5. Remove the packages

`zod` only if nothing else uses it:

```bash
pnpm remove @livekit/agents @livekit/agents-plugin-google @livekit/agents-plugin-silero @livekit/rtc-node livekit-server-sdk zod
```

## 6. Remove the environment keys

`GEMINI_API_KEY` only if nothing else uses it:

```bash
sed -i.bak '/^VOICE_MODE_[A-Z_]*=/d;/^LIVEKIT_[A-Z_]*=/d' .env && rm -f .env.bak
```

## 7. Rebuild and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

A LiveKit Cloud project or a self-hosted LiveKit server is yours to delete.
