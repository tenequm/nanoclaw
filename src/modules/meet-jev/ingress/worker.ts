/**
 * `/voice jev`'s source: what the worker posts on `agent/jev` (its STT partials and finals, VAD marks and
 * playback reports) as CallEvents. Everything heard is the caller's: a page call has one speaker.
 *
 * The worker stamps `at` on its own clock. The host's time for an event is its `at` plus the smallest
 * host-minus-worker gap seen so far on the call (the freshest event's transit), so converted times keep
 * the worker's spacing and are never later than their arrival.
 */
import type { JevWorkerEvent } from '../../../channels/voice-mode-protocol.js';
import type { CallEvent, Speaker } from '../core/types.js';

/** The caller's speaker id on a page call. */
const CALLER_SPEAKER_ID = 'caller';
/** Longest `uttId` or `replyId` taken. */
const MAX_JEV_ID_CHARS = 64;

const PLAYBACK_STATES = new Set(['started', 'completed', 'cut_off', 'failed']);

export interface WorkerIngress {
  /** The posted events in order, on the host clock; a malformed one is skipped and counted. */
  convert(raw: readonly unknown[], hostNow: number): { events: CallEvent[]; dropped: number };
}

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_JEV_ID_CHARS;

/** One posted event, checked field by field; null when anything is off. */
export function parseWorkerEvent(raw: unknown, maxTextBytes: number): JevWorkerEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at <= 0) return null;
  const text = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= maxTextBytes;
  switch (e.type) {
    case 'utterance':
      if (!isId(e.uttId) || !text(e.text) || typeof e.final !== 'boolean') return null;
      return { type: 'utterance', uttId: e.uttId, text: e.text, final: e.final, at: e.at };
    case 'speech':
      if (typeof e.on !== 'boolean') return null;
      return { type: 'speech', on: e.on, at: e.at };
    case 'playback':
      if (!isId(e.replyId) || typeof e.state !== 'string' || !PLAYBACK_STATES.has(e.state)) return null;
      if (e.delivered !== undefined && !text(e.delivered)) return null;
      return {
        type: 'playback',
        replyId: e.replyId,
        state: e.state as Extract<JevWorkerEvent, { type: 'playback' }>['state'],
        ...(e.delivered !== undefined ? { delivered: e.delivered } : {}),
        at: e.at,
      };
    default:
      return null;
  }
}

export function createWorkerIngress(caller: { name: string }, maxTextBytes: number): WorkerIngress {
  const speaker: Speaker = { id: CALLER_SPEAKER_ID, name: caller.name };
  let offset: number | null = null;

  const toCallEvent = (e: JevWorkerEvent, at: number): CallEvent => {
    switch (e.type) {
      case 'utterance':
        return { kind: 'utterance', speaker, uttId: e.uttId, text: e.text, final: e.final, at };
      case 'speech':
        return { kind: 'speech', speaker, on: e.on, at };
      case 'playback':
        return {
          kind: 'playback',
          replyId: e.replyId,
          state: e.state,
          ...(e.delivered !== undefined ? { delivered: e.delivered } : {}),
          at,
        };
    }
  };

  return {
    convert(raw, hostNow) {
      const parsed = raw.map((r) => parseWorkerEvent(r, maxTextBytes));
      const valid = parsed.filter((e): e is JevWorkerEvent => e !== null);
      for (const e of valid) offset = Math.min(offset ?? Infinity, hostNow - e.at);
      return {
        events: valid.map((e) => toCallEvent(e, Math.round(e.at + (offset ?? 0)))),
        dropped: parsed.length - valid.length,
      };
    },
  };
}
