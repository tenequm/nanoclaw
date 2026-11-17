# Hey Dan app channel

Implementation status: this branch has the channel skeleton and formatting instructions.
Pairing, signed dispatch, chat, streaming, files, push and calls await the implementation
lanes. The operational behavior below is the protocol 1 contract, not a claim that the
skeleton can be deployed. Configuration and the route table already exist in
[src/channels/app/config.ts](../src/channels/app/config.ts) and
[src/channels/app/routes.ts](../src/channels/app/routes.ts).

The app is its own channel, independent of voice-mode availability. Each user and agent
have a separate app conversation with a shared-session wiring: the agent's workspace and
memory are shared with its other channels, but the app's conversation context is separate.
The channel owns a durable event log; it does not expose the container mailbox as a client
API. Whole messages arrive after a working status, without token streaming.

## Configuration

| Key | Purpose | Advertised feature |
| --- | --- | --- |
| `APP_PUBLIC_BASE` | Public HTTPS base used in pairing and push host identity. | None by itself. |
| `NANOCLAW_ENCRYPTION_KEY` | Host-only encryption key; HKDF-SHA256 derives a separate 32-byte upload-ticket key with info `heydan-app-ticket-v1`. | `files` when the key parses. |
| `APP_LIVEKIT_URL` | Public WebSocket address returned in app call grants. | `calls`, `voice-picker` when set. |
| `APP_APNS_TEAM_ID` | Apple developer team for push signing. | `push` with at least one complete environment key pair. |
| `APP_APNS_TOPIC` | App bundle topic; defaults to `com.tenequm.HeyDan`. | None by itself. |
| `APP_APNS_SANDBOX_KEY_ID`, `APP_APNS_SANDBOX_KEY_PATH` | Sandbox signing key identifier and host-local key file. | Both required for sandbox credentials. |
| `APP_APNS_PRODUCTION_KEY_ID`, `APP_APNS_PRODUCTION_KEY_PATH` | Production signing key identifier and host-local key file. | Both required for production credentials. |

`GET /app/hello` returns protocol 1, minimum protocol 1, voice protocol 6, server time in
milliseconds, and `configuredFeatures`. These are configuration checks, not service health
probes: a configured call URL does not prove the voice worker is online, and the push
feature does not prove a key file is readable. Chat remains usable when voice is offline.
Keep signing keys on the host, outside agent containers and source control.

## Pairing and revocation

The pairing contract starts with `/pair` in Telegram, restricted to an owner or admin over
the target agent. Paste its single-use link into the app within 10 minutes. The code is in
the URL fragment and is submitted only in the pairing body. The phone proves possession
of its P-256 private key; the host stores its public key and the permitted agent set.
Only paired agents appear, not every agent the user's role could otherwise access.

The administrative interface is `ncl devices list`, `ncl devices pair` and
`ncl devices revoke`; pairing selects a user and can restrict agents with `--agents`.
Consult `ncl devices help` for installed flags once the device-auth lane lands. To retire a
lost phone, list devices, identify the phone and revoke that device. The contract requires
revocation to close its event stream and reject subsequent signatures and upload tickets.
`DELETE /app/devices/me` removes the requesting phone's access.

Requests use `HeyDan-Sig` authorization: protocol, device id, timestamp, fresh nonce, body
hash and an ECDSA signature covering the method and canonical target too. Nonces survive a
restart. Only hello, pairing and ticketed uploads omit request signatures. Upload tickets
are limited to one file's exact size and hash, expire after one hour and remain subject to
device revocation. Never paste links or authorization headers into logs or reports.

## Routes

All paths below are under `/app`. `:id` denotes an opaque identifier.

