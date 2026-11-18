# Hey Dan app channel

The app is its own channel, independent of voice-mode availability. Each user and agent
have a separate app conversation with a shared-session wiring: the agent's workspace and
memory are shared with its other channels, but the app's conversation context is separate.
The channel owns a durable event log; it does not expose the container mailbox as a client
API. Whole messages arrive after a working status, without token streaming.

## Configuration

| Key                                                          | Purpose                                                                                                              | Advertised feature                                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `APP_PUBLIC_BASE`                                            | Public HTTPS base, such as `https://app.example.com`, used in pairing and push host identity.                        | None by itself.                                                                     |
| `NANOCLAW_ENCRYPTION_KEY`                                    | Host-only encryption key; HKDF-SHA256 derives a separate 32-byte upload-ticket key with info `heydan-app-ticket-v1`. | `files` when the key parses.                                                        |
| `APP_LIVEKIT_URL`                                            | Public WebSocket address returned in app call grants.                                                                | `calls`, `voice-picker` when set.                                                   |
| `APP_APNS_TEAM_ID`                                           | Apple developer team for push signing.                                                                               | `push` with a topic, a public base and at least one readable P-256 environment key. |
| `APP_APNS_TOPIC`                                             | App bundle topic: your application bundle identifier. No default; push stays off without it.                         | Required for `push`.                                                                |
| `APP_APNS_SANDBOX_KEY_ID`, `APP_APNS_SANDBOX_KEY_PATH`       | Sandbox signing key identifier and host-local key file.                                                              | Both required for sandbox credentials.                                              |
| `APP_APNS_PRODUCTION_KEY_ID`, `APP_APNS_PRODUCTION_KEY_PATH` | Production signing key identifier and host-local key file.                                                           | Both required for production credentials.                                           |

`GET /app/hello` returns protocol 1, minimum protocol 1, voice protocol 6, server time in
milliseconds, and `features`. These are configuration checks, not service health
probes: a configured call URL does not prove the voice worker is online, and the push
feature checks the local key but does not probe APNs connectivity. Chat remains usable when voice is offline.
The host re-reads these settings and the key files at most once a minute.
Keep signing keys on the host, outside agent containers and source control.

## Pairing and revocation

Pairing starts with `/pair` in Telegram, restricted to an owner or admin over
the target agent. Paste its single-use link into the app within 10 minutes. The code is in
the URL fragment and is submitted only in the pairing body. The phone proves possession
of its P-256 private key; the host stores its public key and the permitted agent set.
Only paired agents appear, not every agent the user's role could otherwise access.

Every successful pairing sends a direct notice with the device name, UTC time and revocation
instructions, after the pairing has been answered; a failed or slow notice does not undo or
delay pairing. Device names are chosen by the paired phone, so chat replies show them as
inline code, never as formatting or links.

For a lost phone, send `/pair list` in your direct chat, then `/pair revoke <id>`.
The list shows your live devices in pairing order, their short ids and UTC pairing times.
Revoke accepts a short id, full id or exact device name; an id match wins over a name, and
duplicate names require an id. These commands work without an owner or admin role, answer
only known users, and never show devices in a group chat.

The host-only administrative interface remains:

```sh
ncl devices list --user <user-id>
ncl devices pair --user <user-id> --agents <agent-id>,<another-agent-id>
ncl devices revoke --id <device-id>
```

Both user and agent selection are required when pairing from the CLI. Revocation closes its
event stream, ends its calls and rejects subsequent signatures and upload tickets.

Requests use `HeyDan-Sig` authorization: protocol, device id, timestamp, fresh nonce, body
hash and an ECDSA signature covering the method and canonical target too. Nonces survive a
restart. Only hello, pairing and ticketed uploads omit request signatures. Upload tickets
are limited to one file's exact size and hash, expire after one hour and remain subject to
device revocation. Never paste links or authorization headers into logs or reports.

## Routes

All paths below are under `/app`. `:id` denotes an opaque identifier.

