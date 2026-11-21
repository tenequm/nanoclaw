/**
 * The jev call loop as the voice channel uses it: one `JevCall` per `/voice jev` or `/meet <link> jev`
 * call, which takes the call's transcript, the worker's reports and the agent's replies, and turns the
 * core's commands into turns for the agent and host events for the worker. See runtime.ts (the
 * executor) and core/ (every decision).
 *
 * The transcript comes from one source per kind: on `voice` the worker's STT and VAD (`workerEvents`),
 * one speaker; on `meet` each participant's own audio from Recall through the host's VAD and Gemini
 * transcription (`transcript`, ingress/recall-audio.ts), where the worker reports playback only and
 * its VAD marks (the meeting's mixed audio) are logged, never a boundary.
 *
 * On a jev call the host pushes the worker only what the core says to: a `reply` (with its `replyId`)
 * for `speak`, a `revoke` for `revoke`, a `stop` for `stop_playback`, and on a voice call each `status`,
 * each spoken command's `cue` and the answer to each of the worker's `overlap` requests.
 * `show` and `drop` push nothing: the agent's message is
 * already in the call chat, since a reply reaches this module from the post-delivery hook.
 */
import { DataPacket_Kind, RoomServiceClient } from 'livekit-server-sdk';

import type { LiveKitHostEvent, OverlapFallback } from '../../channels/voice-mode-protocol.js';
import { log } from '../../log.js';
import { callCore } from './core/index.js';
import type { CallCore, CallEvent, CallKind, SessionStamp } from './core/types.js';
import { createWorkerIngress } from './ingress/worker.js';
import { askAction, askOverlap, askStillWanted, judgeQuestions } from './judge.js';
import { policyFor } from './policy.js';
import { createCallRuntime, type CallRuntime, type JevTurnResult } from './runtime.js';

export type { SessionStamp } from './core/types.js';
export type { JevTurnResult } from './runtime.js';

/**
 * Jev requests (judges and answer-ready rechecks) one call may make per rolling minute; past it a judge is a
 * null verdict (silence, or a wake on a vocative) and a recheck speaks unchecked.
 */
export const MAX_JUDGES_PER_MINUTE = 30;
/**
 * Barge-in requests one call may make per rolling minute, apart from the judges' so a talkative caller cannot
 * starve them; past it the worker decides with its word list.
 */
export const MAX_OVERLAPS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

/** What a jev call needs of the voice channel. */
export interface JevCallHost {
  callId: string;
  statusRoom?: { name: string; url: string; apiKey: string; apiSecret: string };
  /** Which call this is; `voice` when left out. */
  kind?: CallKind;
  jevOverlapVerdict?: boolean;
  /** The worker lowers the line's gain during a barge-in instead of pausing it. */
  jevDuck?: boolean;
  callerName: string;
  /** Save unreleased words to this call's thread. */
  postCaller?(text: string): void;
  agentName: string;
  /** Other names the agent goes by (the vocabulary file's wake names). */
  agentAliases: readonly string[];
  /** The longest text one worker event may carry, in UTF-8 bytes. */
  maxTextBytes: number;
  /** A turn to the agent with the route's admission, access and limit checks. */
  submitTurn(message: string, note: string, signal: AbortSignal): Promise<JevTurnResult>;
  /** An event to the worker's stream. */
  push(event: LiveKitHostEvent): void;
  now(): number;
}

/** The core and Jev client a call runs on; test seams, the real ones by default. */
export interface JevDeps {
  core: CallCore<unknown>;
  judge: typeof askAction;
  overlap: typeof askOverlap;
  recheck: typeof askStillWanted;
}

export interface JevCall {
  readonly kind: CallKind;
  /** A worker POST's events, in order; malformed ones are skipped. */
  workerEvents(raw: readonly unknown[]): { accepted: number; dropped: number };
  /** A `meet` call's transcript event (a participant's pipeline, on the host clock); ignored on a `voice` call. */
  transcript(event: CallEvent): void;
  /** A participant's words arrived: while the agent's line plays, the worker's reflex hears of it. */
  words(): void;
  /** An agent message for this call: `turnId` is the turn it answers, null when unprompted. */
  reply(text: string, turnId: string | null, produced?: SessionStamp): void;
  /** Holds the draft for transcripts already in transit when the caller hung up. */
  drainDraft(): boolean;
  /** Close transcript input and wait for explicit turns already released. */
  finishDraft(): Promise<void> | undefined;
  end(reason: string): void;
}