| Method | Path | Purpose | Authorization |
| --- | --- | --- | --- |
| GET | `/hello` | Versions and configured features | None |
| POST | `/pair` | Consume pairing code and proof | Pairing proof |
| GET | `/conversations` | Conversations, statuses and badge | Signature |
| GET | `/conversations/:id/messages` | History; `before` or `after`, optional `limit` | Signature |
| POST | `/conversations/:id/messages` | Store and enqueue a message | Signature |
| POST | `/conversations/:id/read` | Advance shared read order | Signature |
| POST | `/questions/:id/answer` | Claim an option | Signature |
| GET | `/events` | SSE replay and live events after `after` | Signature |
| POST | `/files` | Mint an upload | Signature |
| POST | `/files/:id/ticket` | Renew upload ticket | Signature |
| PUT | `/files/:id` | Upload exact bytes | Ticket |
| GET | `/files/:id` | Download an authorized attachment | Signature |
| POST | `/calls` | Start or recover an attempt | Signature |
| POST | `/calls/:callId/end` | End that call | Signature |
| POST | `/calls/attempts/:attemptId/cancel` | Cancel a pending start | Signature |
| GET | `/conversations/:id/voice` | Read saved voice | Signature |
| PATCH | `/conversations/:id/voice` | Update saved voice | Signature |
| GET | `/conversations/:id/voices` | Browse voice catalog | Signature |
| PUT | `/devices/me/push-token` | Register token and environment | Signature |
| DELETE | `/devices/me` | Revoke this device | Signature |

Errors have a stable `error` code and display-ready `message`, with extra fields where
needed. The app must not infer state from prose. The authoritative examples are
[contract fixtures](../src/channels/app/app-contract.fixtures.json).

## Network boundary

The planned `/app` gate admits loopback or a trusted proxy peer on `172.18.0.0/16`.
It must not inherit `VOICE_MODE_ALLOWED_CLIENT_CIDRS`: public app clients are not restricted
to tailnet addresses. Rate limiting uses the rightmost untrusted `X-Forwarded-For` hop,
not the client-controlled `Forwarded` header. A trusted network path never replaces device
signature verification. In this skeleton the dispatch gate and verifier are not wired yet.

The external proxy serves only `/app` and its children, with a 26 MiB request-body cap.
SSE and uploads need suitable proxy timeouts, without compression or redirects. Do not
expose the skeleton publicly while its authentication handlers remain stubs.

## Files, questions and sync

The file store pairs metadata in `app_files` with host-local bytes; its disk location and
cleanup implementation belong to the file lane. Uploads have a 25 MiB limit and a stable
`uploadKey` for retry. Only completed, owned files can be claimed by a message. Unclaimed
files are removed 24 hours after minting. Downloads recheck conversation access.

Messages and questions have immutable creation `order` and a changing `seq` version.
The stream cursor advances only on stream events or `synchronized`, never on REST reads.
Read state is shared between the user's devices. The first question answer wins; another
choice returns the current question with `not_open`. The server expires buttons at the
runner's deadline or when the agent stops waiting.

## Push and calls

Store separate APNs signing keys for sandbox and production. Register each device token
with its build environment; do not guess it from token length. Push is sent for new agent
messages and questions only, not edits, reactions, host messages or mirrored call speech.
The preview passes through Apple's push service. The payload includes host identity from
`APP_PUBLIC_BASE`, the conversation and entity ids, and the device-scoped unread badge.
Invalid or unregistered tokens are cleared. Approval cards remain in Telegram.

An app call binds the line's call chat to the app conversation. Its transcript and spoken
replies go there, including subsequent calls made through other entry points, until the
line's caller uses `/voice` in Telegram to bind it back. This changes call context as well
as transcript destination. An `attemptId` makes retries recover one call; cancellation
prevents a lost response from leaving an unwanted call. The saved-voice and catalog routes
use the paired device's identity, not a saved call-link decoder.

## Agent formatting and logging

App-wired agents receive the "Hey Dan app formatting" section. It teaches standard
markdown, narrow scrolling tables, code fences with languages, short paragraphs and the
backtick rule for dollar signs because [MarkdownView](https://github.com/Lakr233/MarkdownView)
4.8.5 interprets them as math. Pictures and documents use `send_file`; choices use
`ask_user_question`. Telegram-only syntax is not used in app messages.

App logs must contain ids, states, error codes and timings only. They must never contain
message text, pairing codes or links, call links, authorization headers, upload tickets,
private keys or push tokens. This logging boundary must also hold in proxies and test
artifacts; implementation and operational verification remain part of the pending lanes.
