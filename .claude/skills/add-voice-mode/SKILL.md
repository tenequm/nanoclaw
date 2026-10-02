---
name: add-voice-mode
description: Add Voice mode - talk to your real NanoClaw agent by voice from a phone or desktop browser. Your speech is transcribed and sent to the agent in one of its chats, with its memory, tools and persona; its written reply is spoken back. Gemini speech-to-text and text-to-speech, audio over LiveKit (LiveKit Cloud free tier or self-hosted). Use when the user wants to call or talk to their agent by voice.
---

# Add Voice mode

A browser page you open from a private link. You talk; when you pause, what you
said is transcribed and sent to your agent as a message in one of its chats, so
the agent answers with that chat's context, memory, tools and persona. Its reply
is read out to you, and the chat shows both sides. No separate voice model
stands in for the agent: every answer is the agent's own.

How a call behaves: a pause of about 2.5 seconds sends what you said. While the
agent's reply plays you are not heard (no interrupting); while it works you can
keep talking, and each finished turn reaches it as a follow-up. A long reply is
spoken up to a cap and the rest stays in the chat.

Parts: the `voice-mode` channel serves the page and hands turns to the agent; a
separate worker process joins each call through LiveKit and runs Gemini
transcription and speech; LiveKit carries the audio. You need:

- a LiveKit project: LiveKit Cloud's free Build plan is enough (5,000 WebRTC
  participant minutes a month, a hard cap; a call uses two participants, you and
  the worker), or your own LiveKit server (see Self-hosted LiveKit);
- a Gemini API key (Google AI Studio);
- an HTTPS address for the page, since browsers give the microphone only to
  `localhost` or HTTPS (Tailscale Serve or a reverse proxy, below).

## Apply

### 1. Copy the code in

The code lives on NanoClaw's `channels` registry branch. Fetch it from the
remote that points at `nanocoai/nanoclaw` (in a fork usually `upstream`; set
`NANOCLAW_CHANNELS_REMOTE=<remote>` to name it), with
`git fetch <remote> +refs/heads/channels:refs/remotes/<remote>/channels`, and
copy each file below in with `git show <remote>/channels:<path> > <path>`,
overwriting (the branch is canonical; never merge it):

- the channel, `src/channels/voice-mode.ts`: the page server, the call-link
  check, call limits, the proxy gate;
- the call page, `src/channels/voice-mode-page.ts`, generated from this skill's
  `ui/` folder;
- the `/voice` chat command, `src/channels/voice-mode-command.ts`;
- the voice line's access check against core's roles,
  `src/channels/voice-mode-line.ts`;
- the LiveKit engine, `src/channels/voice-mode-livekit.ts`, and the protocol it
  shares with the worker, `src/channels/voice-mode-protocol.ts`;
