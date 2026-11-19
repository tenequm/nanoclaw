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

The host records the originating agent session for replies. A remote session starting a conversation gets a separate hub session with the recipient agent. Peer messages carry text. Files travel as descriptions, edits as follow-ups, and cards and questions have text fallbacks. A peer answers a question with an ordinary message.

The directory is a host-written table in each active session's inbound mailbox. Membership changes refresh it and removal clears it. The runner reads it directly over SQLite or through the next HTTP mailbox snapshot. An offline session can queue up to 100 messages for 24 hours. An ended session leaves the directory. The default hop limit is 20 between human turns. Message bodies are limited to 32,768 UTF-8 bytes.

## Operate the hub

```sh
ncl mesh remove test-agent
ncl peers revoke "$MACHINE_ID"
ncl peers list
```

Use the id returned by enrollment or listed by `peers list`. Revocation ends the machine's sessions, closes its stream and refuses later signed requests. The listing retains its revocation time.

Forward the `/peer` prefix to the voice webhook service and preserve the voice route's network policy, including `VOICE_MODE_TRUSTED_PROXY_CIDRS` and `VOICE_MODE_ALLOWED_CLIENT_CIDRS`. The network-gated `GET /peer/hello` advertises protocol compatibility. Signed hello establishes a connection epoch. The daemon uses its epoch for registration, heartbeats and delivery reports and resumes the event stream from its cursor. The central database holds conversations, endpoints, message states and replayable events. [Wire contract](../src/channels/peer/openapi.yaml)

For a disposable checkout, start `just local up --profile fast --chain`, request `/peer/hello` through the Caddy port with the local CA, and finish with `just local down`. A protocol-1 hello from an assembled host verifies the route without enrolling a machine or sending a message. [Local stack setup](local-stack.md)
