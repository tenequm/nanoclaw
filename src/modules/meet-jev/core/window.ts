/**
 * The call's window: what was said (utterances per speaker, chat lines, the agent's played lines),
 * the bookkeeping the decisions need (wakes, replies in playout, the stop mark), and the
 * renderings of it for Jev (`toJevState`) and for the agent's turn note (`renderWindow`).
 */
import type { CallEvent, CallPolicy, Command, JevLine, JevState } from './types.js';

export interface Utterance {
  speakerId: string;
  uttId: string;
  text: string;
  final: boolean;
  startedAt: number;
  at: number;
}

/** A line the agent got out, from playback reports only. */
export interface AgentLine {
  replyId: string;
  text: string;
  state: 'playing' | 'done' | 'cut_off';
  at: number;
}

export interface ChatLine {
  speakerId: string;
  text: string;
  at: number;
}

export interface SpeakerState {
  name: string;
  speaking: boolean;
  lastUttId: string | null;
  /** The utterance the last boundary was decided on (`handledKey`), so it is decided once. */
  handled: string | null;
}

/** A `turn` command and what became of it. */
export interface Wake {
  key: string;
  speakerId: string;
  seq: number;
  at: number;
  turnId: string | null;
  /** Refused, or replaced before delivery: no answer will come. */
  dropped: boolean;
  replied: boolean;
}

/** The `judge` in flight: one at a time, the newest boundary's. */
export interface Judging {
  version: number;
  speakerId: string;
  trigger: string;
  seq: number;
  retried: boolean;
}

export interface CallState {
  policy: CallPolicy;
  /** The newest event's time; `t` in the Jev window counts back from it. */
  now: number;
  /** Events reduced so far: orders wakes against stops when they share a millisecond. */
  seq: number;
  /** Bumps whenever what Jev would see changes; a verdict for an older version is stale. */
  windowVersion: number;
  fingerprint: string;
  speakers: Record<string, SpeakerState>;
  utterances: Utterance[];
  chat: ChatLine[];
  agentLines: AgentLine[];
  /** Replies sent to `speak` that have not finished playing: replyId -> text and the wake. */
  playout: Record<string, { text: string; wakeKey: string | null }>;
  /** Replies a stop took out of `playout` before the host heard them start: the worker still reports them. */
  stoppedPlayout: Record<string, { text: string; wakeKey: string | null }>;
  /** The newest few wakes, oldest first. */
  wakes: Wake[];
  wakeCount: number;
  /** `seq` of the last stop; a reply to a wake older than it is shown, not spoken. */
  stoppedSeq: number | null;
  cutOffAfter: string | null;
  agentLastSpokeAt: number | null;
  judging: Judging | null;
  /** What the last `reduce` decided; `decide` returns it. */
  commands: Command[];
}

export function initial(policy: CallPolicy, at: number): CallState {
  const state: CallState = {
    policy,
    now: at,
    seq: 0,
    windowVersion: 0,
    fingerprint: '',
    speakers: {},
    utterances: [],
    chat: [],
    agentLines: [],
    playout: {},
    stoppedPlayout: {},
    wakes: [],
    wakeCount: 0,
    stoppedSeq: null,
    cutOffAfter: null,
    agentLastSpokeAt: null,
    judging: null,
    commands: [],
  };
  state.fingerprint = fingerprint(state);
  return state;
}

export const hasWords = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

