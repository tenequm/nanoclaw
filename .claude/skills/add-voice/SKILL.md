---
name: add-voice
description: Add Live Voice — real-time, full-duplex browser conversations with a NanoClaw agent. Talk naturally and interrupt while the agent speaks. Uses OpenAI GPT-Live-1 for listening and speaking, with the NanoClaw agent handling memory and tools. Use when the user wants live voice calls with an agent. Browser client only today.
---

# Add Live Voice

Adds full-duplex browser conversations using [GPT-Live-1](https://developers.openai.com/api/docs/guides/live) as a
voice channel. The voice model handles listening and speaking in real time;
every turn that needs facts, memory, tools or an action is delegated to a
NanoClaw session, whose reply is spoken back. Native adapter: the host creates
the live session, attaches a server-side sideband WebSocket, and maps
delegations to inbound messages and agent replies to spoken commentary.
NanoClaw doesn't ship channels in trunk — this skill copies the adapter and its
tests in from the `channels` branch.

A **voice line** is one call link, `…/webhook/voice/call?t=<token>`, wired to
one agent group. Every call on the link lands in the same agent session, so the
agent remembers the previous call. Inside NanoClaw the line goes by a _line id_,
a hash of the token, so the token itself stays in the link and never reaches the
database, the logs or the agent. This skill sets up one line for a browser.
Browser is the only supported client today. Future push-to-talk can be a mode of
the same live conversation; recorded asynchronous voice messages are a separate
capability. Native apps and SIP are future clients, not installed by this skill.

Costs money: OpenAI bills voice sessions at $0.05 per minute, per second, plus
the agent's own model usage. The link token is the only thing between the
internet and that bill — treat the link like a password.

Calls end after 15 minutes, and each line permits at most 12 start attempts in
an hour. Set `GPT_LIVE_MAX_CALL_SECONDS` (default `900`) and
`GPT_LIVE_MAX_CALLS_PER_HOUR` (default `12`) to positive integers to change these
limits. Attempts include upstream failures. Each line may also spend at most
120 call minutes per UTC day (`GPT_LIVE_MAX_MINUTES_PER_DAY`): a call is refused
once the day's minutes are gone, and a running call ends when they run out. The
counters are in memory and reset when the host restarts, so this caps a day's
spend per line rather than guaranteeing a dollar budget.

When the voice model hands a request to the agent and no reply comes back within
90 seconds (`GPT_LIVE_DELEGATION_TIMEOUT_SECONDS`), the caller hears that it is
taking longer than expected instead of waiting in silence; a reply that arrives
later in the same call is still spoken.

The voice prompt speaks only Ukrainian or English: English when the caller
speaks English, Ukrainian otherwise (speech that sounds like a third language is
treated as misheard Ukrainian), and the greeting is in Ukrainian unless the
persona names another language.

Every engine's prompt (on the LiveKit path, the transcription's custom vocabulary) also lists
names the caller is likely to say, so the model recognises them and spells them
exactly in transcripts and delegations: `GPT_LIVE_VOCABULARY` (comma-separated, in `.env`) plus the agent's
optional `voice.vocabulary.txt` in its group folder (one term per line, read
like the persona file, symlinks and FIFOs refused), e.g.
`GPT_LIVE_VOCABULARY=Acme, Zephyr, k8s`. Both are merged, trimmed and
deduplicated, and capped at 60 terms and 1 KB; when neither names any, the
prompt lists no names. `GPT_LIVE_VOCABULARY` is read at startup, the file on
every call. It is prompt-only on the OpenAI path: `gpt-live-1` sessions take
no transcription settings. The LiveKit path passes it to Gemini's transcribe
models as `customVocabulary`.

The stable channel identifier and URL prefix are `voice`. The `GPT_LIVE_*`
settings and adapter module names identify the current voice engine.

## Apply

### 1. Copy the adapter and tests

Fetch the `channels` branch and copy the adapter, its session state machine,
the voice prompt composer, the call page, and their tests into place
(overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/voice.ts
src/channels/gpt-live-session.ts
src/channels/gpt-live-prompt.ts
src/channels/gpt-live-call-page.ts
src/channels/gpt-live-keychain.ts
src/channels/gpt-live-sideband.ts
src/channels/voice-adapter.test.ts
src/channels/voice-registration.test.ts
src/channels/gpt-live-session.test.ts
src/channels/gpt-live-access.test.ts
src/channels/gpt-live-keychain.test.ts
src/channels/gpt-live-sideband.test.ts
src/channels/gpt-live-call-page.test.ts
src/channels/voice-livekit.ts
src/channels/voice-livekit-protocol.ts
src/channels/voice-livekit.test.ts
src/voice-livekit-worker.ts
src/voice-livekit-worker.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if present).
This one line is the skill's only reach-in into the channel core:

