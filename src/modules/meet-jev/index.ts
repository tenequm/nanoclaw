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
 * for `speak`, a `revoke` for `revoke`, a `stop` for `stop_playback`. `show` and `drop` push nothing: the agent's message is
 * already in the call chat, since a reply reaches this module from the post-delivery hook.
 */
import type { LiveKitHostEvent } from '../../channels/voice-mode-protocol.js';
import { log } from '../../log.js';
import { callCore } from './core/index.js';
import type { CallCore, CallEvent, CallKind } from './core/types.js';
import { createWorkerIngress } from './ingress/worker.js';
import { askAction, askStillWanted, judgeQuestions } from './judge.js';
import { policyFor } from './policy.js';
import { createCallRuntime, type CallRuntime, type JevTurnResult } from './runtime.js';

export type { JevTurnResult } from './runtime.js';

/** Replies a call remembers the turn of, for the `reply` push that speaks one. */
const MAX_REMEMBERED_REPLIES = 64;
/**
 * Jev requests (judges and answer-ready rechecks) one call may make per rolling minute; past it a judge is a
 * null verdict (silence, or a wake on a vocative) and a recheck speaks unchecked.
 */
export const MAX_JUDGES_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

/** What a jev call needs of the voice channel. */
export interface JevCallHost {
  callId: string;
  /** Which call this is; `voice` when left out. */
  kind?: CallKind;
  callerName: string;
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
  recheck: typeof askStillWanted;
}

export interface JevCall {
  /** A worker POST's events, in order; malformed ones are skipped. */
  workerEvents(raw: readonly unknown[]): { accepted: number; dropped: number };
  /** A `meet` call's transcript event (a participant's pipeline, on the host clock); ignored on a `voice` call. */
  transcript(event: CallEvent): void;
  /** A participant's words arrived: while the agent's line plays, the worker's reflex hears of it. */
  words(): void;
  /** An agent message for this call: `turnId` is the turn it answers, null when unprompted. */
  reply(text: string, turnId: string | null): void;
  end(reason: string): void;
}

export function createJevCall(host: JevCallHost, deps: Partial<JevDeps> = {}): JevCall {
  const core = deps.core ?? callCore;
  const judge = deps.judge ?? askAction;
  const recheck = deps.recheck ?? askStillWanted;
  const kind = host.kind ?? 'voice';
  const policy = policyFor(kind, host.agentName, [...host.agentAliases]);
  const ingress = createWorkerIngress({ name: host.callerName }, host.maxTextBytes);
  const replyTurns = new Map<string, string | null>();
  let replies = 0;
  const fields = { callId: host.callId };
  log.info('meet-jev: questions', { ...fields, questions: judgeQuestions(host.agentName) });
  const judgedAt: number[] = [];
  /** Lines the worker reported started and not yet over: `words` reaches it only while one plays. */
  const playing = new Set<string>();

  const capped = (): boolean => {
    const now = host.now();
    while (judgedAt.length > 0 && judgedAt[0] <= now - MINUTE_MS) judgedAt.shift();
    if (judgedAt.length >= MAX_JUDGES_PER_MINUTE) return true;
    judgedAt.push(now);
    return false;
  };

  const runtime: CallRuntime = createCallRuntime(core, policy, {
    now: host.now,
    judge: async (state, signal, windowVersion) => {
      if (!capped()) return judge(state, { signal, ...fields, windowVersion });
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
    turn: ({ message, note }, signal) => host.submitTurn(message, note, signal),
    speak: (replyId, text) => {
      const turn = replyTurns.get(replyId) ?? null;
      host.push({ type: 'reply', text, turn, replyId });
    },
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
    workerEvents(raw) {
      const { events, dropped } = ingress.convert(raw, host.now());
      if (dropped > 0) log.warn('meet-jev: malformed worker events skipped', { ...fields, dropped });
      for (const event of events) {
        if (event.kind === 'playback') {
          if (event.state === 'started') playing.add(event.replyId);
          else playing.delete(event.replyId);
        } else if (kind === 'meet') {
          // The meeting's mixed audio, not a participant: its VAD times go to the log, to read the pipelines' against.
          if (event.kind === 'speech') log.info('meet-jev: worker vad', { ...fields, on: event.on, at: event.at });
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
    reply(text, turnId) {
      const replyId = `r${++replies}`;
      replyTurns.set(replyId, turnId);
      for (const key of replyTurns.keys()) {
        if (replyTurns.size <= MAX_REMEMBERED_REPLIES) break;
        replyTurns.delete(key);
      }
      runtime.feed({ kind: 'reply', replyId, turnId, text, at: host.now() });
    },
    end: (reason) => runtime.end(reason),
  };
}