- the turn hand-off into the agent's session, `src/channels/voice-mode-route.ts`;
- the worker, `src/voice-mode-worker.ts`;
- the `voice_mode_lines` table with its migration, `src/db/voice-mode-lines.ts`
  (one line per agent: the link token's hash, the caller, the chat);
- the tests: `src/channels/voice-mode-registration.test.ts`,
  `src/channels/voice-mode-adapter.test.ts`,
  `src/channels/voice-mode-page.test.ts`,
  `src/channels/voice-mode-command.test.ts`,
  `src/channels/voice-mode-line.test.ts`,
  `src/channels/voice-mode-livekit.test.ts`,
  `src/channels/voice-mode-route.test.ts` and `src/voice-mode-worker.test.ts`;
- the agent's container skill, `container/skills/voice-mode-formatting/SKILL.md`.

```nc:copy from-branch:channels
src/channels/voice-mode.ts
src/channels/voice-mode-page.ts
src/channels/voice-mode-command.ts
src/channels/voice-mode-line.ts
src/channels/voice-mode-livekit.ts
src/channels/voice-mode-protocol.ts
src/channels/voice-mode-route.ts
src/voice-mode-worker.ts
src/db/voice-mode-lines.ts
src/channels/voice-mode-registration.test.ts
src/channels/voice-mode-adapter.test.ts
src/channels/voice-mode-page.test.ts
src/channels/voice-mode-command.test.ts
src/channels/voice-mode-line.test.ts
src/channels/voice-mode-livekit.test.ts
src/channels/voice-mode-route.test.ts
src/voice-mode-worker.test.ts
container/skills/voice-mode-formatting/SKILL.md
```

Optional, only while the `channels` branch does not carry these files yet:
take them from the contributor's branch instead,
`git fetch https://github.com/tenequm/nanoclaw.git feat/add-voice-mode`, then
`git show FETCH_HEAD:<path> > <path>` for each file above.

### 2. Register the channel

Append `import './voice-mode.js';` to the channel barrel,
`src/channels/index.ts`, unless the line is already there. The chat command and
the table's migration come in with the channel.

```nc:append to:src/channels/index.ts
import './voice-mode.js';
```

### 3. Expose the router's delivery to one agent

A spoken turn goes to the line's one agent through the router's own
engaged-message delivery, `deliverToAgent` in `src/router.ts` (thread policy,
session, backfill, session-created hooks, typing, wake, fan-out). Export it:
turn `async function deliverToAgent(` into `export async function
deliverToAgent(`, unless it is exported already:

```nc:run effect:refresh
grep -q '^export async function deliverToAgent(' src/router.ts || { sed -i.bak 's/^async function deliverToAgent(/export async function deliverToAgent(/' src/router.ts && rm -f src/router.ts.bak; }
grep -q '^export async function deliverToAgent(' src/router.ts
```

### 4. Install the packages

Add these exact versions as dependencies (`pnpm add --save-exact`):
`@livekit/agents@1.9.1`, `@livekit/agents-plugin-google@1.9.1`,
`@livekit/agents-plugin-silero@1.9.1`, `@livekit/rtc-node@1.1.0`,
`livekit-server-sdk@2.19.1` and `zod@4.6.5` (a peer dependency of the LiveKit
agents).

```nc:dep
@livekit/agents@1.9.1
@livekit/agents-plugin-google@1.9.1
@livekit/agents-plugin-silero@1.9.1
@livekit/rtc-node@1.1.0
livekit-server-sdk@2.19.1
zod@4.6.5
```

### 5. Build and validate

Build with `pnpm run build`, then run the voice tests with
`pnpm exec vitest run src/channels/voice-mode src/voice-mode-worker`.

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/channels/voice-mode src/voice-mode-worker
```

The tests drive every reach-in through core and go red when one is deleted:
`voice-mode-registration.test.ts` loads the real channel and modules barrels,
runs core's default migrations and only then uses the table (the barrel line,
or a missing package, fails it); `voice-mode-command.test.ts` sends `/voice`
through the router's `routeInbound` against core's roles on a real database;
`voice-mode-route.test.ts` drives a turn into a real session, sees core's
session-created hooks fire and core's delivery reach the channel's
post-delivery hook; `voice-mode-livekit.test.ts` drives calls over HTTP against
a fake LiveKit server.

## Credentials

### LiveKit

**LiveKit Cloud (default).** Create a project at https://cloud.livekit.io and,
in its settings, an API key. The project URL looks like
`wss://<project>.livekit.cloud`. Cloud runs the TURN relays, so calls work from
phones on mobile data; the worker runs on this machine and connects out to it.

**Self-hosted LiveKit** (the second option, below): the URL is
`wss://<page host>`, where the browser signals at `/rtc`.

Ask the user for the LiveKit URL the caller's browser connects to, the API key
and its secret (a secret: never echo it back):

```nc:prompt livekit_url validate:^wss?://\S+$ normalize:rstrip-slash
LiveKit URL the caller's browser connects to, e.g. wss://my-project.livekit.cloud
```

```nc:prompt livekit_api_key validate:^\S{6,}$ normalize:trim
LiveKit API key (the key's name, from the project settings)
```

```nc:prompt livekit_api_secret secret validate:^\S{20,}$ normalize:trim
LiveKit API secret for that key
```

### Gemini

Create a key at https://aistudio.google.com/apikey. Only the worker uses it; the
host checks it is set. Speech is transcribed by `gemini-3.5-transcribe-live`
(streaming). While that model fails, `gemini-3.5-transcribe` takes over with one
request per turn, and its quota is small (on Tier 1, 10 requests a minute and
100 a day), so it is only a stopgap. Replies are spoken by
`gemini-3.8-flash-tts`, falling back to `gemini-3.8-flash-lite-tts`.

Ask the user for the Gemini API key (a secret too):

```nc:prompt gemini_api_key secret validate:^\S{20,}$ normalize:trim
Gemini API key from https://aistudio.google.com/apikey
```

Write the four values to `.env` as `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET` and `GEMINI_API_KEY`, leaving any key that is already set
as it is:

```nc:env-set
LIVEKIT_URL={{livekit_url}}
LIVEKIT_API_KEY={{livekit_api_key}}
LIVEKIT_API_SECRET={{livekit_api_secret}}
GEMINI_API_KEY={{gemini_api_key}}
```

### The page's address

The page and its routes live under `/voice` on the channel's own page server,
port `VOICE_MODE_PORT` (default 3100), listening on every interface. It answers only
loopback peers unless told otherwise, so the LAN gets 403. Browsers need HTTPS
(or `localhost`) for the microphone:

- **Tailscale Serve** (phone and computer on one tailnet) connects from
  `127.0.0.1`, so nothing else is needed. The target repeats the path because
  serve strips the mount prefix:
  `tailscale serve --bg --set-path=/voice http://127.0.0.1:3100/voice`. The
  origin is the machine's HTTPS name that `tailscale serve status` prints.
- **A reverse proxy you already run** (Caddy, nginx, Traefik): route `/voice` on
  your HTTPS host to `http://<this machine>:3100`; with Caddy on the same
  machine, `voice.example.com { reverse_proxy /voice* 127.0.0.1:3100 }`. A proxy
  that does not connect from loopback (one in a Docker container, say) needs
  `VOICE_MODE_TRUSTED_PROXY_CIDRS` (the proxy's `/32` or its Docker subnet; keep it
  narrow, any container in the range can claim any client).

To admit only some callers, set `VOICE_MODE_ALLOWED_CLIENT_CIDRS` (where
forwarded clients must be, read from the rightmost `X-Forwarded-For` hop outside
the trusted proxies; for a tailnet-only page `100.64.0.0/10,fd7a:115c:a1e0::/48`).
It applies to the proxies in `VOICE_MODE_TRUSTED_PROXY_CIDRS`; for a proxy on
this machine, list loopback there too (`127.0.0.1/32,::1/128`). A direct local
request then has to be in the allowed ranges as well, and the proxy must send
`X-Forwarded-For`. Without loopback in the trusted list, loopback peers are
always admitted.

The worker talks to the host on the host's webhook server
(`/webhook/voice-mode/livekit/agent/...`), loopback only; never proxy that path.
`VOICE_MODE_ALLOW_NON_LOOPBACK=1` drops the gate entirely, for local development only.

Ask the user for the origin callers' browsers reach the page at, and write it to
`.env` as `VOICE_MODE_PUBLIC_URL` (unless already set):

```nc:prompt public_url validate:^https?://\S+$ normalize:rstrip-slash
What origin (no path) does a caller's browser reach the page at? e.g. http://localhost:3100 to try it here, or https://voice.example.com
```

```nc:env-set
VOICE_MODE_PUBLIC_URL={{public_url}}
```

## Restart

Restart the host with `bash setup/lib/restart.sh` so the channel loads (it
creates its `voice_mode_lines` table on start):

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Who can make a call link

`/voice` is for the people core already trusts with an agent: the global
`owner`, a global `admin`, or an `admin` scoped to that agent group. NanoClaw
has no cross-channel identity: your Telegram account (`telegram:<id>`) and your
Slack account (`slack:<id>`) are separate users, so each account you want to
use needs the role. An account becomes a user the first time it messages the
bot, so send the bot anything from it first. See who has what, and grant a
scoped admin role, with core's own commands (`<agent group id>` from
`ncl groups list`):