```nc:append to:src/channels/index.ts
import './voice.js';
```

### 3. Teach agents to write for the ear

Replies on this channel are spoken. Mount the formatting skill so every agent
answers a call in short plain prose. `container/skills/` is mounted read-only
into every agent container; the skill only changes behaviour when a message
arrives from the `voice` channel. Copy it separately so reapplying missing adapter
files does not overwrite a customized formatting skill:

```nc:copy from-branch:channels
container/skills/voice-formatting/SKILL.md
```

### 4. Build

The OpenAI path needs no new package: it uses Node's
built-in `fetch` and WebSocket client (Node 22 or later). The LiveKit path adds
`@livekit/agents`, `@livekit/agents-plugin-google` (Gemini transcription and
speech), `@livekit/agents-plugin-silero` (Silero VAD on
`onnxruntime-node`, whose npm package ships the CPU binaries for linux-x64 and
macOS; its postinstall only fetches optional CUDA files and pnpm skips it),
`@livekit/rtc-node`, `livekit-server-sdk` and `zod` (a peer of the agents package). Build first: it guards the
adapter's typed calls into the channel core.

```nc:run effect:build
pnpm run build
```

### 5. Validate

Run the registration test, the session state-machine tests, and the adapter
integration test (a fake OpenAI behind the real webhook server):

```nc:run effect:test
pnpm exec vitest run src/channels/voice-registration.test.ts src/channels/voice-adapter.test.ts src/channels/gpt-live-session.test.ts src/channels/gpt-live-access.test.ts src/channels/gpt-live-keychain.test.ts src/channels/gpt-live-sideband.test.ts src/channels/gpt-live-call-page.test.ts src/channels/voice-livekit.test.ts src/voice-livekit-worker.test.ts
```

`voice-registration.test.ts` imports the real channel barrel and asserts the
registry contains `voice` — it goes red if the import line drifts.
`gpt-live-session.test.ts` covers the delegation bookkeeping (transcript cut,
chunking, barge-in). `voice-adapter.test.ts` drives the call page and SDP
routes over HTTP, checks the session is created in client-delegation mode with
the wired agent's name, and round-trips a delegation to an inbound message and
a reply to spoken commentary over the sideband. A real call is verified
manually once the service runs.

## Connect to OpenAI

### API key

The adapter needs an OpenAI API key with access to `gpt-live-1`. It is read on
the host only; the agent container never sees it. Two places it can live:
pasted into `.env`, or (macOS) in your login Keychain, where `.env` only names
the item and the host reads it at startup with the system `security` tool.

```nc:prompt key_source validate:^(paste|keychain)$ normalize:lower
Where should the OpenAI key live? "paste" writes it to .env; "keychain" (macOS) keeps it in your login Keychain and .env only names the item. (paste/keychain)
```

**Paste** — collected as a secret and written to `.env`:

```nc:prompt openai_api_key secret validate:^sk-.{20,}$ normalize:trim when:key_source=paste
Paste an OpenAI API key with access to gpt-live-1 (starts with sk-). Create one at https://platform.openai.com/api-keys
```

```nc:env-set when:key_source=paste
OPENAI_API_KEY={{openai_api_key}}
```

**Keychain** — the user adds the item in their own terminal, so the key never
passes through this setup or their shell history. The shell reads the key
with `read -s` rather than `security`'s own hidden prompt, which silently cuts
input at 128 characters (project keys are longer); `-T` lets the `security`
tool read the item back without a dialog. Tell the user:

```nc:operator when:key_source=keychain
Run this in a terminal; when it says "Paste the OpenAI key", paste it (nothing is echoed) and press Enter: printf 'Paste the OpenAI key, then press Enter: '; read -s KEY; echo; security add-generic-password -U -s nanoclaw-openai -a "$USER" -T /usr/bin/security -w "$KEY"; unset KEY
```

```nc:env-set when:key_source=keychain
GPT_LIVE_KEYCHAIN_SERVICE=nanoclaw-openai
```