export const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export const unpunctuated = (text: string): string =>
  text
    .replace(/\p{P}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/** Text as compared for change: case, Unicode form, punctuation and spacing aside. */
export const comparable = (text: string): string => unpunctuated(normalize(text));

export function latestUtterance(state: CallState, speakerId: string): Utterance | undefined {
  const id = state.speakers[speakerId]?.lastUttId;
  return id === null || id === undefined
    ? undefined
    : state.utterances.find((u) => u.speakerId === speakerId && u.uttId === id);
}

export const latestWake = (state: CallState): Wake | undefined => state.wakes[state.wakes.length - 1];

export function agentSpeaking(state: CallState): boolean {
  return state.agentLines.some((line) => line.state === 'playing');
}

/** An answer is on its way: the latest wake awaits its reply (and no stop came), or a reply is still to play. */
export function pendingAnswer(state: CallState): boolean {
  if (Object.keys(state.playout).length > 0) return true;
  const wake = latestWake(state);
  return !!wake && !wake.dropped && !wake.replied && (state.stoppedSeq === null || state.stoppedSeq < wake.seq);
}

/**
 * The window part of `reduce`: what was said and what the agent played. Mutates `state` (the
 * caller passes a copy) and refreshes `windowVersion`.
 */
export function applyWindow(state: CallState, event: CallEvent): void {
  state.seq += 1;
  state.now = Math.max(state.now, event.at);
  switch (event.kind) {
    case 'utterance': {
      const speaker = touchSpeaker(state, event.speaker.id, event.speaker.name);
      const text = event.text.trim();
      const utt = state.utterances.find((u) => u.speakerId === event.speaker.id && u.uttId === event.uttId);
      if (utt) {
        utt.text = text;
        utt.final = event.final;
        utt.at = event.at;
      } else {
        const fresh = {
          speakerId: event.speaker.id,
          uttId: event.uttId,
          text,
          final: event.final,
          startedAt: event.at,
          at: event.at,
        };
        state.utterances.push(fresh);
      }
      speaker.lastUttId = event.uttId;
      break;
    }
    case 'speech':
      touchSpeaker(state, event.speaker.id, event.speaker.name).speaking = event.on;
      break;
    case 'chat':
      touchSpeaker(state, event.speaker.id, event.speaker.name);
      state.chat.push({ speakerId: event.speaker.id, text: event.text.trim(), at: event.at });
      break;
    case 'playback': {
      const playing = state.playout[event.replyId] ?? state.stoppedPlayout[event.replyId];
      if (!playing) break;
      const line = state.agentLines.find((l) => l.replyId === event.replyId);
      if (event.state === 'started') {
        if (!line)
          state.agentLines.push({ replyId: event.replyId, text: playing.text, state: 'playing', at: event.at });
        state.agentLastSpokeAt = event.at;
        break;
      }
      delete state.playout[event.replyId];
      delete state.stoppedPlayout[event.replyId];
      if (event.state === 'failed') {
        state.agentLines = state.agentLines.filter((l) => l.replyId !== event.replyId);
        break;
      }
      const delivered = event.state === 'cut_off' ? (event.delivered ?? '').trim() : playing.text;
      if (line) Object.assign(line, { text: delivered, state: event.state === 'cut_off' ? 'cut_off' : 'done' });
      else state.agentLines.push({ replyId: event.replyId, text: delivered, state: 'done', at: event.at });
      state.agentLastSpokeAt = event.at;
      state.cutOffAfter = event.state === 'cut_off' ? delivered : null;
      break;
    }
    default:
      break;
  }
  trim(state);
  refreshVersion(state);
}

/** Bump `windowVersion` if what Jev would see changed. */
export function refreshVersion(state: CallState): void {
  const next = fingerprint(state);
  if (next !== state.fingerprint) {
    state.fingerprint = next;
    state.windowVersion += 1;
  }
}

function touchSpeaker(state: CallState, id: string, name: string): SpeakerState {
  const speaker = (state.speakers[id] ??= { name, speaking: false, lastUttId: null, handled: null });
  speaker.name = name;
  return speaker;
}

const utf8 = new TextEncoder();

/** Keep `windowMs` of history and at most `windowBytes` of text, dropping the oldest lines first. */
function trim(state: CallState): void {
  const since = state.now - state.policy.windowMs;
  state.utterances = state.utterances.filter((u) => u.at >= since);
  state.chat = state.chat.filter((c) => c.at >= since);
  state.agentLines = state.agentLines.filter((l) => l.at >= since || l.state === 'playing');

  const lines = [
    ...state.utterances.map((u) => ({ at: u.startedAt, text: u.text, item: u as object })),
    ...state.chat.map((c) => ({ at: c.at, text: c.text, item: c as object })),
    ...state.agentLines.map((l) => ({ at: l.at, text: l.text, item: l as object })),
  ].sort((a, b) => a.at - b.at);
  let bytes = lines.reduce((sum, line) => sum + utf8.encode(line.text).length, 0);
  const dropped = new Set<object>();
  for (const line of lines.slice(0, -1)) {
    if (bytes <= state.policy.windowBytes) break;
    bytes -= utf8.encode(line.text).length;
    dropped.add(line.item);
  }
  if (dropped.size === 0) return;
  state.utterances = state.utterances.filter((u) => !dropped.has(u));
  state.chat = state.chat.filter((c) => !dropped.has(c));
  state.agentLines = state.agentLines.filter((l) => !dropped.has(l));
}

interface Line {
  at: number;
  speaker: string;
  text: string;
  agent?: true;
  cut_off?: true;
  partial?: true;
}

function lines(state: CallState): Line[] {
  const name = (id: string) => state.speakers[id]?.name ?? id;
  const out: Line[] = [
    ...state.utterances
      .filter((u) => hasWords(u.text))
      .map((u) => ({
        at: u.startedAt,
        speaker: name(u.speakerId),
        text: u.text,
        ...(u.final ? {} : { partial: true as const }),
      })),
    ...state.chat.map((c) => ({ at: c.at, speaker: `${name(c.speakerId)} (chat)`, text: c.text })),
    ...state.agentLines.map((l) => ({
      at: l.at,
      speaker: state.policy.agentName,
      text: l.text,
      agent: true as const,
      ...(l.state === 'cut_off' ? { cut_off: true as const } : {}),
      ...(l.state === 'playing' ? { partial: true as const } : {}),
    })),
  ];
  return out.sort((a, b) => a.at - b.at);
}

const secondsAgo = (state: CallState, at: number): number => Math.round((state.now - at) / 100) / 10;

/** The JSON `state` of a Jev request: the window as of the newest event, the facts and the policy. */
export function toJevState(state: CallState, latest: JevState['latest'] = null): JevState {
  const participants = [...new Set(Object.values(state.speakers).map((s) => s.name))];
  return {
    policy: state.policy.paragraph,
    agent_name: state.policy.agentName,
    participants,
    latest,
    window: lines(state).map(({ at, ...line }): JevLine => ({ t: secondsAgo(state, at), ...line })),
    facts: {
      agent_speaking: agentSpeaking(state),
      pending_answer: pendingAnswer(state),
      cut_off_after: state.cutOffAfter,
      agent_last_spoke_s_ago: state.agentLastSpokeAt === null ? null : secondsAgo(state, state.agentLastSpokeAt),
    },
  };
}

/**
 * What Jev would see, without the clock: equal fingerprints mean an unchanged window. A partial
 * turning final with the same words (case and punctuation aside) is no change, so a final that only
 * adds punctuation does not make the verdict on the partial stale.
 */
function fingerprint(state: CallState): string {
  const jev = toJevState(state);
  return JSON.stringify({
    participants: jev.participants,
    window: jev.window.map(({ t: _t, partial: _p, ...line }) => ({ ...line, text: comparable(line.text) })),
    facts: { ...jev.facts, agent_last_spoke_s_ago: null },
  });
}

/** The window as speaker-labelled lines for the agent's turn note. */
export function renderWindow(state: CallState): string {
  return lines(state)
    .map((line) => {
      const who = line.agent ? `${line.speaker} (you)` : line.speaker;
      const mark = line.cut_off ? ' [cut off here]' : line.partial ? ' [still speaking]' : '';
      return `${who}: ${line.text}${mark}`;
    })
    .join('\n');
}
