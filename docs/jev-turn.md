# Jev end-of-turn shadow (voice)

A **shadow-only** judge in the LiveKit voice worker that measures whether
[Jev](https://docs.typesafe.ai) can tell when the caller has finished a turn.
It never sends, ends or changes a turn; it only logs what it would have done,
so its answers can be compared with how each turn really ended.

Code: `src/voice-mode-jev-turn.ts` (judge, trigger, outcome counting, config). The
worker hooks are the `shadow` dep of `CallTurns` (interim text and the turn's
end) and `jevTurn` in `runCall` (the agent's spoken lines as context).

## What it does

While an addressed auto turn is open (hands-free, or woken in wake mode; never
a Manual/review recording) and its interim text has not changed for `pauseMs`
and has at least `minWords` words, the worker asks Jev two Nouls (0..1) about
the text so far, with the agent's last spoken lines as context:

- `finished` - has the caller finished the request or thought, so it is a good
  moment to reply?
- `trailing` - does the last sentence trail off or announce more (`and also`,
  `wait`, `one more thing`, an unfinished clause)?

`wouldSend` = `finished >= thresholds.finished` and `trailing < thresholds.trailing`.
Each distinct text is judged once per turn, at most one request is in flight
per call, and the request uses the gate's 2 s timeout. Every failure (no key,
timeout, non-200, bad body, missing Noul) is nulls plus a reason, never an
action.

The endpoint is the host's: `JEV_URL`, `JEV_MODEL` and `JEV_API_KEY`, read by
`src/config.ts` from the process environment or the checkout's `.env` (the
worker runs from the same checkout as the host). `JEV_URL` and `JEV_MODEL`
default to TypeSafe (`https://api.typesafe.ai/v1/systemone`, `jev-latest`);
any endpoint with the same request shape works, for example OpenRouter
(`https://openrouter.ai/api/v1/systemone`, model `jev-1.13`, an OpenRouter
key). See `docs/jev-gate.md`. The key is never logged, and neither is any
transcript text: the lines carry counts only.

## Log lines

One per judgement:

```
voice-mode.turn-end jev shadow call=<id> turn=<n> words=<count> pauseMs=<n> finished=<0..1|-> trailing=<0..1|-> wouldSend=<bool> ms=<latency> err=<reason|->
```

`late=true` is appended when the answer came after the turn had already ended
(it is not counted in that turn's outcome).

One per turn the shadow watched, when it ends:

```
voice-mode.turn-end jev outcome call=<id> turn=<n> endedBy=<why> words=<count> judgements=<n> firstWouldSendMsBeforeEnd=<n|-> falseWouldSends=<n>
```

`endedBy` is `send-word`, `pause` (closing silence), `discard`, `timeout` (wake
mode went back to sleep), `hangup`, or CallTurns' own reason for the rarer ends
(`agent`: a waiting reply took the channel; `switch`: to Manual; `unaddressed`).
A false would-send is a `wouldSend=true` judgement after which the caller said
more words before the turn ended. A spoken command that turns out to be words
ends one activity (`endedBy=send-word` or `discard`) and its continuation is
logged as the next `turn`.

When a cap is reached: `voice-mode.turn-end jev capped call=<id> scope=call|day limit=<n>`, once per call.
`scope=usage` (also once per call) means the daily count could not be kept -
another process held it, or the usage file was torn or unwritable - so that
judgment was skipped rather than left uncounted.

Each line is also emitted with the same values as structured fields
(`jevTurn: shadow|outcome|capped`), next to the call's `callId`.

## Config

`data/jev-turn.json`, re-read when it changes (no restart). A missing or
unreadable file means off.

```json
{
  "enabled": true,
  "pauseMs": 1200,
  "minWords": 3,
  "thresholds": { "finished": 0.8, "trailing": 0.5 },
  "maxPerCall": 40,
  "maxPerDay": 1000
}
```

Only `enabled` is required; the rest default to the values above. The daily
count lives in `data/jev-turn-usage.json` (each call runs in its own job
process, so it cannot be kept in memory). Concurrent calls read, check and
bump it under `data/jev-turn-usage.json.lock` and replace it by rename, so
`maxPerDay` holds across calls; a judgment that cannot be counted is skipped.
Kill switch: `"enabled": false`, or delete the file.

## Enabling

In the nanoclaw checkout, write `data/jev-turn.json` with
`{ "enabled": true }` (the worker build must include this module). It takes
effect from the next call's next interim; no restart. Check that `JEV_API_KEY`
is set, or every judgement logs `err=no_key`.

## Evaluating

Grep the voice worker's log for `voice-mode.turn-end jev`; with the skill's systemd
user unit:

```bash
journalctl --user -u nanoclaw-voice-mode-worker -n 100 | rg 'voice-mode.turn-end jev'
```

What to read off the outcome lines, per `endedBy`:

- Turns ended by `send-word` or `pause` with `firstWouldSendMsBeforeEnd` set:
  Jev called the end, and how much earlier than the real end.
- `falseWouldSends > 0`: Jev would have cut the caller off; this is the number
  to drive to zero by raising `thresholds.finished` or lowering
  `thresholds.trailing`.
- `judgements > 0` with no would-send on a turn that did end: a missed end.

The shadow lines carry both scores, so thresholds can be refitted offline
without new calls.

## Removing it

Delete `src/voice-mode-jev-turn.ts`, its test and this doc, then the `shadow` field
and its three calls in `CallTurns` and the three `jevTurn` lines in `runCall`
(`src/voice-mode-worker.ts`).