```bash
ncl roles list
ncl users list
ncl roles grant --user slack:<id> --role admin --group <agent group id>
```

## Make the first line

Tell the user to send `/voice` (on Slack `!voice`) in a chat wired to the agent,
preferably a direct chat with the bot, after starting the worker (below): the
first time it sends a private call link for that agent (keep it, it is shown
once) and makes that chat the one calls talk in; later, `/voice` in another chat
only moves calls there, and `/voice new` replaces a lost link:

```nc:operator
In a chat wired to your agent (a direct chat with the bot is best), send /voice (on Slack: !voice). The first time, you get a private call link for that agent (keep it: it is shown once), and calls talk in that chat. Later, /voice in another chat only moves calls there; /voice new replaces a lost link. Start the voice worker first (Run the worker, below).
```

## Run the worker

The worker is a separate process (LiveKit's agent framework forks a child per
call). It reads `.env` from its working directory itself; never give it an
`EnvironmentFile`, which would put every secret in its environment. After any
update, **restart the host first, then the worker**, from the same build: they
share a protocol version, and a mismatched worker makes the page say the voice
service is updating.

Try it in a terminal first: `node dist/voice-mode-worker.js start`. Its health
check answers on `127.0.0.1:8089` (`VOICE_MODE_WORKER_HEALTH_PORT`). If the host's
webhook server is not on `http://127.0.0.1:3000` (`WEBHOOK_PORT`), set
`LIVEKIT_HOST_URL`; it must be a local `http(s)` address (`localhost`,
`127.0.0.1` or `[::1]`), since the host serves the worker on loopback only, and
the worker refuses to start otherwise.

