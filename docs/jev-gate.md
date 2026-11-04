# Jev ambient wake-gate

An optional per-wiring gate that lets an agent participate in a group chat
without being mentioned, at a controlled rhythm. The wiring is widened to
`engage_mode: pattern` / pattern `.` (every message engages), and the gate then
decides per message whether a container wake is worth it, using
[Jev](https://docs.typesafe.ai) (TypeSafe System One) - a fast typed-judgment
API - plus a set of free levers. Everything the gate does not wake on falls
into the existing `ignored_message_policy: 'accumulate'` branch: stored as
silent context, no container, no cost.

Code: `src/modules/jev-gate/` (router reach-in in `src/router.ts`, fan-out
step 4). Config: `data/jev-gate.json`, keyed by agent group id, **hot-reloaded
on every message** - no restart, no redeploy. Operator surface:
`ncl jev-gate get|update --group <agent_group_id>`.

## Decision flow, per non-mention group message

1. Mentions, replies to the agent, and DMs bypass the gate entirely.
2. Free levers first (no Jev call, so no cost when they decide):
   - **daily_cap** - max gate-granted wakes per local day (0 = off).
   - **cooldown_minutes** - quiet period after a granted wake (0 = off).
   - **max_consecutive_bot** - consecutive gate wakes on bot-authored
     messages with no human chat message in between; system rows do not
     reset the streak (0 = off).
3. Jev judges the message plus the last ~10 conversation lines, answering
   four yes/no questions (Nouls, 0..1 probability of yes).
4. Thresholds turn the scores into wake/silent (see below).
5. The verdict is recorded only in host-written `jev` metadata and the host log, never in message text. The levers derive from that metadata; chat text cannot forge the counters.

**Endpoint:** `JEV_URL`, `JEV_MODEL` and `JEV_API_KEY` in `.env` or the process environment. `JEV_URL` and `JEV_MODEL` default to TypeSafe (`https://api.typesafe.ai/v1/systemone`, `jev-latest`); `JEV_API_KEY` has no default, and without it every judgment fails silent. Any endpoint that serves the same request shape works: for example OpenRouter, at `https://openrouter.ai/api/v1/systemone` with model `jev-1.13` and an OpenRouter key in `JEV_API_KEY`. A change needs a restart of the host.

**Fail-silent contract:** missing key, timeout, non-200, bad body, unreadable
config or session DB - every failure means silent, which is the pre-gate
behavior. On a pattern-everything wiring, failing open would wake a container
per message.

## The four thresholds

All are Noul cut-offs in `thresholds` (0..1). Two wake signals, two vetoes:

| Threshold | Kind | Meaning |
|---|---|---|
| `direct_invitation` | wake | The message invites the assistant to speak, or asks for something it is uniquely placed to do (lookup, research, code, a decision, an explicit hand-off). |
| `unresolved` | wake | The message leaves an open question or request nobody has answered yet. |
| `already_answered` | veto | The substance was already answered earlier - replying would repeat. |
| `human_pingpong` | veto | Two humans are in a personal back-and-forth; a third party would interrupt. |

**Rule: wake when either wake signal ≥ its threshold AND neither veto ≥ its
threshold.** Raising a wake threshold makes the agent quieter; raising a veto
threshold makes it bolder. The stored annotations carry every score, so
thresholds can be refitted from logged decisions
(`value` = max of the wake signals, `veto` = max of the vetoes).

## Modes

- `live` - the verdict routes the message: silent = accumulate, reply = wake.
- `shadow` - every ambient message is suppressed (the pre-gate baseline) while
  the annotation records what live WOULD have done, including simulated
  cap/cooldown from shadow verdicts. Calibration without behavior change.

## Who can tune it

- **Operator on the host:** `ncl jev-gate update --group <id> --cooldown-minutes 10
  --thresholds '{"direct_invitation":0.8}'` - only passed fields change.
- **A `cli_scope: global` agent** (e.g. an admin DM agent): same command; the
  `update` verb is `access: approval`, so the admin gets an approval card and
  one tap applies it live.
- **The gated agent itself** (group scope): guard special-case allows
  `jev-gate get|update` for its OWN group, also behind the approval flow.

## Voice calls and meetings (`/voice`, `/meet <link>`)

With `JEV_API_KEY` set, `/voice` page calls and `/meet` meetings run the
meet-jev loop (`src/modules/meet-jev/`) by default; `/voice plain`,
`/meet <link> send` and `/meet <link> pause` choose the wake phrase and send
word instead. The loop does not use this gate's rubric: its entries, thresholds
and levers do not apply there. On a `/voice` call the worker transcribes the
caller. In a meeting Recall.ai streams each participant's own audio to the host
over a websocket at `/voice/recall/<callId>/?token=...` (`ingress/recall.ts`,
Zero Data Retention: Recall stores no recording of the meeting, only API
metadata), the host runs a Silero VAD and a Gemini Live transcription per
participant (`ingress/recall-audio.ts`, the call's languages and vocabulary),
and one Jev Choice per speaker boundary decides whether the agent answers,
stays silent, stops or continues. When people spoke after the utterance an
answer was asked for, a second Choice (`still_wanted`) decides whether the
landed answer is still said aloud or only shown in the chat. Both count toward
one per-call cap of 30 Jev requests a minute.
The bot is left out by its display name (Recall flags no participant as the
bot), so a person who joins under that name is left out too, with a warning logged.


## Kill switch

`ncl wirings update <wiring_id> --engage-mode mention` - one command, the gate
becomes inert (no config entry is also inert: missing file or entry = upstream
behavior).
