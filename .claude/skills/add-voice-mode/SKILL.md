---
name: add-voice-mode
description: Add voice mode to a NanoClaw agent - talk to your real agent from a browser. Each spoken turn is transcribed and sent to the agent as a message, and the agent's own reply is spoken back, over a self-hosted LiveKit server with Gemini transcription and speech. Use when the user wants to talk to an agent by voice. Browser client only today.
---

# Add voice mode

Voice mode: talk to your real agent. Adds browser voice calls with your
NanoClaw agent. The caller talks to the real agent, not to a voice model
standing in for it: each spoken turn is transcribed and handed to the agent as
a message, and every reply the agent sends is read out. The call runs over
WebRTC through a self-hosted [LiveKit](https://docs.livekit.io/) server; a
LiveKit Agents worker next to the host cuts the caller's audio into turns,
transcribes them with Gemini and speaks the agent's replies with Gemini TTS.
Native adapter: the host owns the call (admits it, opens its room, dispatches
the worker, checks access, ends it) and routes turns and replies through its
normal inbound and delivery paths. NanoClaw doesn't ship channels in trunk —
this skill copies the adapter, the worker and their tests in from the
`channels` branch.

A **voice line** is one call link, `…/voice?t=<token>`, wired to one agent
group. Inside NanoClaw the line goes by a _line id_, a hash of the token, so
the token itself stays in the link and never reaches the database, the logs or
the agent. This skill sets up one line for a browser. Browser is the only
supported client today; native apps and SIP are future clients, not installed
by this skill.

Before you start you need a LiveKit server the caller's browser can reach (its
URL, an API key and its secret) and a Gemini API key with access to the
transcription and TTS models below. Costs: Gemini bills the transcription and
speech, plus the agent's own model usage. The link token is the only thing
between the internet and those bills — treat the link like a password.

Calls end after 15 minutes, and each line permits at most 12 start attempts in
an hour. Set `VOICE_MAX_CALL_SECONDS` (default `900`) and
`VOICE_MAX_CALLS_PER_HOUR` (default `12`) to positive integers to change these
limits. Attempts include failed starts. Each line may also spend at most 120
call minutes per UTC day (`VOICE_MAX_MINUTES_PER_DAY`): a call is refused once
the day's minutes are gone, and a running call ends when they run out. The
counters are in memory and reset when the host restarts, so this caps a day's
spend per line rather than guaranteeing a budget.

Calls take turns: the caller speaks, a pause ends the turn, the agent answers,
and the answer plays to the end before the caller is heard again. The
transcription is hinted at Ukrainian and English, and the agent is told that a
transcript that looks Russian is Ukrainian misspelled by speech recognition.

The transcription also gets a custom vocabulary of names the caller is likely
to say, so it spells them exactly: `VOICE_VOCABULARY` (comma-separated, in
`.env`) plus the agent's optional `voice.vocabulary.txt` in its group folder
(one term per line, read with a size cap, symlinks and FIFOs refused),
e.g. `VOICE_VOCABULARY=Andy, Енді`. Keep both to names: the agents' names and
their spellings. Every term biases the transcription toward it, and short
jargon terms (tool or host names) get substituted for short spoken words: in
tests `send it` came back as a tool name and `scratch that` as another, so a
command was lost. Both are merged, trimmed and
deduplicated, and capped at 60 terms and 1 KB. `VOICE_VOCABULARY` is read at
startup, the file on every call. The agent maintains the file itself: the
resident `voice-formatting` instructions (step 3) tell it to add names a
transcript misspelled, so read or edit `groups/<folder>/voice.vocabulary.txt` to check
or correct its entries. The file's entries also count as the agent's name in the wake
phrase `hey <agent>` (see spoken commands below), so another script or spelling
of the name belongs there too.

The stable channel identifier and URL prefix are `voice`.

## Apply

### 1. Copy the adapter, the worker and their tests

Fetch the `channels` branch and copy the adapter, the line resolver, the call
page, the LiveKit engine, its worker and their tests into place (overwrite —
the branch is canonical):