Check the item reads back before going on (the value goes nowhere):

```nc:run effect:check when:key_source=keychain
security find-generic-password -s nanoclaw-openai -a "$USER" -w >/dev/null
```

### Public URL

The call page and the SDP handshake are served by the host's webhook server.
Give the origin a caller's browser reaches it at — `http://localhost:3000` for
a local try, a tailnet or tunnel URL to call from a phone's browser. Browsers
allow the microphone only on `localhost` or HTTPS. Set-if-absent, so a re-run
keeps your value:

On a tailnet, `tailscale serve` gives the host an HTTPS name with a valid
certificate. Mount the webhook path on it; the target repeats the path because
serve strips the mount prefix before proxying (run as root or a Tailscale
operator; an existing mount at `/` for another service is unaffected):

```bash
tailscale serve --bg --set-path=/webhook http://127.0.0.1:3000/webhook
```

The origin is then `https://<host>.<tailnet>.ts.net` and the call page lives at
`…/webhook/voice/call?t=<token>`.

The webhook server listens on every interface, so the voice routes answer only
loopback peers (403 otherwise, before any token check): a call link must not
work, or be probed, over plain HTTP from the LAN. A front such as `tailscale
serve` or a local reverse proxy connects from `127.0.0.1` and passes. For a
local-development setup whose front connects from elsewhere (a container
bridge, another machine), set `GPT_LIVE_ALLOW_NON_LOOPBACK=1`.

```nc:prompt public_url validate:^https?://\S+$ normalize:rstrip-slash
What origin can a caller's browser reach this NanoClaw host at? (e.g. http://localhost:3000 or https://nanoclaw.example.ts.net)
```

```nc:env-set
GPT_LIVE_PUBLIC_URL={{public_url}}
GPT_LIVE_VOICE=marin
```

### Link token

The voice line's secret. Reuse the one already in `.env` on a re-run, otherwise
mint a fresh one:

```nc:run capture:link_token validate:^[0-9a-f]{16}([0-9a-f]{16})?$ effect:fetch
grep -s '^GPT_LIVE_LINK_TOKEN=' .env | cut -d= -f2- | cut -d, -f1 | grep -E '^[0-9a-f]{16}([0-9a-f]{16})?$' || openssl rand -hex 16
```

Tokens minted by earlier versions of this skill are 16 hex characters and keep
working; the host logs a warning for them. To upgrade a line, replace its token
with `openssl rand -hex 16` and re-run the wiring steps for the new line id.