export function createJevCall(host: JevCallHost, deps: Partial<JevDeps> = {}): JevCall {
  const core = deps.core ?? callCore;
  const judge = deps.judge ?? askAction;
  const recheck = deps.recheck ?? askStillWanted;
  const kind = host.kind ?? 'voice';
  const judgeOverlap = kind === 'voice' && host.jevOverlapVerdict !== false;
  const policy = policyFor(kind, host.agentName, [...host.agentAliases]);
  const ingress = createWorkerIngress({ name: host.callerName }, host.maxTextBytes);
  let replies = 0;
  const fields = { callId: host.callId };
  const overlapQuestion = judgeOverlap ? (host.jevDuck ? 'ducked' : 'paused') : undefined;
  log.info('meet-jev: questions', {
    ...fields,
    questions: judgeQuestions(host.agentName, overlapQuestion, kind === 'voice'),
  });
  const judgedAt: number[] = [];
  const overlapsAt: number[] = [];
  /** Lines the worker reported started and not yet over: `words` reaches it only while one plays. */
  const playing = new Set<string>();

  const capped = (asked = judgedAt, max = MAX_JUDGES_PER_MINUTE): boolean => {
    const now = host.now();
    while (asked.length > 0 && asked[0] <= now - MINUTE_MS) asked.shift();
    if (asked.length >= max) return true;
    asked.push(now);
    return false;
  };

  const statusRoom = host.statusRoom;
  let statusClient: RoomServiceClient | undefined;
  let statusSend = Promise.resolve();

  const runtime: CallRuntime = createCallRuntime(core, policy, {
    now: host.now,
    status: (status) => {
      // A voice call's worker plays its cues from it; a meeting shows it on the bot's tile only.
      if (kind === 'voice') host.push({ type: 'status', status });
      if (!statusRoom) return;
      statusSend = statusSend
        .then(async () => {
          if (runtime.ended) return;
          statusClient ??= new RoomServiceClient(statusRoom.url, statusRoom.apiKey, statusRoom.apiSecret, {
            requestTimeout: 2,
          });
          await statusClient.sendData(
            statusRoom.name,
            Buffer.from(JSON.stringify({ status })),
            DataPacket_Kind.RELIABLE,
            { topic: 'nanoclaw.jev.status' },
          );
          log.info('meet-jev: status sent', { ...fields, status });
        })
        .catch((err: unknown) =>
          log.warn('meet-jev: status send failed', {
            ...fields,
            status,
            err: err instanceof Error ? err.message : String(err),
          }),
        );
    },
    overlap: async ({ requestId, state, windowVersion }, signal) => {
      let verdict: Awaited<ReturnType<typeof askOverlap>>['verdict'] = null;
      let reason: OverlapFallback | undefined;
      if (capped(overlapsAt, MAX_OVERLAPS_PER_MINUTE)) {
        reason = 'cap';
        log.warn('meet-jev: Jev barge-in rate cap reached, the worker decides with its word list', {
          ...fields,
          perMinute: MAX_OVERLAPS_PER_MINUTE,
        });
      } else {
        const result = await (deps.overlap ?? askOverlap)(
          state,
          { signal, ...fields, windowVersion },
          overlapQuestion === 'ducked',
        ).catch(() => null);
        verdict = result?.verdict ?? null;
        if (!verdict) reason = result?.reason ?? 'error';
      }
      if (!signal.aborted) host.push({ type: 'overlap', requestId, verdict, ...(reason ? { reason } : {}) });
    },
    judge: async (state, signal, windowVersion) => {
      if (!capped()) return judge(state, { signal, ...fields, windowVersion, commands: kind === 'voice' });
      log.warn('meet-jev: Jev rate cap reached, judged without Jev', { ...fields, perMinute: MAX_JUDGES_PER_MINUTE });
      log.info('meet-jev: judge', {
        ...fields,
        windowVersion,
        question: 'action',
        state,
        model: null,
        usage: null,
        answer: null,
        ms: 0,
        failure: { category: 'rate_cap', message: 'Jev rate cap reached' },
      });
      return { verdict: null, ms: 0 };
    },
    recheck: async (state, signal, windowVersion) => {
      if (!capped()) return recheck(state, { signal, ...fields, windowVersion });
      log.warn('meet-jev: Jev rate cap reached, answer spoken unchecked', {
        ...fields,
        perMinute: MAX_JUDGES_PER_MINUTE,
      });
      log.info('meet-jev: judge', {
        ...fields,
        windowVersion,
        question: 'still_wanted',
        state,
        model: null,
        usage: null,
        answer: null,
        ms: 0,
        failure: { category: 'rate_cap', message: 'Jev rate cap reached' },
      });
      return { verdict: null, ms: 0 };
    },
    // A voice call's worker plays it; a meeting has no cues.
    cue: (cue) => {
      if (kind === 'voice') host.push({ type: 'cue', cue });
    },
    postCaller: host.postCaller,
    turn: ({ message, note }, signal) => host.submitTurn(message, note, signal),
    speak: (replyId, text, turn) => {
      host.push({ type: 'reply', text, turn, replyId });
    },
    allowPlay: (replyId, requestId) => host.push({ type: 'allow_play', replyId, requestId }),
    show: () => undefined,
    drop: () => undefined,
    revoke: (replyId) => host.push({ type: 'revoke', replyId }),
    stopPlayback: () => host.push({ type: 'stop' }),
    log: (event, data) => log.info(`meet-jev: ${event}`, { ...fields, ...data }),
    // Partials are many and say what the caller is still saying: their size only, and at debug.
    record: (seq, event) =>
      event.kind === 'utterance' && !event.final
        ? log.debug('meet-jev: event', {
            ...fields,
            seq,
            kind: event.kind,
            uttId: event.uttId,
            chars: event.text.length,
            final: false,
            at: event.at,
          })
        : log.info('meet-jev: event', { ...fields, seq, ...event }),
  });

  return {
    kind,
    workerEvents(raw) {
      const { events, dropped } = ingress.convert(raw, host.now());
      if (dropped > 0) log.warn('meet-jev: malformed worker events skipped', { ...fields, dropped });
      for (const event of events) {
        if (event.kind === 'playback') {
          if (event.state === 'started') playing.add(event.replyId);
          else playing.delete(event.replyId);
        } else if (kind === 'meet' && event.kind !== 'play_ready') {
          // The meeting's mixed audio, not a participant: its VAD times go to the log, to read the pipelines' against.
          if (event.kind === 'speech') log.info('meet-jev: worker vad', { ...fields, on: event.on, at: event.at });
          continue;
        }
        if (event.kind === 'overlap' && (!judgeOverlap || !playing.has(event.replyId))) {
          // An answer at once: the worker would otherwise wait out its deadline before its word list decides.
          const reason = judgeOverlap ? 'not_playing' : 'off';
          host.push({ type: 'overlap', requestId: event.requestId, verdict: null, reason });
          continue;
        }
        runtime.feed(event);
      }
      return { accepted: events.length, dropped };
    },
    transcript(event) {
      if (kind === 'meet') runtime.feed(event);
    },
    words() {
      if (playing.size > 0 && !runtime.ended) host.push({ type: 'words' });
    },
    reply(text, turnId, produced) {
      runtime.feed({ kind: 'reply', replyId: `r${++replies}`, turnId, text, produced, at: host.now() });
    },
    drainDraft() {
      if (!runtime.hasListenDraft) return false;
      runtime.feed({ kind: 'hangup', draining: true, at: host.now() });
      return true;
    },
    finishDraft() {
      runtime.feed({ kind: 'hangup', at: host.now() });
      return runtime.turnsSettled();
    },
    end: (reason) => runtime.end(reason),
  };
}