```nc:copy from-branch:channels
src/channels/voice.ts
src/channels/voice-line.ts
src/channels/voice-call-page.ts
src/channels/voice-livekit.ts
src/channels/voice-livekit-protocol.ts
src/voice-livekit-worker.ts
src/voice-gemini-live.ts
src/voice-wakeword.ts
assets/voice-wakeword/melspectrogram.onnx
assets/voice-wakeword/embedding_model.onnx
assets/voice-wakeword/hey_livekit.onnx
assets/voice-wakeword/LICENSE
assets/voice-wakeword/NOTICE
src/channels/voice-adapter.test.ts
src/channels/voice-registration.test.ts
src/channels/voice-line.test.ts
src/channels/voice-call-page.test.ts
src/channels/voice-livekit.test.ts
src/channels/voice-call-session.test.ts
src/voice-livekit-worker.test.ts
src/voice-gemini-live.test.ts
src/voice-wakeword.test.ts
src/voice-wakeword-fixtures/positive.wav
src/voice-wakeword-fixtures/negative.wav
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if present).
This one line is the only edit the skill makes to the channel core. The adapter
also relies on core pieces this fork's trunk carries and upstream does not:
host-addressed turns (`agentGroupId` and `onStored` on `InboundEvent`,
`routeInboundEvent`), `expediteDelivery` in `src/delivery.ts`, the `voice-call`
wake reason in `src/request-wake.ts`, and the agent runner's idle start for
that wake. Apply it to this fork's trunk, not to plain upstream:

```nc:append to:src/channels/index.ts
import './voice.js';
```

### 3. Teach agents to write for the ear

Replies on this channel are spoken. The note the host adds under every
transcribed turn carries the format rules (depth matched to the question, plain
prose with no markdown, links or code, numbers as words, Ukrainian never
Russian). What a turn's note cannot carry lives in resident instructions:
messages that answer no turn, no question cards or attachments, where reading
material goes, and the vocabulary file. The host composes
`container/skills/voice-formatting/instructions.md` into every group's
`CLAUDE.md` at spawn, as the section `NanoClaw Skill: voice-formatting` (a group
with an explicit skill list needs `voice-formatting` in it), so the agent has it
before the first call rather than on demand. Copy it separately so reapplying
missing adapter files does not overwrite customized instructions:

```nc:copy from-branch:channels
container/skills/voice-formatting/instructions.md
```

### 4. Build

The channel uses `@livekit/agents` (the worker's job dispatch),
`@livekit/agents-plugin-google` (Gemini speech; the transcription is the worker's
own Gemini Live client), `@livekit/agents-plugin-silero` (Silero VAD on
`onnxruntime-node`, whose npm package ships the CPU binaries for linux-x64 and
macOS; its postinstall only fetches optional CUDA files and pnpm skips it),
`@livekit/rtc-node`, `livekit-server-sdk` and `zod` (a peer of the agents
package). The acoustic wake word runs the three models under `assets/voice-wakeword/`
(from [livekit-wakeword](https://github.com/livekit/livekit-wakeword), Apache-2.0,
see the `NOTICE` there) on the same `onnxruntime-node`, which the worker imports
directly, so it is a direct dependency at Silero's version:

```nc:dep
onnxruntime-node@1.24.3
```

Build first: it guards the adapter's typed calls into the channel
core.

```nc:run effect:build
pnpm run build
```

### 5. Validate

Run the registration test, the request-gate and line-access tests, the call
page check, and the integration tests (a fake LiveKit server behind the real
webhook server, and the worker's turn-taking rules):

```nc:run effect:test
pnpm exec vitest run src/channels/voice-registration.test.ts src/channels/voice-adapter.test.ts src/channels/voice-line.test.ts src/channels/voice-call-page.test.ts src/channels/voice-livekit.test.ts src/channels/voice-call-session.test.ts src/voice-livekit-worker.test.ts src/voice-gemini-live.test.ts src/voice-wakeword.test.ts
```

`voice-registration.test.ts` imports the real channel barrel and asserts the
registry contains `voice` — it goes red if the import line drifts.
`voice-livekit.test.ts` drives the call page and its routes over HTTP, opens a
call against the fake LiveKit server, round-trips a transcribed turn to an
inbound message and an agent reply to the worker's event stream, and covers
the limits, access checks and the call chat. A real call is verified manually
once the service and the worker run.

## Connect

### LiveKit and Gemini

The host and the worker read these from `.env`; the agent container never sees
them. The host only checks the Gemini key is set; the worker uses it.

```nc:prompt livekit_url validate:^wss?://\S+$ normalize:trim
What is the LiveKit signaling URL the caller's browser connects to? (e.g. wss://livekit.example.com)
```

```nc:prompt livekit_api_key validate:^\S{3,}$ normalize:trim
What is the LiveKit API key?
```

```nc:prompt livekit_api_secret secret validate:^\S{16,}$ normalize:trim
Paste the LiveKit API secret for that key.
```

```nc:prompt gemini_api_key secret validate:^\S{20,}$ normalize:trim
Paste a Gemini API key with access to the transcription and TTS models. Create one at https://aistudio.google.com/apikey
```

```nc:env-set
LIVEKIT_URL={{livekit_url}}
LIVEKIT_API_KEY={{livekit_api_key}}
LIVEKIT_API_SECRET={{livekit_api_secret}}
GEMINI_API_KEY={{gemini_api_key}}
```

### Public URL

The call page and its routes are served by the host's webhook server under
`/voice`: the page at `…/voice?t=<token>`, and the routes it calls next to it
(`/voice/info`, `/voice/livekit/token`, `/voice/livekit/end`). The older
`…/webhook/voice/livekit?t=<token>` path keeps working. Give the origin a
caller's browser reaches it at — `http://localhost:3000` for a local try, an
HTTPS name to call from a phone's browser. Browsers allow the microphone only
on `localhost` or HTTPS.

The webhook server listens on every interface, so the voice routes answer only
loopback peers by default (403 otherwise, before any token check): a call link
must not work, or be probed, over plain HTTP from the LAN. Put one of these
fronts in front of it.

**(a) Tailscale Serve.** On a tailnet, `tailscale serve` gives the host an HTTPS
name with a valid certificate and connects from `127.0.0.1`, so nothing else is
needed. Mount `/voice`; the target repeats the path because serve strips the
mount prefix before proxying (run as root or a Tailscale operator; an existing
mount at `/` for another service is unaffected). Keep a `/webhook` mount only
if older `…/webhook/voice/…` links are still in use:

```bash
tailscale serve --bg --set-path=/voice http://127.0.0.1:3000/voice
```

The origin is then `https://<host>.<tailnet>.ts.net`.

**(b) A reverse proxy in a container** (Traefik, Caddy, nginx on a Docker
bridge network). It connects from a container address, not loopback, so tell
the host which proxies to trust and, optionally, which clients they may
forward:

| Key | Default | What |
| --- | --- | --- |
| `VOICE_TRUSTED_PROXY_CIDRS` | empty (loopback only) | Comma-separated CIDRs of the proxy as the host sees it. Use the narrowest range: the proxy's own address (`/32`) or its Docker network's subnet (`docker network inspect <network>`). Any container in a trusted range can claim any client. |
| `VOICE_ALLOWED_CLIENT_CIDRS` | empty (any client the proxy forwards) | Comma-separated CIDRs the forwarded client must be in. The client is the rightmost `X-Forwarded-For` hop outside the trusted proxies, so a client cannot prepend its way in. For a tailnet-only service: `100.64.0.0/10,fd7a:115c:a1e0::/48`. |

A request is admitted if its peer is loopback, or its peer is in
`VOICE_TRUSTED_PROXY_CIDRS` and the forwarded client is in
`VOICE_ALLOWED_CLIENT_CIDRS` (when set). LAN peers outside the trusted ranges
still get 403, and an `X-Forwarded-For` from them is ignored. The worker's
routes (`/webhook/voice/livekit/agent/…`) never pass through the proxy gate:
they stay loopback-only and are not served under `/voice` at all. Invalid
entries are logged and match nothing.

A Traefik example (dynamic file configuration; `voice.example.com`, the
resolver name and the host gateway address are placeholders):

```yaml
http:
  routers:
    nanoclaw-voice:
      rule: Host(`voice.example.com`) && PathPrefix(`/voice`)
      entryPoints: [websecure]
      tls: { certResolver: letsencrypt }
      middlewares: [voice-allowlist]
      service: nanoclaw-voice
  middlewares:
    voice-allowlist:
      ipAllowList:
        sourceRange: ["100.64.0.0/10", "fd7a:115c:a1e0::/48"]
  services:
    nanoclaw-voice:
      loadBalancer:
        servers:
          - url: http://172.18.0.1:3000   # the proxy network's gateway (the Docker host), WEBHOOK_PORT
```

In `.env`, with the proxy network's subnet (or the proxy's `/32`) as the trusted range:

```
VOICE_PUBLIC_URL=https://voice.example.com
VOICE_TRUSTED_PROXY_CIDRS=172.18.0.0/16
VOICE_ALLOWED_CLIENT_CIDRS=100.64.0.0/10,fd7a:115c:a1e0::/48
```

