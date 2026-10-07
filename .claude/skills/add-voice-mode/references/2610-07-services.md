# Voice worker services

Run from the installed checkout after building. The installer captures the absolute checkout and Node executable, hashes the checkout into the same eight-character install slug as the host, and generates a user service without credential values. The worker reads this checkout's `.env`. Moving the checkout requires removing the old service before installing at the new path.

```bash
pnpm exec tsx scripts/voice-mode-install.ts --help
pnpm exec tsx scripts/voice-mode-install.ts service-install
```

On Linux this writes and enables `~/.config/systemd/user/nanoclaw-v2-<slug>-voice-mode-worker.service`. On macOS it bootstraps `~/Library/LaunchAgents/com.nanoclaw-v2-<slug>-voice-mode-worker.plist` in the logged-in user's GUI domain. Reapply restarts only that install's worker. For Linux persistence without a login, the operator can enable user lingering according to their host's service policy.

Keep the host's webhook port, optional page port and worker health port distinct between copies; also choose a distinct `LIVEKIT_AGENT_NAME` and matching host/worker configuration. This prevents job dispatch to a different install. Install `ffmpeg` using the host's package manager for typing audio. Confirm the health response privately at the loopback `/worker` endpoint on `VOICE_MODE_WORKER_HEALTH_PORT` (default 8089): expected agent name, protocol 6 and zero active jobs before a test call. Then verify transcription, audible reply, reviewed send/discard and reconnect on a private test line. A fallback to transcript wake does not prove acoustic inference is working.

Stop admission at the page front before upgrades or removal, finish active calls, then:

```bash
pnpm exec tsx scripts/voice-mode-install.ts service-remove
```

This stops and removes only the unit/plist derived from the current checkout. Stop terminal workers with Ctrl-C separately. If an earlier revision used a global worker unit, privately inspect that unit's WorkingDirectory and ExecStart and retire it only after proving it belongs to this checkout. Preserve shared LiveKit servers and unrelated fronts.
