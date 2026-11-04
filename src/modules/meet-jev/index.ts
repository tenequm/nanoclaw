/**
 * The jev call loop as the voice channel uses it: one `JevCall` per `/voice jev` call, which takes the
 * worker's events and the agent's replies for that call, and turns the core's commands into turns for
 * the agent and host events for the worker. See runtime.ts (the executor) and core/ (every decision).
 *
 * On a jev call the host pushes the worker only what the core says to: a `reply` (with its `replyId`)
 * for `speak`, a `stop` for `stop_playback`. `show` and `drop` push nothing: the agent's message is
 * already in the call chat, since a reply reaches this module from the post-delivery hook.
 */
import type { LiveKitHostEvent } from '../../channels/voice-mode-protocol.js';
import { log } from '../../log.js';
import { callCore } from './core/index.js';
import type { CallCore } from './core/types.js';
import { createWorkerIngress } from './ingress/worker.js';
import { askAction } from './judge.js';
import { policyFor } from './policy.js';
import { createCallRuntime, type CallRuntime, type JevTurnResult } from './runtime.js';

export type { JevTurnResult } from './runtime.js';

/** Replies a call remembers the turn of, for the `reply` push that speaks one. */
const MAX_REMEMBERED_REPLIES = 64;
/** Jev requests one call may make per rolling minute; past it a judge is a null verdict (silence). */
export const MAX_JUDGES_PER_MINUTE = 30;
const MINUTE_MS = 60_000;

/** What a jev call needs of the voice channel. */
export interface JevCallHost {
  callId: string;
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
}

export interface JevCall {
  /** A worker POST's events, in order; malformed ones are skipped. */
  workerEvents(raw: readonly unknown[]): { accepted: number; dropped: number };
  /** An agent message for this call: `turnId` is the turn it answers, null when unprompted. */
  reply(text: string, turnId: string | null): void;
  end(reason: string): void;
}

export function createJevCall(host: JevCallHost, deps: Partial<JevDeps> = {}): JevCall {
  const core = deps.core ?? callCore;
  const judge = deps.judge ?? askAction;
  const policy = policyFor('voice', host.agentName, [...host.agentAliases]);
  const ingress = createWorkerIngress({ name: host.callerName }, host.maxTextBytes);
  const replyTurns = new Map<string, string | null>();
  let replies = 0;
  const fields = { callId: host.callId };
  const judgedAt: number[] = [];

  const capped = (): boolean => {
    const now = host.now();
    while (judgedAt.length > 0 && judgedAt[0] <= now - MINUTE_MS) judgedAt.shift();
    if (judgedAt.length >= MAX_JUDGES_PER_MINUTE) return true;
    judgedAt.push(now);
    return false;
  };

  const runtime: CallRuntime = createCallRuntime(core, policy, {
    now: host.now,
    judge: async (state, signal) => {
      if (!capped()) return judge(state, { signal });
      log.warn('meet-jev: Jev rate cap reached, judged silent', { ...fields, perMinute: MAX_JUDGES_PER_MINUTE });
      return { verdict: null, ms: 0 };
    },
    turn: ({ message, note }, signal) => host.submitTurn(message, note, signal),
    speak: (replyId, text) => {
      const turn = replyTurns.get(replyId) ?? null;
      host.push({ type: 'reply', text, turn, replyId });
    },
    show: () => undefined,
    drop: () => undefined,
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
      for (const event of events) runtime.feed(event);
      return { accepted: events.length, dropped };
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