The two allowlists are independent layers: the proxy's middleware refuses
outsiders at the edge, and the host refuses anything that skipped the proxy or
came through it from elsewhere. For a local-development setup that needs no
gate at all, `VOICE_ALLOW_NON_LOOPBACK=1` serves the voice routes to every
peer.

The origin to give below is the front's, with no path. Set-if-absent, so a
re-run keeps your value:

```nc:prompt public_url validate:^https?://\S+$ normalize:rstrip-slash
What origin can a caller's browser reach this NanoClaw host at? (e.g. http://localhost:3000, https://nanoclaw.example.ts.net or https://voice.example.com)
```

```nc:env-set
VOICE_PUBLIC_URL={{public_url}}
```

### Link token

The voice line's secret. Reuse the one already in `.env` on a re-run, otherwise
mint a fresh one:

```nc:run capture:link_token validate:^[0-9a-f]{16}([0-9a-f]{16})?$ effect:fetch
grep -s '^VOICE_LINK_TOKEN=' .env | cut -d= -f2- | cut -d, -f1 | grep -E '^[0-9a-f]{16}([0-9a-f]{16})?$' || openssl rand -hex 16
```

Tokens minted by earlier versions of this skill are 16 hex characters and keep
working; the host logs a warning for them. To upgrade a line, replace its token
with `openssl rand -hex 16` and re-run the wiring steps for the new line id.

```nc:env-set
VOICE_LINK_TOKEN={{link_token}}
```

The line id is what NanoClaw calls this link (`voice:<line id>`): the first
twelve hex characters of the token's SHA-256, derived the same way the adapter
derives it, so the token itself is never written anywhere but `.env`:

```nc:run capture:line_id validate:^[0-9a-f]{12}$ effect:fetch
printf '%s' '{{link_token}}' | node -e "let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>console.log(require('crypto').createHash('sha256').update(d).digest('hex').slice(0,12)))"
```

## Choose the agent

The line is wired to one agent group. List them (the NanoClaw service must be
running — `ncl` talks to it over its socket):

```nc:run capture:agent_groups effect:fetch
ncl groups list --json | jq -r 'if (.data|length)==0 then "no agent groups yet — run /init-first-agent first" else [.data[] | "\(.folder) (\(.name))"] | join(", ") end'
```

```nc:operator
Agent groups on this install: {{agent_groups}}. The voice line is wired to one of them; every turn the caller speaks goes to that agent, and its replies are what the caller hears.
```

```nc:prompt agent_folder validate:^[A-Za-z0-9_-]+$ normalize:trim
Which agent group answers the voice line? Enter its folder name (the first column above).
```

The folder must be a real agent group — a typo must not wire the line to
nothing:

```nc:run effect:check
ncl groups list --json | jq -e --arg f '{{agent_folder}}' '.data[] | select(.folder==$f)' >/dev/null || { echo "unknown agent group folder '{{agent_folder}}' — see: ncl groups list" >&2; exit 1; }
```

## Name the caller

Each link represents one named voice-channel user. Choose the person receiving
this credential. A matching name on another channel does not link accounts or
grant owner/admin privileges. Use a separate link per person and a separate
agent workspace for a shared demo.

```nc:prompt caller_name validate:^[\p{L}\p{M}\p{N}\x20.'’_-]{1,80}$ flags:u normalize:trim
Who receives this personal call link? Enter their name (letters, numbers, spaces, apostrophes, dots, hyphens or underscores).
```

## Restart and wire

Restart the service so the adapter registers its routes and the channel type
is known to `ncl`:

```nc:run effect:restart
bash setup/lib/restart.sh
```

Create the named voice user, grant membership only to the chosen agent, and
create a strict line with a known-sender wiring. Each command is independent;
the validated name allows Unicode and apostrophes while excluding shell syntax:

```nc:run effect:wire
ncl users create --id "voice:{{line_id}}" --kind voice --display-name "{{caller_name}}"
ncl users update --id "voice:{{line_id}}" --display-name "{{caller_name}}"
ncl members add --user "voice:{{line_id}}" --group "$(ncl groups list --json | jq -er --arg f '{{agent_folder}}' '.data[] | select(.folder==$f) | .id')"
ncl messaging-groups list --json | jq -e --arg p "voice:{{line_id}}" '.data[] | select(.platform_id==$p)' >/dev/null || ncl messaging-groups create --channel-type voice --platform-id "voice:{{line_id}}" --name "Personal voice line" --is-group 0 --unknown-sender-policy strict
ncl wirings create --channel-type voice --platform-id "voice:{{line_id}}" --agent-group "{{agent_folder}}" --session-mode shared --sender-scope known
```

The adapter checks the named caller's membership before returning private agent
information or opening a call. Every turn reaches the agent as a message from
that voice user; spoken names and browser fields cannot override that binding.
Access is rechecked every five seconds during a call and before a reply is
spoken; revocation or a changed wiring ends the call.

## Run the worker

The agent side of a call is a separate process, the LiveKit Agents worker:
agents-js runs every job in a forked child process of its worker, so it does
not live in the host. Run it next to the host from the NanoClaw directory (it
reads its settings from that directory's `.env` itself, like the host, so no
secret goes into its environment or its job processes):

```bash
pnpm run voice-worker        # node dist/voice-livekit-worker.js start
```

Host and worker must be from the same build, so restart them together. As a
systemd user unit:

```ini
# ~/.config/systemd/user/nanoclaw-voice-worker.service
[Unit]
Description=NanoClaw LiveKit voice worker
After=network-online.target

[Service]
WorkingDirectory=%h/nanoclaw
ExecStart=/usr/bin/env node dist/voice-livekit-worker.js start
Restart=on-failure
TimeoutStopSec=90

[Install]
WantedBy=default.target
```

No `EnvironmentFile=`: it would put every `.env` secret into the worker's
environment and every forked job, and agents-js lets `LIVEKIT_URL` from the
environment override `LIVEKIT_WORKER_URL`. Set `Environment=LOG_LEVEL=debug`
for verbose logs.

Tell the user where to call from:

```nc:operator
The call link is {{public_url}}/voice?t={{link_token}} — keep it private, anyone holding it is treated as {{caller_name}} and can talk to {{agent_folder}} on your Gemini bill. Start the voice worker (pnpm run voice-worker, or its systemd unit) next to the host, then open the link in a browser, allow the microphone, press Call and say hello. Ask something that needs memory ("what did we decide about the launch date?") and the agent answers it like any message.
```

## Done

Callers talk to the agent itself: each turn they speak is a message to it, and
everything it replies during the call is spoken. To add a second line for
someone else, append another token to `VOICE_LINK_TOKEN` (comma-separated),
derive its line id the same way, and repeat the named-user, membership and
strict wiring steps for `voice:<that line id>`. Restart to load the additional
token.

