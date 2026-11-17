# Local stack on macOS

Use a disposable checkout with the OneCLI gateway, HTTP mailbox and voice-mode
payloads installed. Full also needs the Telegram adapter. Existing `.env`, `data/`
or `store/` makes startup refuse to run. Requires Python 3, just, mise, pnpm,
Bun, Docker, OpenSSL, scp and a secret-store CLI (gopass by default), plus
livekit-server for the local LiveKit server. The script pins Node 24.22.2,
builds the host and caches a container image per checkout. Remove
`.local/image-built` when changing image inputs to force a rebuild.

```sh
just local up --profile fast --chain
python3 -B scripts/local/verify.py
just local status
just local down
just local report
```

Fast selects the stand-in agent with a local in-memory gateway and no model
credential. Voice still reads the Gemini and Jev credentials from the secret
store, and the wake model comes from `LOCAL_WAKE_MODEL_SOURCE`: a local file,
or an scp source fetched on the first run. Either way it must match
`LOCAL_WAKE_MODEL_SHA256` before it is copied into `data/`. Fast is therefore
not an offline bootstrap. Omit `--chain` for direct
access; use `--livekit cloud` for Cloud instead of the local development
server.

Full uses an approved standing test agent, a dedicated test bot, Cloud and the
proxy chain. Starting it permits inbound bot messages to spawn a real agent and
lets the host ensure that agent and its grant on the configured gateway.
Configure only an approved test identity and a dedicated test bot, then run
`just local up --profile full`.

`--proof` (full only) uses the local gateway and renders no bot token; it
exercises startup and seeding without a real model. The lock directory
`/tmp/nanoclaw-full-<uid>.lock` allows one full stack per user at a time. Use
different checkouts and port blocks for concurrent fast stacks.

## Settings

Each setting is read from the environment first, then from a user-level file
outside the checkout, so every disposable checkout shares it:
`~/.config/nanoclaw/local-stack.env`, or the path in `NANOCLAW_LOCAL_SETTINGS`.
The file is plain `KEY=VALUE` lines (no quotes; `#` starts a comment). It holds
entry names, identifiers and URLs, never secrets: secret values stay in the
store the `_ENTRY` settings name. Keep per-checkout values (`LOCAL_PORT_BASE`,
`LOCAL_RUN_DIR`) in the environment. `up` refuses to start and names every
missing setting its profile needs.

| Setting                            | Needed by   | Example or default                                                                                                            |
| ---------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `LOCAL_SECRET_CMD`                 | -           | `gopass show --password` (default); the entry name is appended, one line is expected                                          |
| `LOCAL_GEMINI_API_KEY_ENTRY`       | fast, full  | `example/gemini-api-key`                                                                                                      |
| `LOCAL_JEV_API_KEY_ENTRY`          | fast, full  | `example/jev-api-key`                                                                                                         |
| `LOCAL_WAKE_MODEL_SHA256`          | fast, full  | 64 lowercase hex digits of the wake model                                                                                     |
| `LOCAL_WAKE_MODEL_SOURCE`          | fast, full  | `~/models/wake.onnx`, read in place; or any scp source such as `models.example.com:wake.onnx`, cached per digest in `.local/` |
| `LOCAL_LIVEKIT_URL_ENTRY`          | Cloud       | `example/livekit-url`                                                                                                         |
| `LOCAL_LIVEKIT_API_KEY_ENTRY`      | Cloud       | `example/livekit-api-key`                                                                                                     |
| `LOCAL_LIVEKIT_API_SECRET_ENTRY`   | Cloud       | `example/livekit-api-secret`                                                                                                  |
| `LOCAL_OWNER_ID`                   | full        | `telegram:123456789`; synthetic `telegram:1` for fast and proof; saved with run state                                         |
| `LOCAL_TEST_AGENT`                 | full, proof | `local-test-agent`, an approved test agent identifier                                                                         |
| `LOCAL_ANTHROPIC_SECRET_ID`        | full, proof | `secret-id-example`, the gateway's approved Anthropic secret id                                                               |
| `LOCAL_ONECLI_URL`                 | full        | `https://onecli.example.com`                                                                                                  |
| `LOCAL_TEST_BOT_TOKEN_ENTRY`       | full        | `example/test-bot-token`                                                                                                      |
| `LOCAL_AGENT_PROVIDER`             | -           | `stand-in` for fast; the installed default for full                                                                           |
| `LOCAL_JEV_URL`, `LOCAL_JEV_MODEL` | -           | `https://openrouter.ai/api/v1/systemone`, `jev-1.14`                                                                          |
| `LOCAL_VOICE_MODE_WAKE_PHRASE`     | plain calls | `Hey Agent`; unset leaves the worker default                                                                                  |
| `LOCAL_VOICE_MODE_VOCABULARY`      | -           | `Agent,Assistant`; unset leaves the worker default                                                                            |
| `LOCAL_VOICE_MODE_<key>`           | -           | Overrides `WAKE_THRESHOLD`, `WAKE_HOP_MS`, `SILENCE_MS`, call limits and spoken length                                        |
| `LOCAL_PORT_BASE`                  | -           | 4100; reserves ten consecutive ports                                                                                          |
| `LOCAL_RUN_DIR`                    | -           | `.local/runs/<UTC timestamp>`; result JSON and filtered logs                                                                  |

