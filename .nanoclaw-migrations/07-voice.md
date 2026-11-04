# Voice-mode (commit 12) - PENDING

Covers commit 12. Placeholder: `/meet` is being rebuilt on `feat/meet` (Recall.ai as the only meeting
bridge; the front desk and the Attendee bridge removed; a shared call core under separate `/voice`
and `/meet` layers). Re-extract this section from fork `main` after that PR merges, with:

```bash
git diff --name-only 66f0823a <fork-main> | rg 'voice-mode|meet|wakeword|secret-seal|webhook-server'
```

## Known now

- One commit: the `/add-voice-mode` skill, the `voice-mode-*` channel, worker and protocol files,
  the wake-word assets, the Recall bridge page, the voice DB rows, and the fork's voice runbook.
- **`src/secret-seal.ts` (+ test) [COPY]:** AES-256-GCM seal/open under a host-only key
  (`NANOCLAW_ENCRYPTION_KEY`, read from `.env`, never exported to containers). Voice stores the call
  link sealed so `/voice` can show it again; only a hash of the token is used for auth.
- **`src/webhook-server.ts` [MERGE]:** the fork adds `registerRootHandler(segment, handler)` (a
  `rootRoutes` map, routing that falls back to a root segment outside `/webhook`, the status output
  listing `/<segment>`, `rootRoutes.clear()` on close). It merges cleanly onto upstream, which now
  listens on `WEBHOOK_HOST` (default `127.0.0.1`, `src/config.ts`). An install whose reverse proxy
  reaches the webhook server from outside loopback must set `WEBHOOK_HOST=0.0.0.0`; binding only a
  bridge address breaks the voice worker, which calls the host on loopback.
- Voice migrations are already module migrations (`module:voice-mode:*`); keep their names.
- Items owned by other sections but replayed here: the runner's voice prewarm and the typing voice
  observers (section 02; the `runQuery` extraction must keep upstream's `err.stack` log), the Jev
  meeting-candidate rules (they come with `feat/meet`).
- Depends on commit 6 (`COMMANDS.voice`, `hcmd-` reply ids) and commit 7 (the grammY island's
  `/voice` binding), and registers prose through commit 1's hooks.

## Files covered

Pending re-extraction.