To uninstall: see [REMOVE.md](REMOVE.md).

## The call page

The page callers open is a small React app. Its maintainer sources live at
`.claude/skills/add-voice-mode/ui/` beside the generated payload (in this fork:
vendored from upstream `feat/voice-payload`, PR #3772, at `324d7445`, with the
LiveKit call in `ui/src/lib/livekit-call.ts`; MIT, see
`ui/THIRD_PARTY_NOTICES.md`): Teenage Engineering inspired, one screen beside a
rail of keys, a dot-matrix display that shows the caller's voice in white,
thinking in orange and the agent's voice in orange, captions that fade in word
by word, and three device finishes. It ships as one self-contained document
inside `src/channels/voice-call-page.ts` (generated, do not edit by hand), so
the host build, the copy list and the routes never change when the look does.
`livekit-client` and `@livekit/components-react` are bundled into it, no CDN.

Change the look without a rebuild with one `.env` key holding a JSON object,
injected into the page when it is served:

```
VOICE_UI={"colorway":"field","presence":"matrix","brand":"Casa line"}
```

| key              | values                                                  | default                                            |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------- |
| `skin`           | `te` (device), `nanoclaw` (card)                        | `te`                                               |
| `colorway`       | `auto` (follows light/dark), `ivory`, `field`, `rabbit` | `auto`                                             |
| `layout`         | `rail` (screen beside keys), `stack`                    | `rail`                                             |
| `presence`       | `matrix`, `bars`                                        | `matrix`                                           |
| `brand`          | header name, up to 60 characters                        | `NanoClaw Voice`                                   |
| `footer`         | footer line; `{agent}` becomes the wired agent's name   | `Voice mode · answers by {agent}`                  |
| `shortcuts`      | print `esc` and `space` on the keys (desktop)           | `true`                                             |
| `timestamps`     | time into the call on each transcript turn              | `true`                                             |
| `colorwayPicker` | let callers pick a finish from the page                 | `true`                                             |

Callers can also switch the finish from the labelled swatches under the
transcript, `auto` among them (back to the device's light or dark setting); the
choice stays in their browser. To change the components themselves, edit
`ui/src`, then from `ui/` run
`pnpm install --frozen-lockfile --ignore-scripts && pnpm build`. The build regenerates
the module and stamps it with a hash of the explicit `source-files.json` inputs;
`src/channels/voice-call-page.test.ts` fails when the two drift, so always
rebuild the module and commit it with the source change, never hand-edit it.
`ui/` is its own pnpm workspace and sits outside the root build, lint, format
and test globs. Ordinary installs copy the generated page
and do not need a frontend build. The UI has the same three-day release-age gate
as the host and requires no dependency install scripts. Try the page without a
microphone or an agent by adding `&demo=1` to any call link: it plays a scripted
call and connects to nothing. `&demo=review` plays a review mode call through
every review state, `&demo=wake` the wake switch and spoken commands,
`&demo=cues` the call's notes (wake heard, the send countdown, speech not heard
under the agent, a reply not spoken, a send word with nothing to send), and
`&step=<n>` stops a script at step n.

## How a call runs

Optional host settings: `LIVEKIT_WORKER_URL` (server-side URL for the worker
and the host's room/dispatch API calls, e.g. `ws://127.0.0.1:7880` when the
server runs on the same box; defaults to `LIVEKIT_URL`), `LIVEKIT_AGENT_NAME`
(dispatch name, default `nanoclaw-voice`; set the same value for host and
worker), `LIVEKIT_HOST_URL` (worker only: where it reaches this host's webhook
server, default `http://127.0.0.1:<WEBHOOK_PORT>`; it must be a loopback
address unless `VOICE_ALLOW_NON_LOOPBACK=1`, like the worker's routes on the
host, which no trusted proxy opens; the worker never takes an address from the
dispatch). The transcription and speech settings, read by the host and handed
to the worker with each call:

| Key | Default | What |
| --- | --- | --- |
| `VOICE_STT_MODEL` | `gemini-3.5-transcribe-live` | Transcribes each caller turn over the Gemini Live API as it is spoken, as one manual activity (below), verbatim, with the language hints `uk-UA` and `en-US`, and the line's vocabulary plus the spoken commands as custom vocabulary. |
| `VOICE_STT_FALLBACK_MODEL` | - | Deprecated and ignored: there is no unary fallback any more, and a call whose host still sends one logs that once. While the Live API fails, a turn with no text is lost (the caller hears "Sorry, I didn't catch that") and the next turn tries again. |
| `VOICE_TTS_MODEL` | `gemini-3.8-flash-tts` | Speaks the agent's replies. |
| `VOICE_TTS_FALLBACK_MODEL` | `gemini-3.8-flash-lite-tts` | Speaks when the main model fails before any audio of a line (a transient error is tried once more first); the main model is skipped for 30 seconds, then tried again on the next line. A failure after a line's audio started ends that line, never repeats it. `off` for none. |
| `VOICE_TTS_VOICE` | `Alnilam` | Prebuilt Gemini voice, for both TTS models. |
| `VOICE_SILENCE_MS` | `2500` | Silence that ends the caller's turn (300 to 30000); shorter pauses mid-thought keep it open. |
| `VOICE_MIRROR` | `telegram` | Channel type of the default call chat, used until `/voice` picks one (see below); `off` keeps calls on the voice line until then. |

The worker itself reads `VOICE_MAX_SPOKEN_CHARS` (default `0`: no cap, every
message is spoken in full). Set it to a positive number of characters to cap
speech: an agent message longer than that, after markdown and links are stripped,
is spoken up to its last sentence end within the cap when that end is past 60%
of the cap (else up to its last whole word), followed by "Решта - у чаті." or
"The rest is in the chat." in the language of the caller's last turn. A call
that talks on the voice line, with no chat to hold the rest, closes with
"Скорочую." or "I've cut it short." instead. It applies to every message
spoken during the call, replies and proactive ones alike, and the captions show
what was spoken; the full text stays in the chat.