```nc:env-set
GPT_LIVE_LINK_TOKEN={{link_token}}
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
Agent groups on this install: {{agent_groups}}. The voice line is wired to one of them; the voice model introduces itself with that agent's name and hands it every question that needs memory or tools.
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
information or starting a billable session. Both models receive the configured
caller name and voice user ID. Spoken names and browser fields cannot override
that binding. Access is rechecked before every delegation/reply and every five
seconds during a call; revocation or a changed wiring ends the call.

Tell the user where to call from:

```nc:operator
The call link is {{public_url}}/webhook/voice/call?t={{link_token}} — keep it private, anyone holding it is treated as {{caller_name}} and can talk to {{agent_folder}} on your OpenAI bill. Open it in a browser, allow the microphone, press Call and say hello. Ask something that needs memory ("what did we decide about the launch date?") to see the agent get involved; the page shows captions when the call carries them.
```

## Smoke test without a microphone

Before the first real call, prove the key, the account, and the delegation
round trip from the host alone. The probe opens a Live session with the same
voice prompt the adapter uses, attaches the production sideband, plays a short
caller question synthesized with macOS `say`, answers the delegation the way
the adapter would, and reports whether the voice model spoke the answer back.
It costs a few cents of voice time:

```bash
pnpm exec tsx .claude/skills/add-voice/scripts/live-probe.ts
```

Every line of the summary should read `yes` (the sideband line reads `n/a`:
a sideband cannot attach to a WebSocket-transport session). `session.start
rejected` with `output_creation_failed` on an account where `gpt-live-1` lists
fine means the project has no prepaid credits (see Troubleshooting). On Linux
pass `--clip <mono 16-bit 24 kHz WAV>` instead of relying on `say`.

The second probe exercises the production path itself — the adapter, its
`sdp` route, the sideband attach on a real WebRTC session — with a synthesized
caller and a canned backend reply, so no NanoClaw agent is needed:

```bash
pnpm exec tsx .claude/skills/add-voice/scripts/browser-probe.ts
```

Open the printed URL in a browser and press Start. The terminal shows the
sideband log; the line `>>> the backend reply is being spoken` is the pass.

## Done

Callers talk to the voice model; anything needing the agent is handed over and
the answer is spoken back. Session ids are logged in `logs/nanoclaw.log`; quote
one if you need OpenAI's help with a call. To add a second line for someone
else, append another token to `GPT_LIVE_LINK_TOKEN` (comma-separated), derive
its line id the same way, and repeat the named-user, membership and strict
wiring steps for `voice:<that line id>`. Restart to load the additional token.

To uninstall: see [REMOVE.md](REMOVE.md).

## The call page

The page callers open is a small React app. Its maintainer sources live at
`.claude/skills/add-voice/ui/` beside the generated payload (in this fork: vendored
from upstream `feat/voice-payload`, PR #3772, at `324d7445`, plus the LiveKit
walkie-talkie transport in `ui/src/lib/livekit-call.ts`; MIT, see
`ui/THIRD_PARTY_NOTICES.md`):
Teenage Engineering inspired, one screen beside a rail of keys, a dot-matrix
display that shows the caller's voice in white, thinking in orange and the
agent's voice in orange, captions that fade in word by word, and three device
finishes. It ships as one self-contained document inside
`src/channels/gpt-live-call-page.ts` (generated, do not edit by hand), so the
host build, the copy list and the routes never change when the look does.

Change the look without a rebuild with one `.env` key holding a JSON object,
injected into the page when it is served:

```
GPT_LIVE_UI={"colorway":"field","presence":"matrix","brand":"Casa line"}
```

| key              | values                                                  | default                                    |
| ---------------- | ------------------------------------------------------- | ------------------------------------------ |
| `skin`           | `te` (device), `nanoclaw` (card)                        | `te`                                       |
| `colorway`       | `auto` (follows light/dark), `ivory`, `field`, `rabbit` | `auto`                                     |
| `layout`         | `rail` (screen beside keys), `stack`                    | `rail`                                     |
| `presence`       | `matrix`, `bars`                                        | `matrix`                                   |
| `brand`          | header name, up to 60 characters                        | `NanoClaw Voice`                           |
| `footer`         | footer line; `{agent}` becomes the wired agent's name   | `Voice by GPT-Live-1 · answers by {agent}` |
| `shortcuts`      | print `esc` and `space` on the keys (desktop)           | `true`                                     |
| `timestamps`     | time into the call on each transcript turn              | `true`                                     |
| `colorwayPicker` | let callers pick a finish from the page                 | `true`                                     |

The LiveKit page (`/livekit`) defaults its footer to `Walkie-talkie over LiveKit · answers by {agent}`;
a `footer` set here applies to both pages.

Callers can also switch the finish from the three dots under the transcript;
the choice stays in their browser. To change the components themselves, edit
`ui/src`, then from `ui/` run
`pnpm install --frozen-lockfile --ignore-scripts && pnpm build`. The build regenerates
the module and stamps it with a hash of the explicit `source-files.json` inputs;
`src/channels/gpt-live-call-page.test.ts` fails when the two drift, so always
rebuild the module and commit it with the source change, never hand-edit it.
`ui/` is its own pnpm workspace and sits outside the root build, lint, format
and test globs. Ordinary installs copy the generated page
and do not need a frontend build. The UI has the same three-day release-age gate
as the host and requires no dependency install scripts. Try the page without a
microphone or an agent by adding `&demo=1` to any call link: it plays a scripted
call and connects to nothing.

## LiveKit walkie-talkie (WebRTC)

The same lines also take calls over WebRTC through a self-hosted
[LiveKit](https://docs.livekit.io/) server at `…/webhook/voice/livekit?t=<token>`
(same token, line, agent wiring and access checks as `/call`). On
this path the caller talks to the line's real agent, not to a voice model: each
spoken turn is transcribed and sent to the agent as a message, and each agent
reply is read out with Gemini TTS. The worker is a LiveKit Agents `AgentSession`
with no LLM in it: VAD turns, streaming transcription, TTS, captions and the
agent state are the framework's. It is off until all four keys are in `.env`;
without them the `/livekit` routes answer 503 and nothing else changes:

```
LIVEKIT_URL=wss://<livekit host>:<port>     # signaling URL the caller's browser connects to
LIVEKIT_API_KEY=<LiveKit API key>
LIVEKIT_API_SECRET=<LiveKit API secret>
GEMINI_API_KEY=<Gemini API key>             # read by the worker; the host only checks it is set
```

Optional: `LIVEKIT_WORKER_URL` (server-side URL for the worker and the host's
room/dispatch API calls, e.g. `ws://127.0.0.1:7880` when the server runs on the
same box; defaults to `LIVEKIT_URL`), `LIVEKIT_AGENT_NAME` (dispatch name,
default `nanoclaw-voice`; set the same value for host and worker),
`LIVEKIT_HOST_URL` (worker only: where it reaches this host's webhook server,
default `http://127.0.0.1:<WEBHOOK_PORT>`; it must be a loopback address unless
`GPT_LIVE_ALLOW_NON_LOOPBACK=1`, like every voice route; the worker never takes
an address from the dispatch). The walkie-talkie settings, read by the host and
handed to the worker with each call:

| Key | Default | What |
| --- | --- | --- |
| `WALKIE_STT_MODEL` | `gemini-3.5-transcribe-live` | Streams the caller's speech over the Gemini Live API while they talk, verbatim, with the language hints `uk-UA` and `en-US` and the line's vocabulary as custom vocabulary. |
| `WALKIE_STT_FALLBACK_MODEL` | `gemini-3.5-transcribe` | Unary transcription that takes over while the streaming model fails (LiveKit's STT `FallbackAdapter`). Its quota is small (on some tiers 10 requests a minute and 100 a day), so it sends nothing while the streaming model works, every request it makes is logged at warn, and the call goes back to the streaming model at the next pause once that recovers, or tries it again every minute. `off` for none (an empty value in `.env` reads as unset). |
| `WALKIE_TTS_MODEL` | `gemini-3.8-flash-tts` | Speaks the agent's replies. |
| `WALKIE_TTS_FALLBACK_MODEL` | `gemini-3.8-flash-lite-tts` | Speaks when the main model fails (LiveKit's TTS `FallbackAdapter`, one retry each; a failed model is tried again every 30 seconds); `off` for none. |
| `WALKIE_TTS_VOICE` | `Alnilam` | Prebuilt Gemini voice, for both TTS models. |
| `WALKIE_SILENCE_MS` | `2500` | Silence that ends the caller's turn (300 to 30000); shorter pauses mid-thought keep it open. |
| `WALKIE_MIRROR` | `telegram` | Channel type of the default call chat, used until `/voice` picks one (see below); `off` keeps calls on the voice line until then. |

The worker itself reads `WALKIE_MAX_SPOKEN_CHARS` (default `800`; `0` for no
cap): an agent message longer than that, after markdown and links are stripped,
is spoken up to its last sentence end within the cap (or its last whole word when
no sentence ends before it), followed by "Решта - у чаті." or "The rest is in the
chat." in the language of the caller's last turn. It applies to every message
spoken during the call, replies and proactive ones alike, and the captions show
what was spoken; the full text stays in the chat.

It also reads `WALKIE_RECORDINGS_DAYS` (default `0`, off): with a
number of days, it saves every caller turn it hears as a 16 kHz mono WAV plus a
JSON sidecar (call and line id, agent, turn number, start and end, speech
length, the transcription model that heard it, the transcript or why there was
none, and the host's answer) under
`data/voice-recordings/<agent>/<YYYY-MM-DD>/<call id>-<turn>.wav|.json`, owner-only
(files 0600, folders 0700), and deletes files older than that many days at
start and once a day. The recordings are the caller's voice: they stay on this
machine under `data/` (which git ignores), nothing uploads or backs them up, and
anyone who can read the NanoClaw folder as its user can play them.

Restart the host to load them. LiveKit calls end at `GPT_LIVE_MAX_CALL_SECONDS`
(default 15 minutes) or when the day's minutes run out, whichever comes first.

The agent side is a separate process, the LiveKit Agents worker: agents-js
runs every job in a forked child process of its worker, so it does not live in
the host. Build, then run it next to the host from the NanoClaw directory (it
reads its settings from that directory's `.env` itself, like the host, so no
secret goes into its environment or its job processes):

```bash
pnpm run build
pnpm run voice-worker        # node dist/voice-livekit-worker.js start
```

Its health check listens on `127.0.0.1:8089` (`VOICE_WORKER_HEALTH_PORT` in
`.env`). At startup it logs its protocol version and the host URL it uses (set
`LIVEKIT_HOST_URL` in `.env` if that is not this NanoClaw's webhook server; a
call the host does not answer ends at once with the URL in the log). Each idle
job process loads the Silero models before a call reaches it. On SIGTERM it takes no new calls and gives running ones 60 seconds before
closing them, so a restart cuts a longer call short. Host and worker must be
from the same build, so restart them together: the job metadata is versioned
(`v: 3`). A worker that gets a call of another version joins only to set its
`nanoclaw.walkie.updating` attribute, so the caller's page says "The voice service
is updating. Try again in a minute.", and leaves;
the page says the same when no worker joins within 25 seconds (worker down, or
an older one that turns such calls away), and the host logs why the call ended.
As a systemd user unit:

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

How a call runs: the page posts to `/webhook/voice/livekit/token`; the host
admits the call against the shared hourly and daily limits, ends any other call
on the line (newest wins, across both engines), creates a unique room
`voice-<line id>-<random>`, dispatches the worker to it with the call metadata
(line, call id, agent and caller names, vocabulary, the walkie-talkie settings;
nothing secret, since agents-js logs whole jobs on some paths) and returns a
two-minute token that can only join that room, publish a microphone and
subscribe. The worker waits for the caller, tells the host (the daily minutes
are charged from here until the room ends) and starts its session, which
publishes the agent's audio track. The worker authenticates to the host with a per-call secret both derive
from `LIVEKIT_API_SECRET`, so the worker needs that key too. Then, walkie-talkie:

- Silero VAD follows the caller's speech (VAD-only turn detection: LiveKit's
  turn detector models have no Ukrainian). A turn survives pauses and ends
  after `WALKIE_SILENCE_MS` of silence.
- The transcription streams while the caller talks, so the text is ready when
  the turn ends; the page shows it as it comes. The worker posts the turn's
  text to `/webhook/voice/livekit/agent/utterance`, and the host hands it to the
  agent in the line's call chat (below) as `<voice source="livekit">…</voice>`
  plus a line saying the reply is read aloud (short spoken sentences, no
  markdown, links or code, numbers as words, longer material as a separate
  written message; in a call chat, that every message sent to the chat during
  the call is read aloud, so longer material waits for the end of the call).
  Its id is `livekit:<call>:<n>`.
- Every agent message to the call chat during the call (replies and proactive
  messages; with no call chat, every agent message for the line) goes to the
  worker complete over the host's event stream, and the agent's typing there is
  the worker's "thinking". The worker strips markdown, URLs and tags and speaks
  it uninterruptibly (`session.say`), cut at `WALKIE_MAX_SPOKEN_CHARS` (above),
  in sentence batches of up to 400
  characters, two requested at a time: the one playing and the next.
  Replies never overlap, and a reply waits for a caller who is mid-turn (at most
  `WALKIE_SILENCE_MS` plus ten seconds, then it takes the channel).
- While the agent's audio plays, the caller is not transcribed (no barge-in).
  While the agent works the page says it is thinking; the caller can keep
  talking, and each finished turn goes to the agent as a follow-up.
- The host answers a turn 202 only once the agent's session has stored it.
  When the router drops it (access or sender policy, no agent taking it) the
  host answers 422, when routing throws 500, and when the turn is not stored
  within 8 seconds 504. Each POST carries a random `turnKey`; the worker posts
  a turn once more under the same key when the connection drops, and the host
  answers a repeated key from the first outcome without routing it again.
- When a turn is lost (speech that came out as no text, or the host refusing
  or not answering the turn) the caller hears "Не розчув, повтори, будь ласка" or
  "Sorry, I didn't catch that", in the language of their last turn; when a reply
  cannot be synthesized, a line saying so. Both also show as captions. The
  worker also sends one JSON message per caller turn (noise is not reported) on the text stream topic
  `nanoclaw.walkie.turn`: `{"turn": n, "status": "sent" | "lost", "reason"?:
  "stt" | "empty" | "rejected" | "rate_limited" | "timeout", "text"?: …}`.
  "sent" means the agent's session has the turn; a 504 is "timeout", 429
  "rate_limited", any other refusal "rejected".

Turns are capped at 8 KB of text, 20 a minute and 3 still being routed per call. A reply for a call
that already ended is not spoken. If the worker does not open its event stream
within 30 seconds of the caller joining, the host ends the call. The host
rechecks access every five seconds and ends a call (hangup, revocation,
duration or budget limit, a newer call, shutdown) by deleting the room, which
disconnects caller and worker.

**The call chat and `/voice`.** A LiveKit call talks in one of the agent's
chats, so the agent answers with that chat's context and the chat shows both
sides. A line's caller is its own `voice:<line id>` user, linked to no other
account, so the operator first names the line's owner, the person's user on a
chat platform, and then adds the same person's other chat accounts, so `/voice`
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
`!voice`): the host replies there with the link of their own line(s) of that
agent, never anyone else's, and makes that chat (and its thread or forum topic;
on Slack a top-level `!voice` means the channel itself) the line's call chat
until `/voice` from any of the line's owner accounts names another chat of the
same agent (the last one wins). Someone who owns no line of the agent is told
so, and nothing changes. The link itself never changes and the page works
without the command; `/voice` only says where calls talk. In a chat with several agents it does this
for every agent there the sender administers. The reply goes out with link
previews off (Telegram) and unfurls off (Slack), and a reply quoting it does not
pass the link to the agent. The call chat is stored per line in `voice_lines`
and the owner accounts in `voice_line_owners` (migration 027, applied at host
start); a new owner starts with no call chat.

