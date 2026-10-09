---
name: add-voice-mode
description: Add voice calls with a real NanoClaw agent through LiveKit and Gemini. Installs the voice-mode host adapter, browser page, worker, hashed call lines and role-based /voice commands. Use when an operator wants to talk to an agent by voice.
---

# Add voice mode

A private browser link calls the agent in one of its chats. Speech becomes a
normal agent message; the real agent's reply is spoken in full. The worker
uses [LiveKit](https://docs.livekit.io/) for audio and
[Gemini](https://ai.google.dev/gemini-api/docs/live) for transcription and speech.
The host and worker run outside the agent container. No separate voice model
stands in for the agent.

This distribution targets the public NanoClaw fork with its host command,
prewarm, delivery and legacy-line foundations. Use the fork's
[main branch](https://github.com/tenequm/nanoclaw/tree/main).
Do not copy it into an unrelated upstream checkout: its core boundaries differ.
The build below checks those dependencies. Applying this skill never merges,
deploys a server, or changes an existing call-link token.

Calls have automatic and manual review modes. Automatic mode starts with the
wake gate on: say the configured acoustic phrase, or `hey <agent>` when the
model is off, then a spoken send word. The page can turn wake off so pauses
send. Manual mode lets the caller read and send or discard a draft. The caller
is not transcribed while the agent speaks. Follow-up turns while it works,
live captions, cues, reconnect grace and agent prewarm are included.

You need a reachable LiveKit server or Cloud project, its API key and secret,
a Gemini key for the configured models, and an HTTPS origin for the page.
Use a reverse proxy or Tailscale Serve; the microphone works only on HTTPS
or localhost. Self-hosted LiveKit must expose signaling and its configured
UDP/TURN transports; proxying the page alone does not make media reachable.
Follow the [LiveKit deployment guide](https://docs.livekit.io/home/self-hosting/deployment/).

## Apply

### 1. Copy the implementation and tests

Use `git fetch origin main`, with `origin` pointing at the fork above. For
every path in the following list, create its parent directory and copy with
`git show origin/main:<path> > <path>`.
Stop on any failed fetch or copy; never leave empty source files. Reapplying
these files is safe. Preserve agent vocabulary and local configuration.

```nc:copy from-branch:main
src/channels/voice-mode-adapter.test.ts
src/channels/voice-mode-call-session.test.ts
src/channels/voice-mode-command.test.ts
src/channels/voice-mode-command.ts
src/channels/voice-mode-line-roles.test.ts
src/channels/voice-mode-line.test.ts
src/channels/voice-mode-line.ts
src/channels/voice-mode-livekit.test.ts
src/channels/voice-mode-livekit.ts
src/channels/voice-mode-page.test.ts
src/channels/voice-mode-page.ts
src/channels/voice-mode-protocol.ts
src/channels/voice-mode-registration.test.ts
src/channels/voice-mode-review-page.test.ts
src/channels/voice-mode-route.test.ts
src/channels/voice-mode-route.ts
src/channels/voice-mode-tts-catalog.test.ts
src/channels/voice-mode-tts-catalog.ts
src/channels/voice-mode-tts.fixtures.json
src/channels/voice-mode.ts
src/voice-mode-gemini-live.test.ts
src/voice-mode-gemini-live.ts
src/voice-mode-jev-turn.test.ts
src/voice-mode-jev-turn.ts
src/voice-mode-tts.test.ts
src/voice-mode-tts.ts
src/voice-mode-wakeword.test.ts
src/voice-mode-wakeword.ts
src/voice-mode-worker.test.ts
src/voice-mode-worker.ts
src/db/voice-mode-lines.ts
assets/voice-mode-wakeword/LICENSE
assets/voice-mode-wakeword/NOTICE
assets/voice-mode-wakeword/embedding_model.onnx
assets/voice-mode-wakeword/hey_livekit.onnx
assets/voice-mode-wakeword/melspectrogram.onnx
src/voice-mode-wakeword-fixtures/negative.wav
src/voice-mode-wakeword-fixtures/positive.wav
```

The `voice_mode_lines` table registers its own named migration through core.
Saved links from before the voice-mode rename keep their `voice_lines` and
`voice_line_owners` rows.

Append `import './voice-mode.js';` to `src/channels/index.ts` once:

```nc:append to:src/channels/index.ts
import './voice-mode.js';
```

This fork exports the router's `deliverToAgent`, supports `onStored` and
host-addressed events, expedited reply delivery and the `voice-call` wake.
The native Telegram command delegates to the adapter's command handler.
The registration, router and native command tests guard these connections.

Copy resident agent guidance separately so an implementation repair can
preserve customized prose:

```nc:copy from-branch:main
container/skills/voice-mode-formatting/instructions.md
```

An explicit group skill list must include `voice-mode-formatting`.
The host composes the instructions into the project document only for agents
that take calls (a voice-mode line, or a wired legacy `voice` chat); a listed
skill on any other agent composes nothing. A first line for a running agent
reaches its instructions on the next spawn.

### 2. Install dependencies and build

The fork pins these dependencies. If applying to a compatible checkout that
lacks them, install the exact versions. Do not bypass its package release-age
or approved build-script policies.

```nc:dep
@livekit/agents@1.9.1
@livekit/agents-plugin-elevenlabs@1.9.1
@livekit/agents-plugin-google@1.9.1
@livekit/agents-plugin-silero@1.9.1
@livekit/rtc-node@1.1.0
livekit-server-sdk@2.19.1
onnxruntime-node@1.24.3
zod@4.6.5
```

Silero and the acoustic wake models use the packaged ONNX CPU runtime. The
bundled models' license and attribution travel with their assets. A custom
acoustic model stays operator-owned and must not be committed.

Build the host and run all voice integration tests:

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/channels/voice-mode*.test.ts src/voice-mode*.test.ts
```

The page is already generated. To change it, run `pnpm build` in
`.claude/skills/add-voice-mode/ui`; the emitter writes
`src/channels/voice-mode-page.ts`. Never edit that bundle by hand. Its
source-hash test must pass.

## Connect

Ask for the LiveKit signaling URL, API key and secret, the Gemini key, and
whether to offer ElevenLabs voices too (its key is optional). Reuse existing
values; secret values go directly into `.env`, never into logs, agent messages
or a report. Do not export the whole file to worker children.

```nc:prompt livekit_url validate:^wss?://\S+$ normalize:trim
What is the LiveKit signaling URL reachable by the caller?
```

```nc:prompt livekit_api_key validate:^\S{3,}$ normalize:trim
What is the LiveKit API key?
```

```nc:prompt livekit_api_secret secret validate:^\S{16,}$ normalize:trim
Supply the LiveKit API secret.
```

```nc:prompt gemini_api_key secret validate:^\S{20,}$ normalize:trim
Supply a Gemini API key with transcription and speech access.
```

```nc:prompt elevenlabs validate:^(yes|no)$ normalize:lower
Offer ElevenLabs voices to the lines as well? Answer yes or no.
```

```nc:prompt elevenlabs_api_key secret validate:^\S{20,}$ normalize:trim when:elevenlabs=yes
Supply an ElevenLabs API key with text-to-speech and voices read access.
```

```nc:env-set
LIVEKIT_URL={{livekit_url}}
LIVEKIT_API_KEY={{livekit_api_key}}
LIVEKIT_API_SECRET={{livekit_api_secret}}
VOICE_MODE_GEMINI_API_KEY={{gemini_api_key}}
```

```nc:env-set when:elevenlabs=yes
VOICE_MODE_ELEVENLABS_API_KEY={{elevenlabs_api_key}}
```

An existing `GEMINI_API_KEY` is still read as `VOICE_MODE_GEMINI_API_KEY`, with
a warning; rename it when convenient.

The page listens on `127.0.0.1:3100` (`VOICE_MODE_PORT`, and
`VOICE_MODE_PAGE_HOST` for another bind address), and also under `/voice` on
the existing host webhook port. `VOICE_MODE_PORT=off` (or `0`) turns the
separate listener off when the front already forwards `/voice` to the webhook
port. When the default port is taken, the host logs it and serves the page on
the webhook port only; when an explicit `VOICE_MODE_PORT` cannot bind, setup
fails and neither voice-mode nor the `voice` compatibility adapter starts.
A container proxy that cannot reach loopback needs the listener bound
to an address it can reach, plus the trusted-proxy settings below. Worker
routes live only on the host port under `/webhook/voice-mode/livekit/agent/`;
never proxy them: a worker request with `X-Forwarded-For` or `Forwarded` is
refused. The old `/webhook/voice/livekit` browser links remain valid on the
host port; worker routes are not served under that prefix.

For Tailscale Serve, mount only the page prefix and repeat it in the target
because Serve strips the mount prefix:

```bash
tailscale serve --bg --set-path=/voice http://127.0.0.1:3100/voice
```

For a local test use `http://localhost:3100`. For a remote caller, choose the
HTTPS origin of that front, without a path:

```nc:prompt public_url validate:^https?://\S+$ normalize:rstrip-slash
What HTTPS origin reaches the page server? Use http://localhost:3100 for a local test.
```

```nc:env-set
VOICE_MODE_PUBLIC_URL={{public_url}}
```

A container reverse proxy must be explicitly trusted. Use its own `/32` or
the narrowest required subnet in `VOICE_MODE_TRUSTED_PROXY_CIDRS`, and the
permitted caller ranges in `VOICE_MODE_ALLOWED_CLIENT_CIDRS`. Forward the
real caller in `X-Forwarded-For`. The host uses the rightmost untrusted hop;
a caller cannot prepend an allowed address. Invalid CIDRs match nothing.
A listed loopback proxy is held to the caller allowlist too. Without a
caller allowlist, a trusted proxy may forward any client. Loopback peers
remain admitted unless explicitly trusted with caller restrictions.
`VOICE_MODE_ALLOW_NON_LOOPBACK=1` disables the peer gate for local development.
Worker routes always require the `/webhook/voice-mode/` prefix, a per-call
secret and no forwarding header, and otherwise loopback.

## Start the host and worker, then create a line

Restart the host after configuration. Start the worker from the checkout:

```nc:run effect:restart
bash setup/lib/restart.sh
```

```bash
pnpm run voice-mode-worker
```

Host and worker must be the same build. Both read `.env` when they start (the
worker in each job process): restart the host and worker after changing
settings. For a persistent Linux worker, create
`~/.config/systemd/user/nanoclaw-voice-mode-worker.service` with the checkout's
actual absolute path in `WorkingDirectory` and the installed Node in
`ExecStart`:

```ini
[Unit]
Description=NanoClaw voice mode worker
After=network-online.target

[Service]
WorkingDirectory=%h/nanoclaw
ExecStart=/usr/bin/env node dist/voice-mode-worker.js start
Restart=on-failure
TimeoutStopSec=90

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload` and
`systemctl --user enable --now nanoclaw-voice-mode-worker.service`.
Use the install's own host service name, discovered through
`setup/lib/install-slug.sh`. On macOS a worker LaunchAgent should use the
absolute Node path and checkout working directory, with label
`com.nanoclaw-voice-mode-worker`; do not use `EnvironmentVariables` to copy
secrets. Both processes read their settings directly from `.env`.
A worker started in a terminal stops with Ctrl-C.

Run `/voice` in an existing chat wired to the agent, as a known owner or
scoped/global admin. Slack callers type `!voice`. First use creates a line
and sends its secret link once. In a group the link goes to the sender's DM;
if that DM cannot be resolved, nothing is minted. Later `/voice` moves the
call chat and keeps the link. Only the line's caller moves its call chat.
`/voice new` re-mints it for an authorized sender and ends the old call.
Lost links cannot be read back: only their SHA-256 is stored. Do not paste
links into shared chats, agent messages or logs.

Calls use the caller's core role, checked at start, every turn, every five
seconds and before replies. A revoked role or changed token ends the call.
The current call chat must stay wired to the line's agent. When it disappears,
`VOICE_MODE_MIRROR` picks an unambiguous fallback chat. A line `/voice` made
with no usable chat is refused at call start, and a running call on it ends,
until `/voice` runs in a chat with the agent. A legacy membership-based
`voice` line can also talk on the line itself: a `voice` compatibility adapter
hands its replies and typing to the voice-mode engine.

Verify one real call after both processes start: wake, send, manual draft,
discard, reply, captions, mute, reconnect and hangup. This skill's tests use
fake LiveKit/Gemini boundaries and cannot prove the microphone or media route.

## Settings and behavior

| Setting | Default | Meaning |
| --- | --- | --- |
| `VOICE_MODE_PORT` | `3100` | Separate page server; `off` or `0` disables it. `WEBHOOK_PORT` still serves the page, worker routes and old links. A taken default port is logged and skipped; an explicit port that cannot bind stops voice-mode from starting. |
| `VOICE_MODE_PAGE_HOST` | `127.0.0.1` | Bind address of the separate page server. |
| `VOICE_MODE_MAX_CALL_SECONDS` | `900` | Per-call duration limit. |
| `VOICE_MODE_MAX_CALLS_PER_HOUR` | `12` | Start attempts per line, including failed starts. |
| `VOICE_MODE_MAX_MINUTES_PER_DAY` | `120` | Per-line UTC daily call time. These counters reset when the host restarts. |
| `VOICE_MODE_LANGUAGES` | `uk-UA,en-US` | Up to four language hints, first is primary. Agent language guidance follows them; the worker's own notices start in the first one and use Ukrainian only when it is listed. |
| `VOICE_MODE_STT_MODEL` | `gemini-3.5-transcribe-live` | Own Gemini Live pipeline, one manual activity per caller turn. |
| `VOICE_MODE_STT_FALLBACK_MODEL` | ignored | Deprecated unary fallback; the next turn retries Live. |
| `VOICE_MODE_ELEVENLABS_API_KEY` | empty | Offers ElevenLabs voices to the lines; without it only Gemini speaks. |
| `VOICE_MODE_SILENCE_MS` | `2500` | Closing silence, valid range 300 to 30000 milliseconds. |
| `VOICE_MODE_MIRROR` | `telegram` | Fallback call-chat channel; `off` disables fallback. |
| `VOICE_MODE_VOCABULARY` | empty | Comma-separated names, merged with the agent's `voice.vocabulary.txt`. |
| `VOICE_MODE_MAX_SPOKEN_CHARS` | `0` | No cap; positive values cut speech at a sentence or whole word. |
| `VOICE_MODE_TTS_DEESS`, `VOICE_MODE_TTS_NOTCH` | on | De-essing and fixed whistle notches; `off`, `false` or `0` disables each. |
| `VOICE_MODE_WAKE_MODEL` | bundled `hey_livekit.onnx` | Custom acoustic classifier path, or `off` for transcript wake. |
| `VOICE_MODE_WAKE_PHRASE` | `Hey LiveKit` | Label of the acoustic phrase; it does not train or change the model. |
| `VOICE_MODE_WAKE_THRESHOLD` | `0.68` bundled, `0.5` custom | Acoustic confidence threshold between zero and one. |
| `VOICE_MODE_WAKE_START_SECONDS`, `VOICE_MODE_WAKE_IDLE_SECONDS` | `8`, `20` | How long an addressed turn waits for first or more speech; zero disables each timer. |
| `VOICE_MODE_RECORDINGS_DAYS` | `0` | Optional private caller/reply recordings in `data/voice-recordings`. |
| `VOICE_MODE_WORKER_HEALTH_PORT` | `8089` | Worker health on loopback. |
| `VOICE_MODE_UI` | empty | Page options: skin, colorway, layout, presence, brand, footer, shortcuts, timestamps, colorwayPicker. |

**Voice per line.** Each line speaks with its own saved provider, model and
voice; unset fields take the provider's default (Gemini `gemini-3.8-flash-tts`,
`Alnilam`). A Gemini line falls back to `gemini-3.8-flash-lite-tts` before any
audio; nothing is replayed after partial speech. With the line's link token:
`GET /voice/tts?t=<token>` answers the saved and effective choice and every
provider with its models, defaults and whether its key is set.
`PATCH /voice/tts?t=<token>` with `{"provider":"gemini","voice":"<id>"}`
(`model` optional) or `{"reset":true}` saves it for the line's next calls; it
needs the line's caller to still hold an owner or admin role, and a provider
without its key answers 503. `GET /voice/voices?t=<token>&provider=gemini`
(or `elevenlabs`, with optional `q`, `language`, `cursor` and `limit` up to
100) pages the provider's voices: Gemini's list is cached on the host for an
hour and filtered there, ElevenLabs pages are proxied. A running call keeps its
voice; a client switches it mid-call through the worker's `settings` RPC.
Provider keys never leave the host and worker.

`LIVEKIT_WORKER_URL` selects the worker/API-side LiveKit URL; default is
`LIVEKIT_URL`. `LIVEKIT_HOST_URL` is the worker's loopback host webhook origin;
by default it uses `WEBHOOK_PORT` or port 3000. Only a local plain-http origin
(`localhost`, `127.0.0.1`, `[::1]`) is accepted: the worker exits at start and
ends a call cleanly otherwise, since every request carries call secrets. Point
`LIVEKIT_HOST_URL` directly at the webhook port, never through a proxy.
`LIVEKIT_AGENT_NAME` must match on host and worker; default is
`nanoclaw-voice-mode`.

The vocabulary file is bounded and rejects symlinks/FIFOs. Keep names only:
60 terms and 1024 bytes total, at most 80 characters per term. Its entries
also name the agent for transcript wake. Preserve it across upgrades.

A custom acoustic classifier is used from `VOICE_MODE_WAKE_MODEL` with its
phrase and threshold settings. Without a model, transcript `hey <agent>` opens
the turn, including the agent's alternate names. Acoustic wake sends no idle
audio to Google; transcript wake necessarily transcribes speech before deciding
whether it was addressed. Failure to load an acoustic model falls back to
transcript.

The worker announces command vocabulary version `3` and the actual words.
`zulu`, `прийом`, and a final-confirmed own-sentence `copy`/`copy that` send;
`scratch that`, `discard turn`, `discard this turn` discard. Two matching
interims or a single interim unchanged for 700 milliseconds nominate a command
once speech stops; the final decides it. A missing or collapsed final cannot
confirm `copy`. Other commands use the dropped-command recovery.
The page drives commands and settings for vocabulary `2` and `3` alike (the
same `zulu`/`copy` words); any other value gets no commands and no settings.
A page that accepts only `2` leaves a `3` worker wake-gated until it reloads.
Manual review treats these words as ordinary dictation. Cue and typing sound
switches remain independent settings. Caller speech during agent speech is
reported as unheard. Reconnect grace keeps a same-identity full rejoin alive.

The Jev end-of-turn shadow is optional, off unless `data/jev-turn.json` enables
it. It can only measure, never send or end a turn. No Jev credential, endpoint,
model or service is required for voice installation. See
[optional shadow configuration](../../../docs/jev-turn.md).
Its settings are `JEV_API_KEY`, `JEV_URL` and `JEV_MODEL`.
The daily cap counts one appended byte per judgement in a file per local day,
`data/jev-turn-usage-<YYYY-MM-DD>`, with no lock: concurrent calls can only
under-count, and a judgement that cannot be counted is skipped and logged once
per call as `scope=usage`. Kill switch: `"enabled": false`, or delete
`data/jev-turn.json`.

## Upgrade

Upgrade an existing voice install with the [upgrade runbook](../../../docs/2610-07-voice-mode-upgrade.md).

Remove via [REMOVE.md](REMOVE.md).

## Troubleshooting

- Unknown link: a link is shown only once and cannot be read back; `/voice new`
  replaces it. A saved link works while its token is in `VOICE_MODE_LINK_TOKEN`
  and its `voice` line and membership rows exist.
- Caller denied: a `/voice` line needs its caller to hold a core owner or admin
  role over the agent; a saved line needs its named voice caller, strict wiring
  and group membership.
- No chat to talk in: the page says the line has no chat to talk in. Run
  `/voice` in a chat wired to the agent, or set `VOICE_MODE_MIRROR` to a channel
  with one unambiguous chat for it.
- Updating: reload the page or update the native client to protocol 6. Host and
  worker must match; token requests need `v=6` and older starts get HTTP 426.
- No worker: check the worker unit, LiveKit signaling, host loopback URL and
  matching dispatch name. Its health port is separate from the host's.
- No media: check LiveKit UDP/TURN reachability and browser microphone permission.
- Provider unavailable: a voice route or switch names a provider without its
  `VOICE_MODE_<PROVIDER>_API_KEY`; set it and restart the host and worker.
- Call stops in background: compare Safari with Home Screen web-app behavior;
  native media/background support is outside this browser skill.
- Slow first answer: prewarm needs an existing session; a first-ever chat turn
  still creates one. Idle containers can be reclaimed during a silent call.
- No spoken reply after hangup: the voice line needs an active call. Use the
  agent's ordinary chat for later delivery, files and question cards.