It also reads `VOICE_WAKE_MODEL`, `VOICE_WAKE_THRESHOLD` and `VOICE_WAKE_PHRASE`, for
the wake switch (see spoken commands below). `VOICE_WAKE_MODEL` is a wake word
classifier `.onnx` in livekit-wakeword's format, a path (default: the bundled
`assets/voice-wakeword/hey_livekit.onnx`; `off` for none, and `hey <agent>` in the
transcript opens a turn). `VOICE_WAKE_PHRASE` is what that model listens for, as the
page shows it: `Hey LiveKit` by default,
for the bundled model; set it whenever `VOICE_WAKE_MODEL` names your own classifier
(`VOICE_WAKE_PHRASE="Hey Jarvis"`). It is shown as written, and the host reads it too,
so the page names it before the call. It does not change what the model hears. openWakeWord's
classifiers load too, but their pretrained models are CC BY-NC-SA 4.0
(non-commercial): fine for your own install, never to be committed or shipped. `VOICE_WAKE_THRESHOLD` is the
score (0 to 1) that counts as the wake word: by default 0.68, livekit-wakeword's
documented operating point for `hey_livekit`, and 0.5 for another model.
`VOICE_WAKE_START_SECONDS` (default 8) and `VOICE_WAKE_IDLE_SECONDS` (default 20)
are how long a turn the wake phrase opened waits for speech, right after the phrase
and then after the last words, before it goes back to waiting (`0`: never).

It also reads `VOICE_RECORDINGS_DAYS` (default `0`, off): with a
number of days, it saves every caller turn it hears as a 16 kHz mono WAV plus a
JSON sidecar (call and line id, agent, turn number, start and end, speech
length, the transcription model that heard it, the transcript or why there was
none, and the host's answer) under
`data/voice-recordings/<agent>/<YYYY-MM-DD>/<call id>-<turn>.wav|.json`, owner-only
(files 0600, folders 0700), and deletes files older than that many days at
start and once a day. The recordings are the caller's voice: they stay on this
machine under `data/` (which git ignores), nothing uploads or backs them up, and
anyone who can read the NanoClaw folder as its user can play them.

Restart the host to load them. Calls end at `VOICE_MAX_CALL_SECONDS`
(default 15 minutes) or when the day's minutes run out, whichever comes first.

The worker's health check listens on `127.0.0.1:8089` (`VOICE_WORKER_HEALTH_PORT`
in `.env`). At startup it logs its protocol version and the host URL it uses
(set `LIVEKIT_HOST_URL` in `.env` if that is not this NanoClaw's webhook
server; a call the host does not answer ends at once with the URL in the log).
Each idle job process loads the Silero models before a call reaches it. On
SIGTERM it takes no new calls and gives running ones 60 seconds before closing
them, so a restart cuts a longer call short. The job metadata is versioned
(`v: 4`). A worker that gets a call of another version joins only to set its
`nanoclaw.voice.updating` attribute, so the caller's page says "The voice service
is updating. Try again in a minute.", and leaves; the page says the same when
no worker joins within 25 seconds (worker down, or an older one that turns such
calls away), and the host logs why the call ended.

The page posts to `/voice/livekit/token`; the host admits the call against the
hourly and daily limits, ends any other call on the line (newest wins),
creates a unique room `voice-<line id>-<random>`, dispatches the worker to it
with the call metadata (line, call id, agent and caller names, vocabulary, the
transcription and speech settings; nothing secret, since agents-js logs whole
jobs on some paths) and returns a two-minute token that can only join that
room, publish a microphone and subscribe. The worker waits for the caller,
tells the host (the daily minutes are charged from here until the room ends)
and publishes the agent's audio track. The worker
authenticates to the host with a per-call secret both derive from
`LIVEKIT_API_SECRET`, so the worker needs that key too. The worker runs the call
itself (LiveKit Agents only dispatches the job): it reads the caller's microphone at
16 kHz, publishes the agent's speech, the captions (`lk.transcription`) and the agent
state (`lk.agent.state`), and keeps the turns in one state machine. Then:

- Silero VAD follows the caller's speech (VAD-only turn detection: LiveKit's
  turn detector models have no Ukrainian). A turn opens at the caller's speech and
  survives pauses; it ends after `VOICE_SILENCE_MS` of silence counted from the end
  of their speech (Silero reports an end 550 ms into the silence, so that is the
  shortest a turn can close in).
- A turn is one Gemini Live activity on a socket of its own (manual activity:
  `activityStart` with 500 ms of audio from before the speech, the caller's audio,
  `activityEnd`), so a turn with thinking pauses is transcribed as one piece, never
  as segments cut at the model's own pauses. The page shows the text as it comes.
  The turn's text is the final transcript, or the last interim text when the final
  collapsed to its last short phrase (3 words or fewer while the interim had more)
  or never came within 3 seconds. Nothing is sent to Google outside a turn. The worker posts the turn's
  text to `/webhook/voice/livekit/agent/utterance`, and the host hands it to the
  agent in the line's call chat (below) as `<voice source="livekit">…</voice>`
  plus a line saying the reply is read aloud (depth matched to the question:
  brief for simple ones, a full considered answer in plain speech for design,
  strategy or anything that needs care; no markdown, links or code, numbers as
  words; anything meant for reading as a separate written message; in a call
  chat, that every message sent to the chat during the call is read aloud, so
  anything meant for reading waits for the end of the call).
  Its id is `livekit:<call>:<n>`.
- Every agent message to the call chat during the call (replies and proactive
  messages; with no call chat, every agent message for the line) goes to the
  worker complete over the host's event stream, and the agent's typing there is
  the worker's "thinking". The worker strips markdown, URLs and tags and speaks
  it uninterruptibly, in full unless `VOICE_MAX_SPOKEN_CHARS` (above) caps it,
  synthesized whole in one streamed TTS request (so a very long message waits
  longer for its first audio). Its caption shows as its audio starts.
  Replies never overlap, and a reply waits for a caller who is mid-turn (at most
  `VOICE_SILENCE_MS` plus ten seconds, then it takes the channel).
- While the agent's audio plays, the caller is not transcribed (no barge-in).
  While the agent works the page says it is thinking; the caller can keep
  talking, and each finished turn goes to the agent as a follow-up.
- The host answers a turn 202 once the agent's session has stored it, whether
  to answer or, on a voice line whose trigger it does not match under the
  `accumulate` policy, as context. When nothing stored it (access or sender
  policy, no agent taking it) the host answers 422, when routing throws 500,
  and when the turn is not stored within 8 seconds 504. Each POST carries a
  random `turnKey`; the worker posts a turn once more under the same key when
  the connection drops, and the host answers a repeated key from the first
  outcome without routing it again. A turn answered 504 that is stored later
  is reported on the event stream (`{"type": "turn-stored", "turnKey", "id"}`),
  and the worker corrects the page's mark to "sent". The stream also carries
  `{"type": "chat", "chat": true | false}` when the call starts or stops
  talking in a chat, and `{"type": "working"}` on the agent's typing ticks once
  its runner reports a live `working` turn stamped after the latest message
  reached its chat (the call chat, or the voice line itself): the agent has
  picked it up. The first such report goes out at once, not on the next 4 s
  refresh.
