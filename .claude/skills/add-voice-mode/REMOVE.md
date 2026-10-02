# Remove voice mode

Reverses `/add-voice-mode`. Every step is idempotent — safe to re-run, and safe
when only partially installed (skip any step whose target is already absent).

## 1. Delete the barrel import

Remove the self-registration line from `src/channels/index.ts` (delete it, do
not comment it out):

```bash
sed -i.bak "/^import '\.\/voice\.js';$/d" src/channels/index.ts && rm -f src/channels/index.ts.bak
```

## 2. Remove the copied files

The adapter, its line resolver, the call page, the LiveKit engine and its
worker, and their six tests:

```bash
rm -f src/channels/voice.ts src/channels/voice-line.ts src/channels/voice-call-page.ts src/channels/voice-adapter.test.ts src/channels/voice-registration.test.ts src/channels/voice-line.test.ts src/channels/voice-call-page.test.ts
rm -f src/channels/voice-livekit.ts src/channels/voice-livekit-protocol.ts src/channels/voice-livekit.test.ts src/voice-livekit-worker.ts src/voice-livekit-worker.test.ts
```

If the LiveKit worker runs as a systemd user unit, stop and remove it first:

```bash
systemctl --user disable --now nanoclaw-voice-worker.service
rm -f ~/.config/systemd/user/nanoclaw-voice-worker.service && systemctl --user daemon-reload
```

Recorded caller turns (`VOICE_RECORDINGS_DAYS`) are under
`data/voice-recordings/`; delete that directory if you do not want to keep them.

## 3. Remove the container skill

`container/skills/` is a read-only mount; the per-group skill symlink is pruned
on the next spawn:

```bash
rm -rf container/skills/voice-formatting
```

## 4. Remove the environment keys

`GEMINI_API_KEY` is removed only if nothing else on this install uses it
(check `.env` for other consumers first):

```bash
sed -i.bak '/^VOICE_[A-Z_]*=/d' .env && rm -f .env.bak
sed -i.bak '/^LIVEKIT_URL=/d;/^LIVEKIT_WORKER_URL=/d;/^LIVEKIT_API_KEY=/d;/^LIVEKIT_API_SECRET=/d;/^LIVEKIT_AGENT_NAME=/d;/^LIVEKIT_HOST_URL=/d' .env && rm -f .env.bak
# only if no other consumer:
# sed -i.bak '/^GEMINI_API_KEY=/d' .env && rm -f .env.bak
```

## 5. Rebuild and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

The named voice user, membership, messaging group and wiring are runtime data.
Remove membership with `ncl members remove --user <voice-id> --group <agent-id>`
and delete the wiring and messaging group with `ncl wirings delete` and
`ncl messaging-groups delete` if you no longer want them listed. Retain the
user record when keeping call history. Before deleting a line's messaging group,
`ncl voice-lines remove --line voice:<line id>` drops its owners and call chat.
The LiveKit server and the Gemini key are managed outside NanoClaw.