During a call each turn is routed into the call chat's session through the
normal inbound path, as a message from the line's own caller. It is addressed to
the line's agent alone, whoever else is wired there, and engages it whatever
the chat's trigger; session mode, access and sender policy apply as for a typed
message. Once the agent's session has a turn, the bot posts `🎙 <name>: <transcript>`
into the chat. The agent answers
in the chat as usual; while the call is live, each message it delivers to that
chat (and thread) is also spoken, and its typing there shows as thinking. After
a mid-call `/voice` the call also keeps speaking the chat it left, until a whole
turn passes with no message or typing from the agent there. A `/voice` chat that
is no longer wired to the agent, or none of whose owner accounts is still an
admin of it, is ignored (the host logs it).

Before any `/voice` the default is the `WALKIE_MIRROR` rule: the one live (not
denied, not detached) chat of that channel type wired to the agent, or the one
direct chat among several, with the line's own caller as the sender. That chat
then converses: the caller's turns go into its session and every agent message
to it is spoken during the call, even when it is not the caller's own chat, so
run `/voice` where calls should talk when that matters. With none,
with several and no single direct chat, or with `WALKIE_MIRROR=off`, the call
talks on the voice line itself as before (replies come back by their
`livekit:` reply id, nothing is posted) and the host logs why once. The
OpenAI page (`/call`) always talks on the voice line.