- When the caller's speech came out as no text the caller hears "Не розчув,
  повтори, будь ласка" or "Sorry, I didn't catch that", in the language of their
  last turn. A turn the host did not confirm (504, or no answer) may still reach
  the agent, so it is never "repeat": "Не впевнений, що це дійшло - перевір чат."
  or "Not sure that got through - check the chat." (without the chat part on a
  voice-line call). A refused turn gets "That didn't go through.", a rate-limited
  one "Too many turns - give it a moment." (and their Ukrainian lines). When a
  reply cannot be synthesized, a line saying so. All of these also show as captions. The
  worker also sends JSON messages per caller turn (noise is not reported) on the text stream topic
  `nanoclaw.voice.turn`: `{"turn": n, "status": "sending" | "sent" | "working" | "lost", "reason"?:
  "stt" | "empty" | "rejected" | "rate_limited" | "timeout", "text"?: …}`.
  Every turn handed to the host first gets "sending", once the closing silence
  and the final transcript are in and before the host answers (a turn lost to
  the transcription gets none); "sent" means the agent's session has the turn; a
  504 is "timeout", 429 "rate_limited", any other refusal "rejected".
  "working" follows "sent" at most once per turn, on the first host `working`
  after the host took that turn, unless a reply to it came first. When the agent
  is still busy with an earlier turn, its runner's next re-mark (every 5 s) can
  stand in for the pickup, so "working" there means "working, with your turn in
  hand", not "on your turn". The call page takes no action on it.
- Right before each line it speaks, the worker sends one JSON message on
  `nanoclaw.voice.reply`: `{"reply": n, "turn"?: n, "part"?: k, "unprompted"?:
  true, "notice"?: true, "more"?: true}`. `turn` is the caller turn the agent
  message answers (from the host event's `turn`, the utterance id the 202 named;
  a turn the worker cannot map gets no label), `unprompted` a message answering
  no turn of this call, `notice` the worker's own lost-turn or failure line, and
  `more` that another line is already queued behind it.
- While a finished stretch of caller speech waits out `VOICE_SILENCE_MS`, the
  worker sets the attribute `nanoclaw.voice.pending` to
  `"<n>:<elapsedMs>:<silenceMs>"` and clears it when the caller speaks again,
  the turn is sent, dropped or overdue, or the agent speaks.

Turns are capped at 8 KB of text, 20 a minute and 3 still being routed per call. A reply for a call
that already ended is not spoken. If the worker does not open its event stream
within 30 seconds of the caller joining, the host ends the call. The host
rechecks access every five seconds and ends a call (hangup, revocation,
duration or budget limit, a newer call, shutdown) by deleting the room, which
disconnects caller and worker.

**The call chat and `/voice`.** A call talks in one of the agent's chats, so
the agent answers with that chat's context and the chat shows both sides. A
line's caller is its own `voice:<line id>` user, linked to no other account, so
the operator first names the line's owner, the person's user on a chat
platform, and then adds the same person's other chat accounts, so `/voice`
(Telegram) and `!voice` (Slack) both work for the line (`ncl users list` shows
the ids; operator only, from the host):

```bash
ncl voice-lines set --line voice:<line id> --owner telegram:<their id>
ncl voice-lines add-owner --line voice:<line id> --owner slack:<their id>
ncl voice-lines get voice:<line id>   # owners and the current call chat
```

