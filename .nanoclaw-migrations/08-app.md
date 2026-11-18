# App channel and device authentication

Covers commit 15. Source: the fork-`main` commit that squash-merges the app channel PR;
record its hash here when it lands, and take every `[COPY]` from it in one pass:

```sh
git checkout <source> -- $(sed -n 's/^- `\(.*\)`: \[COPY\]$/\1/p' .nanoclaw-migrations/08-app.md)
```

This is additive to the existing voice channel.

Depends on:

- Commit 1: `registerProjectDocSection` (the app formatting section).
- Commit 2: the `inReplyTo` parameter of the channel delivery interface; `sourceId` is added
  after it in `delivery.ts` and `channel-registry.ts`.
- Commit 6: host command replies and cards written through `writeOutboundDirect` under
  `hcmd-` ids, which the app shows as host lines.
- Commit 7: the `ES2023` lib (`findLast` in `gate.ts`).
- Commit 12: the voice adapter, `createCallPage`, the call core's marks and the `/voice`
  command that the app's calls and picker build on.

## Shape

Device-auth owns pairing, P-256 signatures, durable nonces, revocation and the proxy
gate. The app owns its event log, conversation wiring, outbox source deduplication,
questions, file tickets and storage, SSE, device-scoped push and call attempts.
The phone renders whole entities; container session databases remain private.

Use [the deployment guide](../docs/app-channel.md) for configuration. Examples use
`https://app.example.com`; supply your own proxy CIDRs and application identifiers.
No infrastructure host, account, key or device identity belongs in the replay.

## 15.1 New files [COPY]

Copy each file below in full. App and device-auth migrations register by name on import;
do not renumber or transplant them into the core migration list. Include the test oracles
and signing helper with their producers.

- `docs/app-channel.md`
- `scripts/app-contract-fixtures.mjs`
- `scripts/app-sign.test.ts`
- `scripts/app-sign.ts`
- `src/channels/app/agent-docs.ts`
- `src/channels/app/apns.test.ts`
- `src/channels/app/apns.ts`
- `src/channels/app/app-contract.fixtures.json`
- `src/channels/app/app-swift-signature.fixtures.json`
- `src/channels/app/calls.test.ts`
- `src/channels/app/calls.ts`
- `src/channels/app/config.ts`
- `src/channels/app/contract-fixtures.test.ts`
- `src/channels/app/contract.test.ts`
- `src/channels/app/contract.ts`
- `src/channels/app/conversations.ts`
- `src/channels/app/db.ts`
- `src/channels/app/deliver.ts`
- `src/channels/app/files.test.ts`
- `src/channels/app/files.ts`
- `src/channels/app/index.ts`
- `src/channels/app/log.ts`
- `src/channels/app/n2a.test.ts`
- `src/channels/app/push.test.ts`
- `src/channels/app/push.ts`
- `src/channels/app/questions.ts`
- `src/channels/app/routes.ts`
- `src/channels/app/send.ts`
- `src/channels/app/skeleton.test.ts`
- `src/channels/app/status.test.ts`
- `src/channels/app/status.ts`
- `src/channels/app/stream-timeouts.test.ts`
- `src/channels/app/stream.test.ts`
- `src/channels/app/stream.ts`
- `src/channels/app/voice.ts`
- `src/cli/resources/devices.ts`
- `src/modules/device-auth/db.ts`
- `src/modules/device-auth/gate.ts`
- `src/modules/device-auth/index.ts`
- `src/modules/device-auth/pairing.test.ts`
- `src/modules/device-auth/pairing.ts`
- `src/modules/device-auth/rate-limit.ts`
- `src/modules/device-auth/verify.test.ts`
- `src/modules/device-auth/verify.ts`

## 15.2 Delivery and question metadata [MERGE]

- `src/channels/adapter.ts`: add optional `OutboundMessage.sourceId`.
- `src/delivery.ts`: add the final optional `sourceId` argument to the delivery interface;
  pass the durable outbox `msg.id` at the adapter call. Retries must keep this identity.
- `src/channels/channel-registry.ts`: accept that argument and forward it in the outbound
  object. Keep the existing reply target, instance and file handling.
- `src/channels/ask-question.ts`: add optional `expiresAt` to `AskQuestionPayload`.
- `src/session-manager.ts`: `writeOutboundDirect` records each id it writes (bounded, in
  memory) and `isHostWrittenOutbound(id)` reports it; the app grants host authority only to
  those rows, since a container chooses its own ids. `src/session-manager.test.ts` asserts it.
- `src/modules/interactive/index.ts`: export `handleInteractiveResponse`, the only handler an
  app answer is handed to.
- `container/agent-runner/src/mcp-tools/interactive.ts`: emit `Date.now() + timeout`
  in the question payload, so the phone uses the runner's actual deadline.

## 15.3 Registration and redaction [MERGE]

- `src/channels/index.ts`: import `./app/index.js` to register the channel and routes.
- `src/cli/resources/index.ts`: import `./devices.js` for the host-only device commands.
- `src/channels/telegram-grammy/inbound.ts`: in the wordwise link redactor, replace any
  word containing `/app/pair#` with `[pairing link]` before voice-link matching.
- `docs/chat-commands.md`: insert the `/pair` row beside `/voice`, including the admin
  restriction and private delivery in group chats.

## 15.4 Voice integration [MERGE]

- `src/channels/voice-mode.ts`: move the existing loopback/CIDR/proxy helpers into
  device-auth's gate module and re-export them to preserve existing imports. Retain the
  voice route's allowed-client policy; app routes use only the trusted-peer policy.
  Add the app start/resume/end and line picker methods to the adapter interface and
  implementation. Refactor TTS/catalog errors through `PickerError`; preserve the
  link route's plain-text errors and give paired callers JSON errors. Allow reading
  defaults without creating a line; create on a valid save only after validation.