The LiveKit page is the same React call page as `/call` (one build from `ui/`),
served with `transport: "livekit"` in its injected config and the same
`GPT_LIVE_UI` look; `livekit-client` and `@livekit/components-react` are bundled
into it, no CDN. Its readout follows the worker: Listening, `<agent>` is working
(with "you can keep talking" and a local wait clock) while
`nanoclaw.walkie.thinking` is set, and `<agent>` is speaking (speech is ignored
until the reply finishes; the mute key says "not listening during reply");
captions come from `lk.transcription` (the caller's interim text shows live), and
each caller turn gets a small sent / not-sent mark from the worker's
`nanoclaw.walkie.turn` stream. A lost turn also stays as a notice above the
transcript until a later turn is sent; a `timeout` reads "delivery not
confirmed - check the chat before repeating", since the host may still have it.
The header names the chat the call talks in when it starts (an unnamed direct
chat shows as `<channel> DM`); after a mid-call `/voice` the host writes the new
chat's label into the room metadata (`{"chat": ...}`, `WalkieRoomMetadata`) once
the next turn moves the call, and the header follows it. Microphone capture runs
with echo cancellation, noise suppression and auto gain; DTX is off because the
worker times turns by the silence it hears. On iOS Safari the call must be
started with the Call button (audio unlocks on that tap) and joins relay-only
(TURN over TLS; `?relay=1` / `?relay=0` override it); if playback is still
blocked the readout shows a "tap to hear `<agent>`" button. While the SDK
reconnects the readout says to wait before speaking. With no worker in the room
after 25 seconds the page says the voice service is unavailable; a worker on
another protocol version makes it say the service is updating.

## Channel Info

- **type**: `voice`
- **terminology**: a "line" is one call link; whoever opens it talks to the wired agent. Calls are 1:1 conversations, there are no groups.
- **platform-id-format**: `voice:{line id}` where the line id is the first 12 hex characters of SHA-256 of the link token (never the token itself). The caller's user id is the same string.
- **how-to-find-id**: derive it from the token in `.env`: `node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,12))" "$GPT_LIVE_LINK_TOKEN"`; the wiring step in this skill does that for you.
- **instances**: one adapter; several lines by listing several tokens in `GPT_LIVE_LINK_TOKEN` (comma-separated), each wired on its own.
- **supports-threads**: no
- **typical-use**: a spoken conversation with one agent from a browser, for the people you hand a link to
- **default-isolation**: one named user and explicit membership per personal link; strict line policy and known-sender wiring. Different links have different voice sessions. Agent-group memory is still shared within that group; use a separate group for a demo.

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

**The first answer on a call takes about ten seconds.** That wait is the host
creating the agent's session and starting its container, not the voice model.
Ask a second question in the same call and the reply comes back quickly, because
the container is already running. The call page says so while it waits, rather
than leaving the caller looking at a silent screen. Containers are reclaimed
when a session goes idle, so the next call pays the same first-answer cost.
**`Caller access denied` on the page.** Verify the voice user has a display name,
is a member of the answering agent, and the line has exactly one strict,
known-sender wiring. Spoken identity claims cannot grant access.

**`Unknown call link` on the page.** The `t` in the URL is not in
`GPT_LIVE_LINK_TOKEN`. Copy the link from the operator note above, or check
`.env`.

**The page says the microphone was refused.** Browsers only grant the
microphone on `localhost` or HTTPS. Use a tailnet HTTPS URL or a tunnel for
anything but a local try.

**`Could not start the call: gpt-live: session create failed: 401`.** The key
in `.env` is wrong or lacks `gpt-live-1` access. `400` usually means the
session config was rejected — the error text names the field.

**`429` with `credit_balance_exhausted` or `insufficient_quota`, or the smoke
test's `session.start` rejected with `output_creation_failed`.** The OpenAI
project has no prepaid credits. GPT-Live-1 is not free-tier eligible and every
session is refused until the balance is positive, even though the model lists
fine and other endpoints answer. Add credits at
https://platform.openai.com/settings/organization/billing/ and rerun the smoke
test. A `429` with `rate_limit` in the message is the concurrent-session cap
instead (25 sessions at tier 1).

**`sideband attach failed`.** The session was created but the host could not
open the server-side socket. Check outbound WebSocket access from the host
(a proxy that strips `Upgrade` headers) in `logs/nanoclaw.error.log`.

**The agent never gets involved.** The voice model delegates only when its
instructions say so. Ask something it cannot know (your calendar, a past
decision). If it still answers alone, check `logs/nanoclaw.log` for
`gpt-live: sideband attached` — without it no delegation reaches the host.

**Delegations arrive but nothing is spoken back.** Check the host's routing and
delivery logs for the session id. Calls require authorized wiring before they
start; a removed membership or changed wiring ends the call. An agent startup
or model-credential failure can still prevent a backend answer after a valid
call connects.

**The caller hears the answer twice.** The agent repeated the voice model's own
words. The transcript marks them as `Assistant:` lines; the formatting skill
tells the agent not to echo them — check it is present under
`container/skills/voice-formatting/`.

**`voice` is missing from `ncl` channel lists.** The factory returned null:
neither `OPENAI_API_KEY` nor `GPT_LIVE_KEYCHAIN_SERVICE` is in `.env`, or
`GPT_LIVE_LINK_TOKEN` is missing. Set them and restart.

**`401 Incorrect API key` although the key was just created.** If the item
was added with `security … -w` and typed at `security`'s own prompt, the key
was cut at 128 characters (that prompt's limit; project keys are longer).
Check with `security find-generic-password -s nanoclaw-openai -a "$USER" -w |
tr -d '\n' | wc -c` — exactly 128 means truncated. Re-add it with the
`printf … read -s KEY …` command above. A stored value that starts with
`read -s` or `printf` means the command itself was pasted at the silent
prompt — run it again and paste only the key when asked.

**`Keychain lookup failed` in the logs.** The item is missing, named
differently, or stored for another account. `security find-generic-password
-s nanoclaw-openai -a "$USER" -w >/dev/null` must succeed in a terminal as the
user the service runs as. A locked login keychain (service started before the
user logged in) fails the same way — restart the service after logging in.