**Linux, systemd user unit** (`~/.config/systemd/user/nanoclaw-voice-mode-worker.service`;
`WorkingDirectory` is your checkout):

```ini
[Unit]
Description=NanoClaw Voice mode worker
After=network-online.target

[Service]
WorkingDirectory=%h/nanoclaw
ExecStart=/usr/bin/env node dist/voice-mode-worker.js start
Restart=on-failure
TimeoutStopSec=90

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now nanoclaw-voice-mode-worker
```

**macOS, launchd** (`~/Library/LaunchAgents/com.nanoclaw-voice-mode-worker.plist`;
use the absolute paths of your checkout and of `which node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nanoclaw-voice-mode-worker</string>
  <key>ProgramArguments</key>
  <array><string>/path/to/node</string><string>dist/voice-mode-worker.js</string><string>start</string></array>
  <key>WorkingDirectory</key><string>/path/to/nanoclaw</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/path/to/nanoclaw/logs/voice-mode-worker.log</string>
  <key>StandardErrorPath</key><string>/path/to/nanoclaw/logs/voice-mode-worker.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw-voice-mode-worker.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-voice-mode-worker   # restart after an update
```

On stop the worker takes no new calls and gives running ones 60 seconds.

## Where calls talk, and `/voice`

Each agent has one voice line. `/voice` (Telegram) or `!voice` (Slack, whose
client eats unknown slash commands), sent in a chat wired to the agent by an
owner or admin of it:

- makes that chat (and its thread, where the wiring keeps threads) the chat the
  line's calls talk in, and confirms it;
- the first time, creates the line, mints its call link and sends it to the
  sender: as the reply in a direct chat, by direct message from a group chat,
  so other members never see it. Only a hash of the link's token is stored, so
  the link cannot be shown again. The sender becomes the line's caller: turns
  are posted as `🎙 <name>: <text>` and handed to the agent as messages from
  that account;
- later runs by the line's caller only move the call chat: the link, its
  caller and a live call stay (the call carries on in the new chat). Another
  admin's `/voice` moves nothing and says so: their speech never lands in a chat
  the caller did not pick.

`/voice new` (`!voice new` on Slack) mints a fresh link instead, sent the same
way: the old link stops working, a call made with it ends, and the sender
becomes the caller. It is how a lost or leaked link is replaced. The command
never reaches the agent.

During a call every message the agent sends to that chat is spoken. A call
also ends when the caller loses their role. If the chat stops being wired to
the agent, calls fall back to the one chat of the `VOICE_MODE_MIRROR` channel type wired to the agent (or the one
direct chat among several), and are refused when there is none.

## First call

Open the link `/voice` sent you, press Call, allow the microphone and
ask something only the agent knows ("what's on my calendar tomorrow?"). The
first answer of a call can take a few seconds longer while the agent's container
starts. On iPhone, start the call with the Call button so audio can play.
Adding `&demo=1` to the link plays a scripted call that connects to nothing.

Three short sounds let you follow a call without looking: a rising two-note
when the line hears you, a single high tick when what you said goes to the
agent, and a falling two-note when the agent is done and it is your turn. None
plays while the agent speaks. Add `&cues=0` to the link to turn them off.

## Settings

All in `.env`; restart the host (and the worker, for its keys) to apply. An
empty value reads as unset, so turn a fallback off with `off`.

| Key | Default | Read by | What |
| --- | --- | --- | --- |
| `VOICE_MODE_LANGUAGES` | `en-US` | host | Languages callers speak, BCP-47, comma-separated, the first the default (e.g. `uk-UA,en-US`). The transcription's language hints; unless it is English only, each turn also tells the agent which languages to answer in. With Ukrainian listed and Russian not, a Russian-looking transcript is treated as misheard Ukrainian. The worker's own short lines exist in English and Ukrainian. |
| `VOICE_MODE_VOCABULARY` | empty | host | Comma-separated names to recognise and spell exactly, for every agent; merged with each agent's vocabulary file (below). At most 60 terms and 1024 bytes together, these first. |
| `VOICE_MODE_PORT` | `3100` | host | The page server's port. |
| `VOICE_MODE_MAX_CALL_SECONDS` | `900` | host | Longest call. |
| `VOICE_MODE_MAX_CALLS_PER_HOUR` | `12` | host | Call starts per line per hour. |
| `VOICE_MODE_MAX_MINUTES_PER_DAY` | `120` | host | Call minutes per line per UTC day (counted in memory, reset on restart). |
| `VOICE_MODE_SILENCE_MS` | `2500` | host | Silence that sends a turn (300-30000). |
| `VOICE_MODE_MIRROR` | `telegram` | host | Channel type of the fallback call chat when the `/voice` chat is no longer wired to the agent; `off` refuses calls instead. |
| `VOICE_MODE_STT_MODEL` | `gemini-3.5-transcribe-live` | host | Streaming transcription. |
| `VOICE_MODE_STT_FALLBACK_MODEL` | `gemini-3.5-transcribe` | host | Used only while the streaming model fails; `off` for none. |
| `VOICE_MODE_TTS_MODEL` | `gemini-3.8-flash-tts` | host | Speaks the replies. |
| `VOICE_MODE_TTS_FALLBACK_MODEL` | `gemini-3.8-flash-lite-tts` | host | `off` for none. |
| `VOICE_MODE_TTS_VOICE` | `Alnilam` | host | Prebuilt Gemini voice. |
| `LIVEKIT_WORKER_URL` | `LIVEKIT_URL` | both | Server-side LiveKit URL (e.g. `ws://127.0.0.1:7880` for a server on this machine). |
| `LIVEKIT_AGENT_NAME` | `nanoclaw-voice` | both | Dispatch name; the same value for host and worker. |
| `LIVEKIT_HOST_URL` | `http://127.0.0.1:<WEBHOOK_PORT>` | worker | Where the worker reaches the host; a local `http(s)` address, checked at start. |
| `VOICE_MODE_WORKER_HEALTH_PORT` | `8089` | worker | Health check on `127.0.0.1`. |
| `VOICE_MODE_MAX_SPOKEN_CHARS` | `800` | worker | Longest spoken message; the rest stays in the chat. `0` for no cap. |

### The agent's vocabulary file

`voice.vocabulary.txt` in the agent's group folder (`groups/<folder>/`, which
the agent sees as `/workspace/agent/`) lists names the transcription should
spell exactly, one per line. It is read at the start of each call, so changes
apply from the next call. The agent adds names a transcript got wrong (the
`voice-mode-formatting` container skill tells it to); you can read and edit
the file too. Terms over 80 characters are skipped, and the file shares the
60-term, 1024-byte cap with `VOICE_MODE_VOCABULARY`.