| Method | Path                                | Purpose                                        | Authorization |
| ------ | ----------------------------------- | ---------------------------------------------- | ------------- |
| GET    | `/hello`                            | Versions and configured features               | None          |
| POST   | `/pair`                             | Consume pairing code and proof                 | Pairing proof |
| GET    | `/conversations`                    | Conversations, statuses and badge              | Signature     |
| GET    | `/conversations/:id/messages`       | History; `before` or `after`, optional `limit` | Signature     |
| POST   | `/conversations/:id/messages`       | Store and enqueue a message                    | Signature     |
| POST   | `/conversations/:id/read`           | Advance shared read order                      | Signature     |
| POST   | `/questions/:id/answer`             | Claim an option                                | Signature     |
| GET    | `/events`                           | SSE replay and live events after `after`       | Signature     |
| POST   | `/files`                            | Mint an upload                                 | Signature     |
| POST   | `/files/:id/ticket`                 | Renew upload ticket                            | Signature     |
| PUT    | `/files/:id`                        | Upload exact bytes                             | Ticket        |
| GET    | `/files/:id`                        | Download an authorized attachment              | Signature     |
| POST   | `/calls`                            | Start or recover an attempt                    | Signature     |
| POST   | `/calls/:callId/end`                | End that call                                  | Signature     |
| POST   | `/calls/attempts/:attemptId/cancel` | Cancel a pending start                         | Signature     |
| GET    | `/conversations/:id/voice`          | Read saved voice                               | Signature     |
| PATCH  | `/conversations/:id/voice`          | Update saved voice                             | Signature     |
| GET    | `/conversations/:id/voices`         | Browse voice catalog                           | Signature     |
| PUT    | `/devices/me/push-token`            | Register token and environment                 | Signature     |
| DELETE | `/devices/me`                       | Revoke this device                             | Signature     |

Errors have a stable `error` code and display-ready `message`, with extra fields where
needed. The app must not infer state from prose. The authoritative examples are
[contract fixtures](../src/channels/app/app-contract.fixtures.json).

## Network boundary

The `/app` gate admits loopback or a peer explicitly trusted by
`VOICE_MODE_TRUSTED_PROXY_CIDRS` (comma-separated IPv4 or IPv6 CIDRs). There is no
hard-coded container subnet. Trust configuration is refreshed at most once a minute.
It must not inherit `VOICE_MODE_ALLOWED_CLIENT_CIDRS`: public app clients are not restricted
to tailnet addresses. A trusted network path never replaces device signature verification.

Rate limits are per client address: 10 `POST /app/pair` and 60 failed signatures per address
per 10 minutes. The address is the rightmost `X-Forwarded-For` hop outside the trusted list,
and only when the peer itself is a trusted proxy; the client-controlled `Forwarded` header is
ignored. List your proxy's own address in `VOICE_MODE_TRUSTED_PROXY_CIDRS`, even a loopback
one: otherwise every client arrives as the proxy's address and shares one bucket, and ten bad
pair requests lock out every pairing for 10 minutes.

The trusted list is shared with the voice routes, where a trusted peer with no
`VOICE_MODE_ALLOWED_CLIENT_CIDRS` admits any client it forwards. So the public proxy must
forward only `/app` and its children, or the allowed-client list must be set. Give that proxy
a 26 MiB request-body cap, and timeouts that suit SSE and uploads, without compression or
redirects. Configure that boundary in your deployment proxy; the channel does not configure
the proxy.

## Files, questions and sync

The file store pairs metadata in `app_files` with bytes under `data/app-files/`. Uploads have a 25 MiB limit and a stable
`uploadKey` for retry. Only completed, owned files can be claimed by a message. Unclaimed
files become eligible for cleanup 24 hours after minting; cleanup runs at startup and hourly. Downloads recheck conversation access.

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

App-wired agents receive the "Hey Dan app formatting" section (`src/channels/app/agent-docs.ts`).
It asks for dollar signs in backticks because [MarkdownView](https://github.com/Lakr233/MarkdownView)
4.8.5 renders `$...$` as math.

App logs must contain ids, states, error codes and timings only. They must never contain
message text, pairing codes or links, call links, authorization headers, upload tickets,
private keys or push tokens. This logging boundary must also hold in proxies and test
artifacts.