Secret values go directly into a mode-0600 local environment file; inherited
channel credentials are excluded.

Ports from the base: host +0, mailbox +1, LiveKit +2/+3/+4, local gateway +5,
Caddy +6 (on 127.0.0.1 and ::1), delay relay +7, Traefik +8, worker health +9.
The chain uses Caddy 2.11.9 with caddy-l4 0.1.3 and Traefik 3.6.14 (checked
against its release SHA-256), PROXY v2 and 27 ms delay in each direction. The
local configs reproduce the voice route with loopback addresses and a local
CA; they are not the complete production configs. `status` prints the CA path
for Simulator trust and the token-free voice URL. The CA lasts 30 days and is
renewed once it would expire within 7; trust the new CA in the Simulator again
after a renewal.

Run logs keep only fixed lifecycle event names, never raw output, because
runtime logs can hold caller text and call links. A supervised process that
exits with an error on its own also leaves its last 20 stderr lines in its log,
which can contain message text.

## Behavior checks and cleanup

`python3 -B scripts/local/turns.py` sends stand-in commands through the CLI.
Reply, multi and long have host-delivery checks. Question, file and edit are
recorded as skips because the CLI cannot prove those adapter effects.
`python3 -B scripts/local/full.py` sends a real model probe and checks mailbox
and test-bot readiness. It does not send a Telegram message. Both exit non-zero
when a check fails. The owner's DM uses the full `telegram:<id>` platform id,
matching the adapter's private-chat routing.

The stand-in answers `reply`, `markdown`, `multi`, `file`, `edit`,
`question [seconds]` (an answerable card, 300 s by default) and
`long [seconds]` (a visible tool call, 20 s by default); it echoes anything
else.

`python3 -B scripts/local/call.py <ios-checkout> plain` (or `jev`) creates a
local voice line and passes it privately to that checkout's `just sim-e2e`.
Start with the chain enabled. A plain call opens with the configured wake
phrase. It makes one automated call per invocation. Run these checks
explicitly; startup sends no probe messages or calls.

The stand-in requires `NANOCLAW_LOCAL_STAND_IN=1` in both the host process and
runner, and neither side registers it without that opt-in. Fast supplies it.
Selecting the provider in group config alone fails closed; never opt a
production host in.

`down` stops owned processes, removes this checkout's agent containers, and
removes `.env`, `data/`, `store/`, the test group directory and the full lock.
It retains `.local/` evidence, CA, binaries, wake-model cache, the built image,
dependencies and build output. It does not delete the remote standing test
agent or remove the CA from the Simulator. `report` writes a Markdown
checklist with failures first, preserving skips.