## Self-hosted LiveKit

Your own LiveKit server instead of Cloud. A working shape for a home server
reached over a tailnet or LAN, with a reverse proxy that already holds a
certificate on port 443:

1. Install `livekit-server` (on Linux a release binary from
   https://github.com/livekit/livekit/releases, on macOS `brew install livekit`)
   and generate a key pair: `livekit-server generate-keys`.
2. Write `livekit.yaml`. `<node-ip>` is the address phones reach this machine
   at (its tailnet or LAN IP); `turn.example.com` is a name your proxy has a
   certificate for:

   ```yaml
   port: 7880                      # signalling + server API
   bind_addresses: [127.0.0.1]     # add the address your proxy connects from
   keys:
     <api key>: <api secret>       # or key_file: a file only you can read
   rtc:
     tcp_port: 7881                # ICE/TCP fallback; keep it on
     udp_port: 7882                # all media on one UDP port
     use_external_ip: false
     node_ip: <node-ip>
     ips:
       includes: [<node-ip>/32]
   turn:
     enabled: true
     domain: turn.example.com      # LiveKit always advertises TURN on :443
     tls_port: 5349
     external_tls: true            # the proxy terminates TLS, passes plain TCP
     udp_port: 0
   room:
     auto_create: false            # NanoClaw creates each call's room
   ```

3. Run it as a service: `livekit-server --config livekit.yaml`, restarted
   always (it exits 0 on a failed start), started once `<node-ip>` exists (the
   UDP socket binds only the addresses present at start).
4. Proxy two things on :443. Signalling: `/rtc` on the same HTTPS host as the
   page, to `http://127.0.0.1:7880`. TURN/TLS: a TCP route by SNI for
   `turn.example.com` that terminates TLS and forwards plain TCP to `:5349`. In
   Traefik that is a `tcp` router with ``rule: HostSNI(`turn.example.com`)``,
   `tls` on, and a service `address: 127.0.0.1:5349`; nginx needs a `stream`
   block, Caddy its layer4 plugin.
5. In `.env`: `LIVEKIT_URL=wss://<page host>` (the browser signals at `/rtc`
   there), `LIVEKIT_WORKER_URL=ws://127.0.0.1:7880`, and the key pair.
6. Let callers reach UDP 7882 and TCP 7881 on `<node-ip>`.
7. Verify: `curl -s https://<page host>/rtc/validate` returns LiveKit's own 401
   ("no permissions to access the room"), and
   `openssl s_client -connect turn.example.com:443 -servername turn.example.com`
   shows your certificate.

iPhones and iPads join relay-only (TURN over TLS): iOS Safari's WebRTC UDP often
fails over VPN tunnels, and LiveKit's own fallback reaches TURN only after
10-30 seconds. Append `&relay=0` (or `&relay=1` on other devices) to the link
to override. Desktop browsers use UDP.

## Troubleshooting

- **The page says the voice service is unavailable.** No worker joined within 25
  seconds: the worker is down, or its LiveKit URL or keys differ from the
  host's. Check its log.
- **"The voice service is updating".** Host and worker are from different
  builds; restart the host, then the worker.
- **The call ends at once and the host log says it refused the call.** The
  worker cannot reach the host: set `LIVEKIT_HOST_URL` to the host's loopback
  webhook URL.
- **The worker exits at start saying `LIVEKIT_HOST_URL` must be local.** It
  names a remote address; the worker must run on the host's machine and reach
  it over loopback.
- **`voice-mode` is missing from `ncl` channel lists.** The channel stays
  offline until `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and
  `GEMINI_API_KEY` are all set; the host log names what
  is missing.
- **The microphone is refused.** The page is not on HTTPS or `localhost`.
- **403 on the page.** The request came from a non-loopback address outside
  `VOICE_MODE_TRUSTED_PROXY_CIDRS`, or a trusted proxy (loopback included, once
  listed there) forwarded a client outside `VOICE_MODE_ALLOWED_CLIENT_CIDRS`, or
  sent no `X-Forwarded-For`.
- **Lost the call link.** It cannot be shown again (only its hash is stored):
  send `/voice new` (`!voice new` on Slack) for a fresh one; the old one stops
  working.
- **"Unknown call link".** The link was replaced by `/voice new`. Use the newest
  link, or send `/voice new` again.
- **"Caller access denied".** The account the link was minted for (the first
  `/voice`, or the last `/voice new`) no longer has an owner or admin role over
  the agent (`ncl roles list`); an admin sends `/voice new` to take the line
  over.
- **`/voice` says only an owner or admin can use it.** That chat account has no
  role over the agent; grant one with `ncl roles grant` (Who can make a call
  link, above). Each channel account is its own user.
- **"This voice line has no chat to talk in".** The chat `/voice` was last run
  in is no longer wired to the agent and `VOICE_MODE_MIRROR` finds no single
  other chat; run `/voice` in a chat that is wired.
- **No answer at all to `/voice` from a newly granted account.** That account
  has never messaged the bot, so core has no user for it yet; send the bot any
  message from it, then `/voice` again.
- **No answer to `/voice` in a group.** The bot must see the message: in a
  Telegram group send `/voice@<bot>`; on Slack use a chat where the bot reads
  messages.
- **Replies are not spoken.** Only messages the agent sends to the call chat
  while the call is live are spoken: the chat `/voice` was last run in (or the
  `VOICE_MODE_MIRROR` fallback).

To uninstall, see [REMOVE.md](REMOVE.md).