- `src/channels/voice-mode-command.ts`: add stable app error messages. Split `createCallPage` into start, resume,
  grant and end operations while retaining its page handler. Cache live app grants,
  issue fresh retry tokens, check liveness and cancellation, and retain page refusal
  translation and cleanup. Return the app operations alongside `handle`.
- `src/channels/voice-mode-livekit.ts`: export the caller marker, propagate optional
  caller metadata through mirror/postToChat, and add `voice: spoken` to app spoken
  delivery. Preserve the existing visible prefixes on other channels.
- `src/channels/voice-mode-command.test.ts`: extend the fake core with `isLive` and
  cover liveness loss during token issuance.
- `src/channels/voice-mode-livekit.test.ts`: add the app caller/spoken marker assertions
  and preserve other-channel presentation expectations.

## 15.5 Shared HTTP lifecycle [MERGE]

- `src/webhook-server.ts`: set request timeout to 15 minutes, header timeout to 60 seconds,
  and keep-alive timeout to 95 seconds on the candidate server. On shutdown, close all
  HTTP connections as well as upgraded sockets so SSE and incomplete uploads cannot
  hold shutdown open. Preserve singleton/listener failure recovery.

## Verification and exclusions

Run typechecking, lint and formatting for changed files, the app/device-auth/signing
suites, and the existing tests for each shared file above. The fixture producer suite
uses real signed HTTP dispatch and isolated databases. Keep fixture differences visible;
do not silently replace nonvolatile expected values with actual response values.

The local-stack tooling and stand-in provider are separate work. Do not replay
`scripts/local/`, the scripted-client stub `scripts/app-client.ts`, or `.gitignore`'s
local-run entries as part of commit 15. This guide and its index row are replay metadata.

## Files covered

- `docs/app-channel.md`: [COPY]
- `scripts/app-contract-fixtures.mjs`: [COPY]
- `scripts/app-sign.test.ts`: [COPY]
- `scripts/app-sign.ts`: [COPY]
- `src/channels/app/agent-docs.ts`: [COPY]
- `src/channels/app/apns.test.ts`: [COPY]
- `src/channels/app/apns.ts`: [COPY]
- `src/channels/app/app-contract.fixtures.json`: [COPY]
- `src/channels/app/app-swift-signature.fixtures.json`: [COPY]
- `src/channels/app/calls.test.ts`: [COPY]
- `src/channels/app/calls.ts`: [COPY]
- `src/channels/app/config.ts`: [COPY]
- `src/channels/app/contract-fixtures.test.ts`: [COPY]
- `src/channels/app/contract.test.ts`: [COPY]
- `src/channels/app/contract.ts`: [COPY]
- `src/channels/app/conversations.ts`: [COPY]
- `src/channels/app/db.ts`: [COPY]
- `src/channels/app/deliver.ts`: [COPY]
- `src/channels/app/files.test.ts`: [COPY]
- `src/channels/app/files.ts`: [COPY]
- `src/channels/app/index.ts`: [COPY]
- `src/channels/app/log.ts`: [COPY]
- `src/channels/app/n2a.test.ts`: [COPY]
- `src/channels/app/push.test.ts`: [COPY]
- `src/channels/app/push.ts`: [COPY]
- `src/channels/app/questions.ts`: [COPY]
- `src/channels/app/routes.ts`: [COPY]
- `src/channels/app/send.ts`: [COPY]
- `src/channels/app/skeleton.test.ts`: [COPY]
- `src/channels/app/status.test.ts`: [COPY]
- `src/channels/app/status.ts`: [COPY]
- `src/channels/app/stream-timeouts.test.ts`: [COPY]
- `src/channels/app/stream.test.ts`: [COPY]
- `src/channels/app/stream.ts`: [COPY]
- `src/channels/app/voice.ts`: [COPY]
- `src/cli/resources/devices.ts`: [COPY]
- `src/modules/device-auth/db.ts`: [COPY]
- `src/modules/device-auth/gate.ts`: [COPY]
- `src/modules/device-auth/index.ts`: [COPY]
- `src/modules/device-auth/pairing.test.ts`: [COPY]
- `src/modules/device-auth/pairing.ts`: [COPY]
- `src/modules/device-auth/rate-limit.ts`: [COPY]
- `src/modules/device-auth/verify.test.ts`: [COPY]
- `src/modules/device-auth/verify.ts`: [COPY]
- `container/agent-runner/src/mcp-tools/interactive.ts`: [MERGE]
- `docs/chat-commands.md`: [MERGE]
- `src/channels/adapter.ts`: [MERGE]
- `src/channels/ask-question.ts`: [MERGE]
- `src/channels/channel-registry.ts`: [MERGE]
- `src/channels/index.ts`: [MERGE]
- `src/channels/telegram-grammy/inbound.ts`: [MERGE]
- `src/channels/voice-mode-command.test.ts`: [MERGE]
- `src/modules/interactive/index.ts`: [MERGE]
- `src/session-manager.test.ts`: [MERGE]
- `src/session-manager.ts`: [MERGE]
- `src/channels/voice-mode-command.ts`: [MERGE]
- `src/channels/voice-mode-livekit.test.ts`: [MERGE]
- `src/channels/voice-mode-livekit.ts`: [MERGE]
- `src/channels/voice-mode.ts`: [MERGE]
- `src/cli/resources/index.ts`: [MERGE]
- `src/delivery.ts`: [MERGE]
- `src/webhook-server.ts`: [MERGE]
