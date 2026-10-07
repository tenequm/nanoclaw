---
name: add-voice-mode
description: Adds LiveKit and Gemini voice calls with a real NanoClaw agent, a browser page and a separate worker. Use when an operator wants automatic or reviewed voice turns with an agent.
---

# Add voice mode

A private browser link calls the real agent in one of its chats. The worker uses
[LiveKit](https://docs.livekit.io/) for audio and
[Gemini](https://ai.google.dev/gemini-api/docs/live) for transcription and speech.
Replies use the agent's existing memory and tools. The host and worker run
outside its container.

Automatic mode listens for the configured acoustic phrase, then a spoken send
word. Manual review lets the caller inspect, send or discard a draft. Calls
include captions, cues, reconnect grace and container prewarm. Listening pauses
while a reply plays.

Costs include LiveKit transport, Gemini speech and the agent's own model usage.
Default limits are fifteen minutes per call, twelve starts per hour and one
hundred twenty minutes per UTC day per line. Counters reset on host restart.
A call link is a bearer credential for its caller: keep it private.

## Apply

### 1. Copy the payload

Fetch `origin/channels`. For each path below, create its parent and copy with
`git show origin/channels:<path> > <path>`. Stop if fetching or copying fails.
Reapply overwrites implementation files while preserving runtime data and
operator configuration. The payload must be on `channels` before this skill
lands on `main`.

```nc:copy from-branch:channels
src/channels/voice-mode-adapter.test.ts
src/channels/voice-mode-call-session.test.ts
src/channels/voice-mode-command.test.ts
src/channels/voice-mode-command.ts
src/channels/voice-mode-gemini-live.test.ts
src/channels/voice-mode-gemini-live.ts
src/channels/voice-mode-group-persona.ts
src/channels/voice-mode-integration.ts
src/channels/voice-mode-line-roles.test.ts
src/channels/voice-mode-line.ts
src/channels/voice-mode-livekit.test.ts
src/channels/voice-mode-livekit.ts
src/channels/voice-mode-page.test.ts
src/channels/voice-mode-page.ts
src/channels/voice-mode-third-party-notices.txt
src/channels/voice-mode-platform-id.ts
src/channels/voice-mode-protocol.ts
src/channels/voice-mode-registration.test.ts
src/channels/voice-mode-review-page.test.ts
src/channels/voice-mode-route.test.ts
src/channels/voice-mode-route.ts
src/channels/voice-mode-wakeword.test.ts
src/channels/voice-mode-wakeword.ts
src/channels/voice-mode-worker.test.ts
src/channels/voice-mode-worker.ts
src/channels/voice-mode.ts
src/channels/voice-mode-wakeword-fixtures/negative.wav
src/channels/voice-mode-wakeword-fixtures/positive.wav
src/db/voice-mode-lines.ts
scripts/voice-mode-install.ts
scripts/voice-mode-install.test.ts
assets/voice-mode-wakeword/LICENSE
assets/voice-mode-wakeword/NOTICE
assets/voice-mode-wakeword/embedding_model.onnx
assets/voice-mode-wakeword/hey_livekit.onnx
assets/voice-mode-wakeword/melspectrogram.onnx
```

Copy resident agent guidance separately, preserving customized prose during an
implementation repair:

```nc:copy from-branch:channels
container/skills/voice-mode-formatting/instructions.md
```

### 2. Connect to core

Run `pnpm exec tsx scripts/voice-mode-install.ts apply`. It registers the channel,
exports the router's engaged delivery function, calls the stored-turn helper,
adds the outbound presentation helper and connects the browser root route.
Each reach-in has a deletion-sensitive integration test. Line state registers
its own module migration through the channel import.

```nc:run effect:refresh
pnpm exec tsx scripts/voice-mode-install.ts apply
```

### 3. Install exact dependencies and build

Install these pins with pnpm. Preserve the release-age and approved build-script
policies. Acoustic wake inference uses the packaged ONNX CPU runtime.

```nc:dep
@livekit/agents@1.9.1
@livekit/agents-plugin-google@1.9.1
@livekit/agents-plugin-silero@1.9.1
@livekit/rtc-node@1.1.0
livekit-server-sdk@2.19.1
onnxruntime-node@1.24.3
zod@4.6.5
```

Build, then run the voice tests and install/remove tests:

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/channels/voice-mode*.test.ts scripts/voice-mode-install.test.ts
```

The generated page ships with readable third-party notices. Maintainers change
it through the [browser source](ui/package.json): run `pnpm install
--frozen-lockfile --ignore-scripts`, then `pnpm run build` in `ui/`. The generated
source-hash test covers the page and its notices. Asset provenance and the
starting point in glifocat's drafts are in [reference notes](references/2610-07-provenance.md).

### 4. Configure the host and worker

Use a reachable LiveKit server or [Cloud project](https://cloud.livekit.io/),
a Gemini project with access and quota for the configured speech models, and an
HTTPS origin for the page. The microphone works on HTTPS or localhost.
A self-hosted server needs signaling and UDP/TURN reachability; use the
[deployment guide](https://docs.livekit.io/home/self-hosting/deployment/).

Read existing configuration privately. Acquire credentials directly into `.env`
or the operator's credential store; mask prompts, never place values in messages,
reports, command arguments or service definitions. Both processes read `.env`
themselves. Preserve already-set values when reapplying.

```nc:prompt livekit_url validate:^wss?://\S+$ normalize:rstrip-slash
LiveKit signaling URL, e.g. wss://your-project.livekit.cloud
```

```nc:prompt livekit_api_key secret validate:^\S{6,}$ normalize:trim
LiveKit API key
```

```nc:prompt livekit_api_secret secret validate:^\S{16,}$ normalize:trim
LiveKit API secret
```

```nc:prompt gemini_api_key secret validate:^\S{20,}$ normalize:trim
Gemini API key from https://aistudio.google.com/apikey
```

```nc:prompt public_url validate:^https?://\S+$ normalize:rstrip-slash
Browser page origin, e.g. http://localhost:3100 or https://voice.example.com
```

Write the collected values to `.env`, set-if-absent:

```nc:env-set
LIVEKIT_URL={{livekit_url}}
LIVEKIT_API_KEY={{livekit_api_key}}
LIVEKIT_API_SECRET={{livekit_api_secret}}
GEMINI_API_KEY={{gemini_api_key}}
VOICE_MODE_PUBLIC_URL={{public_url}}
```

The page listener defaults to loopback port `3100`. Route `/voice` and its child
paths through the chosen HTTPS front. A proxy on another address needs its
narrow subnet or address in `VOICE_MODE_TRUSTED_PROXY_CIDRS`. Restrict forwarded
clients with `VOICE_MODE_ALLOWED_CLIENT_CIDRS`; forwarding headers are accepted
only from trusted peers. Keep `/webhook/voice-mode/livekit/agent` on loopback.

### 5. Start and make the first line

Restart the host with `bash setup/lib/restart.sh`. Start the worker from the
same checkout with `pnpm run voice-mode-worker`. Host and worker must use the
same build and protocol version. For a persistent worker, follow the
[install-scoped service procedure](references/2610-07-services.md).

```nc:run effect:restart
bash setup/lib/restart.sh
```

Tell the operator to send `/voice` in a chat wired to the agent (on Slack,
`!voice`). Core owner or admin roles authorize this command. The first run
creates a hashed link and sends it privately. Later runs move calls to that
chat without changing the link; `/voice new` replaces the link and terminates
calls using the retired token. A group-chat link is delivered only by DM.

```nc:operator
Start the voice worker from this checkout. In a chat wired to your agent, send /voice (on Slack, !voice). Open the private link, press Call and allow the microphone. Confirm your transcript reaches that chat and the agent's reply is audible. Use /voice new to replace a lost or leaked link.
```

Resident guidance comes from `voice-mode-formatting`. For an explicit group skill list, run `pnpm exec tsx
scripts/voice-mode-install.ts guidance-add <group-id>`, then `ncl groups restart
--id <group-id>`. This uses core config helpers and preserves other entries.

## Settings and behavior

| Setting | Default | Meaning |
| --- | --- | --- |
| `VOICE_MODE_PORT` | `3100` | Separate page server; `off` or `0` disables it. `WEBHOOK_PORT` still serves the page, worker routes and configured personal links. A taken default port is logged and skipped; an explicit port that cannot bind stops voice-mode from starting. |
| `VOICE_MODE_PAGE_HOST` | `127.0.0.1` | Bind address of the separate page server. |
| `VOICE_MODE_MAX_CALL_SECONDS` | `900` | Per-call duration limit. |
| `VOICE_MODE_MAX_CALLS_PER_HOUR` | `12` | Start attempts per line, including failed starts. |
| `VOICE_MODE_MAX_MINUTES_PER_DAY` | `120` | Per-line UTC daily call time. These counters reset when the host restarts. |
| `VOICE_MODE_LANGUAGES` | `en-US` | Up to four language hints, first is primary. Agent language guidance follows them; the worker's own notices start in the first one and use Ukrainian only when it is listed. |
| `VOICE_MODE_STT_MODEL` | `gemini-3.5-transcribe-live` | Own Gemini Live pipeline, one manual activity per caller turn. |
| `VOICE_MODE_STT_FALLBACK_MODEL` | ignored | Deprecated unary fallback; the next turn retries Live. |
| `VOICE_MODE_TTS_MODEL` | `gemini-3.8-flash-tts` | Reply speech model. |
| `VOICE_MODE_TTS_FALLBACK_MODEL` | `gemini-3.8-flash-lite-tts` | Pre-audio fallback; `off` disables it. No replay after partial speech. |
| `VOICE_MODE_TTS_VOICE` | `Alnilam` | Speech voice. |
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


For removal, follow [REMOVE.md](REMOVE.md). Existing branch users should read
[the protocol upgrade procedure](../../../docs/2610-07-voice-mode-upgrade.md).

## Troubleshooting

If Call is refused, check that the worker is registered with the host's
`LIVEKIT_AGENT_NAME`, both builds report protocol 6, and the line's minting
user still has a core owner/admin role for that agent. Reload a stale page.
The worker health endpoint is loopback-only; inspect it privately.

If a link opens but audio cannot connect, check HTTPS microphone permission,
LiveKit signaling and media/TURN reachability. If transcription or speech
fails, check the configured Gemini model's access and quota; preserve the
pipeline's reported error and turn ID, keeping call links and keys private.
For missing typing audio, check `ffmpeg` on the worker host. For acoustic wake,
check the classifier and bundled frontend/embedding paths and the configured
phrase/threshold; fallback transcription is a separate behavior.
