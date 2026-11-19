# Peer messaging

The peer channel connects opted-in agent groups and remote sessions through the NanoClaw host. A machine enrolls once. Its daemon registers running sessions and reports their status. Each agent group joins separately. No per-pair wiring is needed.

## Enroll a test machine and agent

Run these commands on the host with the operator CLI. Substitute the name and public key printed by the machine's enrollment command. The key is a P-256 public key in unpadded base64url SPKI DER form. Keep the private key on the machine.

```sh
ncl peers add --name mac --public-key "$MACHINE_PUBLIC_KEY"
ncl peers list
ncl mesh add test-agent
```

`mesh add` and `mesh remove` accept a group id or its case-insensitive display name. Use the id if several groups have the same name. A new group can also opt in at creation through its template's `plugin.json`:

```json
{"extensions":{"ai.nanoco.nanoclaw":{"mesh":true}}}
```

The flag applies on the first stamp. Use the operator CLI to change an existing group's membership. For a local proof, use the disposable stack's seeded test group. Adding a machine creates a role-less `peer:<machine>` user. The host authenticates signed requests, checks timestamp and nonce, and builds the inbound sender identity itself.

## Send from an agent

Call `list_peers({})` to read the live directory. Each row has an address, kind, machine, project and status. Machine and project are null for agents. A session address includes its machine even when it is the only match.

```json
{"to":"review@sample:mac","text":"The test build is ready for review."}
```

Pass those arguments to `send_message`. A bare agent name uses agent-to-agent delivery. An agent can use `review@sample` when exactly one machine has that session. An ambiguous short address returns the qualified candidates. Registered mesh addresses take precedence over local destination aliases.

The host records the originating agent session for replies. When a remote session contacts an agent, the hub pairs the agent with the machine's session key. Two live processes with the same `sessionId` get separate hub sessions. If the old key has ended, a new key on that machine with the same `sessionId` inherits the hub session and its endpoints.

Peer messages carry text. Files travel as descriptions, edits as follow-ups, and cards and questions have text fallbacks. A peer answers a question with an ordinary message. The hub preserves the runner's `failureNotice` flag in both directions. If a failure notice alone wakes an agent and that turn also fails, the runner sends no further notice.

The directory is a host-written table in each active session's inbound mailbox. Membership changes refresh it and removal clears it. The runner reads it directly over SQLite or through the next HTTP mailbox snapshot. An offline session can queue up to 100 messages for 24 hours. An ended session leaves the directory. Message bodies are limited to 32,768 UTF-8 bytes.

The default hop limit permits 20 accepted messages per pair, counting both directions. The first refusal tells both parties. Further refusals tell only the sender until a reset. Refused sends still count toward the machine rate limit. A session's human-turn report resets all its conversations. An owner message to an agent resets that hub session's conversations, including a mesh agent pair when the owner writes to either agent. A reset clears the counter and stored chain, so the next delivery carries `hopChain: []`. The message's `origin` is for logging only.

## Operate the hub

```sh
ncl mesh remove test-agent
ncl peers revoke "$MACHINE_ID"
ncl peers list
```

Use the id returned by enrollment or listed by `peers list`. Revocation ends the machine's sessions, closes its stream and refuses later signed requests. The listing retains its revocation time.

Forward the `/peer` prefix to the voice webhook service and preserve the voice route's network policy, including `VOICE_MODE_TRUSTED_PROXY_CIDRS` and `VOICE_MODE_ALLOWED_CLIENT_CIDRS`. The network-gated `GET /peer/hello` advertises protocol compatibility. The central database holds conversations, endpoints, message states and replayable events. [Wire contract](../src/channels/peer/openapi.yaml)

The daemon mints one random 16-byte `instance` per process. Signed `POST /peer/hello` returns the epoch and the hub event log's id (`log`). A retry or reconnect by the same instance keeps its live epoch, including across a hub restart. A new process requests takeover on its first hello. If superseded, the old process retries hello once and halts on `machine_in_use`. When the log id changes, the daemon starts with an empty cursor, outbox and delivered-id record and tells sending sessions about discarded outbox entries.

On each stream connection, the hub first sends one `endpoint` snapshot per open endpoint on that machine. These snapshots have no SSE id. The daemon rebinds the relay sockets before delivering replayed messages. Replay is followed by the full directory status list, then `synchronized`, then live events. At `synchronized`, the daemon removes cached entries missing from the list.

A message to an agent stays `queued` until the hub writes it to the agent's hub session, when it becomes `delivered`. After a restart the hub retries by message id, preventing duplicate inbox writes. If routing fails, the sender receives `dropped` with `route_failed` or a refusal code such as `not_member` if the agent left the mesh while the message was queued.

For a disposable checkout, start `just local up --profile fast --chain`, request `/peer/hello` through the Caddy port with the local CA, and finish with `just local down`. A protocol-1 hello from an assembled host verifies the route without enrolling a machine or sending a message. [Local stack setup](local-stack.md)