`remove-owner --line ... --owner ...` drops one account (never the last;
`remove --line ...` drops the line's owners and call chat). The owner accounts are one
person: `set` makes its `--owner` the only one and, when that account did not
own the line yet, clears the call chat, which is how a line changes hands.

The owner then sends `/voice` from any of those accounts in a chat wired to the
agent (that account must be an owner or admin of the agent too; on Slack
`!voice`): the host replies there with the call links of their own line(s) of
that agent, never anyone else's (`Voice call with <agent>: …/voice?t=…`), and
makes that chat (and its thread or forum topic; on Slack a top-level `!voice`
means the channel itself) the line's call chat until `/voice` from any of the
line's owner accounts names another chat of the same agent (the last one wins).
Someone who owns no line of the agent is told so, and nothing changes. The
links never change and the page works without the command; `/voice` only says
where calls talk. In a chat with several agents it does this for every agent
there the sender administers. The reply goes out with link previews off
(Telegram) and unfurls off (Slack), and a reply quoting it does not pass the
links to the agent. The call chat is stored per line in `voice_lines` and the
owner accounts in `voice_line_owners` (migration 027, applied at host start); a
new owner starts with no call chat.

During a call each turn is routed into the call chat's session through the
normal inbound path, as a message from the line's own caller. It is addressed to
the line's agent alone, whoever else is wired there, and engages it whatever
the chat's trigger; session mode, access and sender policy apply as for a typed
message. Once the agent's session has a turn, the bot posts `🎙 <transcript>`
into the chat (the turn itself still comes from the caller, by name). The agent answers
in the chat as usual; while the call is live, each message it delivers to that
chat (and thread) is also spoken, and its typing there shows as thinking. The
chat's copy of a message picked for speech starts with `🔊 `: only what the
platform shows, never the stored message, the agent's context or the spoken text.
It marks a message the live call was given to speak, not proof it was heard (the
worker still reports a reply it could not speak). A reply to a turn of an
earlier call is neither marked nor spoken on a later one. After
a mid-call `/voice` the call also keeps speaking the chat it left, until a whole
turn passes with no message or typing from the agent there. A `/voice` chat that
is no longer wired to the agent, or none of whose owner accounts is still an
admin of it, is ignored (the host logs it).

Before any `/voice` the default is the `VOICE_MIRROR` rule: the one live (not
denied, not detached) chat of that channel type wired to the agent, or the one
direct chat among several, with the line's own caller as the sender. That chat
then converses: the caller's turns go into its session and every agent message
to it is spoken during the call, even when it is not the caller's own chat, so
run `/voice` where calls should talk when that matters. With none,
with several and no single direct chat, or with `VOICE_MIRROR=off`, the call
talks on the voice line itself (replies come back by their `livekit:` reply
id, nothing is posted) and the host logs why once.

The page's readout follows the worker: Listening, `<agent>` is working (with
"you can keep talking" and a local wait clock) while `nanoclaw.voice.thinking`
is set, and `<agent>` is speaking (speech is ignored until the reply finishes;
the mute key says "Paused for reply"); captions come from
`lk.transcription` (the caller's interim text shows live), and each caller turn
gets a small sent / not-sent mark from the worker's `nanoclaw.voice.turn`
stream. A lost turn also stays as a notice above the transcript until a later
turn is sent; a `timeout` reads "delivery not confirmed - check the chat before
repeating", since the host may still have it. The header names the chat the
call talks in when it starts (an unnamed direct chat shows as `<channel> DM`);
after a mid-call `/voice` the host writes the new chat's label into the room
metadata (`{"chat": ...}`, `CallRoomMetadata`) once the next turn moves the
call, and the header follows it. Before it deletes the room the host also
writes why the call ended (`"end"`: `limit_duration`, `limit_daily`,
`newer_call`, `revoked`, `shutdown`, `worker_restart` (the worker shut down, as
in a deploy) or `worker_gone`; a hangup names none), and the page says so. The
token reply carries `silenceMs` and `limit: {ms, kind: "duration" | "daily"}`:
the listening hint says a pause sends a turn, a "sending..." chip fills while
`nanoclaw.voice.pending` counts down, caller lines show
"turn n" and the first caption of a reply "reply to turn n" (or "unprompted"), and a
minute before the limit the hint says the call is about to end. Short sound
cues let a caller follow the call without looking. The worker plays them, on a
second audio track (`background_audio`, tones synthesized in code, fed from the
worker's own 80 ms audio source with DTX off and a faint noise floor, so a cue
starts about 0.1 s after its event and is never clipped) apart from the agent's
speech track, so the same cues work on any surface and the caller's next words
are never taken for the agent speaking. Each is 150-250 ms of held tone about
6 dB under the agent's speech: a rising two-note (listening) once the call is
ready, a quicker higher two-note (wake) on the wake phrase, a single high note
(sent) as a turn goes out, a falling low two-note (discard) on a spoken discard,
a falling two-note (your turn) once the agent is done and nothing else is
queued, a low note (nope) for a command with nothing to act on, two soft
notes when a review draft is ready, and a soft falling two-note (sleep) when a
turn the wake phrase opened goes back to waiting. Silence while the agent works; none plays
while it speaks. A reply the speech model could not synthesize is shown on the
page as text marked "reply not spoken" (the reply topic carries
`{"reply", "unspoken": true, "text"}` after it), and no your-turn cue plays for it.
Call problems are the worker's short spoken lines, as before. `?cues=0` turns
the cues off (the page passes it to the worker in its settings RPC; the
listening cue waits up to 2 s for it). Microphone capture runs
with echo cancellation, noise suppression and auto gain; DTX is off because the
worker times turns by the silence it hears. On iOS Safari the call must be
started with the Call button (audio unlocks on that tap) and joins relay-only
(TURN over TLS; `?relay=1` / `?relay=0` override it); if playback is still
blocked the readout shows a "tap to hear `<agent>`" button. While the SDK
reconnects the readout says to wait before speaking. With no worker in the room
after 25 seconds the page says the voice service is unavailable; a worker on
another protocol version makes it say the service is updating.

**Review mode.** A segmented `hands-free | Manual` switch (the modes
`auto` and `review`, with a visible caption) sits above the keys, before
and during the call. The pick and the wake switches stay for the next call:
the page keeps them in the browser (`localStorage`), the ones picked before a
call and the ones the worker took during it, never a request it did not answer.
A new caller (nothing kept, or storage off) starts hands-free with the wake
switch on; a kept "off" stays off. In
review nothing goes out on a pause: the caller taps talk (the worker opens its
input and plays the listening cue, then the microphone opens), speaks with any pauses, taps done, reads the
draft in a dashed panel pinned above the keys (`draft - not sent`) and taps send
or discard; after either the microphone stays off until the next talk. The page
publishes its microphone muted in review and offers the mode only when the
worker sets the attribute `nanoclaw.voice.review` to "1". It drives the worker
with RPCs (`nanoclaw.voice.mode`, `.talk`, `.done`, `.send`, `.discard`; JSON
`ReviewRequest` in, `ReviewReply` out, see `voice-livekit-protocol.ts`; a mode
request naming no mode only re-reads the state, as the page does after a
reconnect or an unanswered request), so the caller's token may publish data. The
worker answers them only from the caller's identity, one at a time, each for the
draft id it names (a late or repeated one is "stale"); it serves no other control
to the caller (no typed turns, no interrupts). The worker sends every change of its `CallReviewState` (`{"seq",
"mode", "draft": {"id", "state": "recording" | "finishing" | "ready" | "empty" |
"failed", "text", "tooLong"?, "reason"?: "agent" | "switch"}, "preparing"?:
true}`) on the topic `nanoclaw.voice.review`. A recording is one transcription
activity: talk sets its Gemini Live socket up first (meanwhile the state says
`"preparing": true` and the page keeps talk off, "getting ready"), so the microphone
never opens onto a socket that is still connecting; done ends it, and the draft's text
(the final, or the last interim text when the final collapsed or never came) freezes
within 4 s, or the draft fails. Pauses and spoken commands in a recording are words;
nothing is posted until send. Send posts
exactly that text through the ordinary turn path, and its `sending` status carries the text and the draft id, so the page
shows that text as the turn. A draft over the 8 KB turn limit cannot be sent.
A reply that waits out a recording (the usual bounded wait) takes the channel
and turns the recording into a draft ("`<agent>` started speaking - review what
was heard"); talk waits while the agent speaks, but a draft can be sent then as
a follow-up. Switching auto to review mid-turn cancels the pending auto commit
and makes the unsent words a draft; if the commit already went, the page says
"previous turn already submitted". Back to auto needs no open draft and leaves
the microphone muted. A quiet two-note cue says a draft is ready to read; a call
that ends with a draft keeps it readable until discarded, never sent into the
next call.

**Spoken commands in auto.** `send it` at the end of what the caller said sends
the turn at once without the words, and `discard turn`, `discard this turn` or
`scratch that` there drops everything since the last send; nothing is posted and the
page marks those caption lines "discarded". `send it` is also taken as the
transcription writes it from a Ukrainian speaker (`сенд іт`, `сендіт`, `сендит`,
`сендип`, `sent it`, `send eat`, or cut to `send`), and the Ukrainian `прийом` sends
too. The commands are in the transcription's custom vocabulary (it hears them far
more reliably so). A command is noticed in the interim text: when two interim updates
in a row end with it and the caller is silent (the VAD's end of speech), the turn's
activity ends, and its final text decides: a command it still ends with acts, one it
does not end with (the interim text was ahead of itself) was words, and the turn goes
on in a new activity carrying them, as it does when the caller talks on before the
final comes. Only the end counts: `send it to Anna` is words, and so is a question
ending in it (`Should I send it?`). A pause that ends a turn whose final text ends in
a command applies it too. A command with nothing to act on plays the nope cue, and its
line says "nothing to send" (or "nothing to discard"). A wake switch under the mode
row, in a labelled "voice commands" block with a one-line explainer (on by default,
kept for the next call like the mode pick; the worker starts with it on until the
page's settings arrive), holds everything until the wake phrase: the chip says
`Say "<phrase>"` on a dim outlined chip, the phrase exactly as configured (`Say "Hey
LiveKit"` for the bundled model, `Hey <agent>` without a model; a fresh phrase from the
host or the worker replaces the one the browser kept), and once it is heard the chip flashes and the
line says "heard - listening", and after it only `send it` sends, unless the second
switch ("a pause also sends", shown only with the first) lets the closing silence send
too; after a send or a discard it waits again. The wake phrase is heard in the audio,
not the transcript: while it waits, nothing goes to Google; the worker scores the
caller's audio with the wake word model (`VOICE_WAKE_MODEL`, by default livekit-wakeword's
`hey_livekit`, in a worker thread, 2 s windows every 80 ms; `VOICE_WAKE_PHRASE` names
it), a score at or over `VOICE_WAKE_THRESHOLD` opens the turn (at most once in 2 s),
and the switch and chip name that phrase. The turn's activity starts right where the
phrase was spotted, as the wake cue plays (the model is end-aligned: it fires as the
phrase ends, within an 80 ms hop), so the phrase is never in the turn's audio or text,
and nothing in the text is searched for it. Speech before the phrase is not transcribed at all, so it shows no caption. A
turn the phrase opened that hears nothing for `VOICE_WAKE_START_SECONDS`, or nothing
more for `VOICE_WAKE_IDLE_SECONDS` after its last words, goes back to waiting: its
final is read first (a `send it` the interim text missed still sends then, late), else
a soft falling cue plays, the page says "went back to sleep", and words it held are
dropped as `asleep`, never sent.
Only without a model (`off`, or one that does not load) does `hey <agent>` in the
transcript open the turn, and then speech before it is transcribed (each stretch is
an activity; words with no wake phrase are marked "ignored · no wake phrase"):
`<agent>` is then the agent's name or any entry in its
`voice.vocabulary.txt`, matched across case, punctuation and Latin/Cyrillic
spelling (`Hey, Andy.`, `гей Енді`, `хей Енді`, `hi Andy`, `хай Енді`, a name
glued to the hey as in `Heyandy`, and in Cyrillic a Ukrainian vocative ending, as
in `Гей, Бене` for Ben). The worker
advertises the commands with the attribute `nanoclaw.voice.commands` = "2" (the
`send it` vocabulary; "1" was `over`, and a page offers the commands only to the value it
knows, so a page left open across an update falls back to pauses) and
takes the switches in the `nanoclaw.voice.settings` RPC (`{"wake", "pauseSends",
"cues"}`); its review state carries `"wake": {"on", "pauseSends", "waiting", "phrase", "heard",
"slept", "cut"}` (`phrase` only with a wake word model, from the start while it loads;
`heard` counts the wake phrases heard, so the page marks "heard - listening" even when
it missed the awake state; `slept` counts the turns that went back to waiting; `cut`:
the last wake was the acoustic one, so the turn started after the phrase and no caption of
the turn has it), and dropped words go out
on the turn topic as `{"dropped": "discarded" | "unaddressed" | "command" | "asleep",
"text"}`. The agent's own speech is never transcribed, so it
cannot trigger a command; caller speech that starts under it sends
`{"unheard": "agent_speaking"}` on the turn topic, and the page notes "not heard -
<agent> was speaking". `&demo=wake` plays the wake switch.

## Channel Info

- **type**: `voice`
- **terminology**: a "line" is one call link; whoever opens it talks to the wired agent. Calls are 1:1 conversations, there are no groups.
- **platform-id-format**: `voice:{line id}` where the line id is the first 12 hex characters of SHA-256 of the link token (never the token itself). The caller's user id is the same string.
- **how-to-find-id**: derive it from the token in `.env`: `node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,12))" "$VOICE_LINK_TOKEN"`; the wiring step in this skill does that for you.
- **instances**: one adapter; several lines by listing several tokens in `VOICE_LINK_TOKEN` (comma-separated), each wired on its own.
- **supports-threads**: no
- **typical-use**: a spoken conversation with one agent from a browser, for the people you hand a link to
- **default-isolation**: one named user and explicit membership per personal link; strict line policy and known-sender wiring. Different links have different voice users. Agent-group memory is still shared within that group; use a separate group for a demo.

## Troubleshooting

**An iPhone call pauses when the screen locks or you switch apps.** If the call
was launched as a Home Screen web app, open the same link directly in Safari
and compare: background calls have worked there while Home Screen mode paused
until returning to the app. Home Screen background calling is not yet verified.
On iOS 26, turning off **Open as Web App** when adding the link to the Home
Screen creates a browser bookmark instead. See
[WebKit’s Home Screen behavior](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#every-site-can-be-a-web-app-on-ios-and-ipados).

**A reply fails after hangup.** Voice delivery requires an active call. A reply
that cannot be spoken is reported as a delivery failure through the host retry
path. Voice does not deliver files or interactive question cards; ask questions
in plain spoken text and send attachments to another wired channel.

**The first answer on a call is slower than the rest.** When the caller joins,
the host starts the agent's container and its Claude session once, so the first
turn usually meets a running agent. The first answer still pays for the start
when the caller speaks within a few seconds of joining, or when the call's chat
has no agent session yet (its first message creates one). The page shows the
agent working while it waits, rather than leaving the caller looking at a silent
screen. A call does not keep the container alive: if the caller stays silent
past the host's idle ceiling, the idle container is reclaimed as for any
session, and the next turn wakes the agent again, paying the start once more.

**`Caller access denied` on the page.** Verify the voice user has a display name,
is a member of the answering agent, and the line has exactly one strict,
known-sender wiring. Spoken identity claims cannot grant access.

**`Unknown call link` on the page.** The `t` in the URL is not in
`VOICE_LINK_TOKEN`. Copy the link from the operator note above, or check
`.env`.

**The page says the microphone was refused.** Browsers only grant the
microphone on `localhost` or HTTPS. Use a tailnet HTTPS URL or a tunnel for
anything but a local try.

**The page says the voice service is unavailable or updating.** No worker joined
the room within 25 seconds, or one on another protocol version did. Check the
worker runs (`systemctl --user status nanoclaw-voice-worker.service`) and was
restarted with the host after the last build; the host log names why the call
ended.

**`voice` is missing from `ncl` channel lists.** The factory returned null:
`VOICE_LINK_TOKEN` is missing, or the host log says `LiveKit is not configured`
and names which of `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and
`GEMINI_API_KEY` is not in `.env`. Set them and restart.
