/**
 * The call's window: what was said (utterances per speaker, chat lines, the agent's played lines),
 * the bookkeeping the decisions need (wakes, replies in playout, the stop mark), and the
 * renderings of it for Jev (`toJevState`) and for the agent's turn note (`renderWindow`).
 */
import type { CallEvent, CallPolicy, Command, JevLine, JevState, RecheckAction, RecheckState } from './types.js';

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
  lastHeardAt: number | null;
  speaking: boolean;
  /** The speaker's current utterance: the newest in source order, never moved back by a late final. */
  lastUttId: string | null;
  /** The uttIds already decided on, newest last (at most `HANDLED_KEPT`), so each utterance is decided once. */
  handled: string[];
  /** Speech starts so far. Both sources open one utterance per speech start. */
  speeches: number;
  /** The speech start whose utterance was seen during that speech; null before any. */
  claimed: number | null;
  /** Utterances that started at or before this belong to a closed turn: answered, or a stop. */
  closedAt: number;
}

const HANDLED_KEPT = 32;

export const isHandled = (speaker: SpeakerState, uttId: string): boolean => speaker.handled.includes(uttId);

export function markHandled(speaker: SpeakerState, uttId: string): void {
  if (!isHandled(speaker, uttId)) speaker.handled = [...speaker.handled, uttId].slice(-HANDLED_KEPT);
}

export function unmarkHandled(speaker: SpeakerState, uttId: string): void {
  speaker.handled = speaker.handled.filter((id) => id !== uttId);
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
  /** The utterance it answers and when that started: people speaking after it make a landed answer rechecked. */
  trigger: string;
  triggerAt: number;
  /** The last recheck's outcome and how many utterances followed the trigger then; reused while that holds. */
  rechecked: { outcome: RecheckAction; since: number } | null;
}

/** Replies held for the answer-ready check of their wake, in arrival order. */
export interface Recheck {
  wakeKey: string;
  /** `utterancesSince` the trigger when the check was asked. */
  since: number;
  replies: { replyId: string; text: string }[];
}

/** The `judge` in flight: one at a time, the newest boundary's. */
export interface Judging {
  version: number;
  speakerId: string;
  uttId: string;
  trigger: string;
  /** The trigger calls the agent by name: a failed Jev call still wakes it. */
  addressedByName: boolean;
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
  roster: Record<string, string>;
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
  lastReplyTo: { speakerId: string; at: number } | null;
  exchangeSpeakerId: string | null;
  judging: Judging | null;
  /** The answer-ready check in flight: one at a time, the latest wake's. */
  recheck: Recheck | null;
  /** An utterance whose verdict came while someone spoke: decided again at the next boundary that decides nothing newer. */
  deferred: { speakerId: string; uttId: string } | null;
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
    roster: {},
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
    lastReplyTo: null,
    exchangeSpeakerId: null,
    judging: null,
    deferred: null,
    recheck: null,
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

/**
 * The speaker's turn so far, oldest piece first: their current utterance and, with one human in the call, the
 * pieces before it that a pause split off, back to their last closed turn or the agent's last line.
 */
export function openTurn(state: CallState, speakerId: string): Utterance[] {
  const current = latestUtterance(state, speakerId);
  if (!current) return [];
  const pieces = [current];
  if (humansInRoom(state) > 1) return pieces;
  const closedAt = Math.max(state.speakers[speakerId]?.closedAt ?? 0, ...state.agentLines.map((line) => line.at));
  const earlier = state.utterances
    .filter((u) => u.speakerId === speakerId && u.startedAt < current.startedAt && hasWords(u.text))
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const piece of earlier) {
    if (piece.startedAt <= closedAt || pieces[0].startedAt - piece.at > state.policy.oneCaller.joinGapMs) break;
    pieces.unshift(piece);
  }
  return pieces;
}

export const latestWake = (state: CallState): Wake | undefined => state.wakes[state.wakes.length - 1];

export function agentSpeaking(state: CallState): boolean {
  return state.agentLines.some((line) => line.state === 'playing');
}

/** A person is speaking now (on a voice call, the caller). */
export const floorTaken = (state: CallState): boolean => Object.values(state.speakers).some((s) => s.speaking);

/** An answer is on its way: the latest wake awaits its reply (and no stop came), or a reply is still to play. */
export function pendingAnswer(state: CallState): boolean {
  if (Object.keys(state.playout).length > 0 || state.recheck !== null) return true;
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
    case 'presence':
      if (event.joined) state.roster[event.speaker.id] = event.speaker.name;
      else delete state.roster[event.speaker.id];
      break;
    case 'utterance': {
      const speaker = touchSpeaker(state, event.speaker.id, event.speaker.name);
      speaker.lastHeardAt = event.at;
      const text = event.text.trim();
      if (
        event.final &&
        hasWords(text) &&
        state.lastReplyTo !== null &&
        event.at >= state.lastReplyTo.at &&
        event.speaker.id !== state.exchangeSpeakerId
      )
        state.exchangeSpeakerId = null;
      const utt = state.utterances.find((u) => u.speakerId === event.speaker.id && u.uttId === event.uttId);
      if (utt) {
        // A late final updates its own line; it never makes an older utterance the current one again.
        utt.text = text;
        utt.final = event.final;
        utt.at = event.at;
        break;
      }
      // A new uttId while the current speech already showed its own utterance belongs to an earlier speech: a final
      // that settled late, placed before the current line and not made current.
      const late = speaker.claimed !== null && speaker.claimed === speaker.speeches;
      const current = late ? latestUtterance(state, event.speaker.id) : undefined;
      state.utterances.push({
        speakerId: event.speaker.id,
        uttId: event.uttId,
        text,
        final: event.final,
        startedAt: current ? Math.min(event.at, current.startedAt - 1) : event.at,
        at: event.at,
      });
      if (late) break;
      speaker.lastUttId = event.uttId;
      if (speaker.speaking) speaker.claimed = speaker.speeches;
      break;
    }
    case 'speech': {
      const speaker = touchSpeaker(state, event.speaker.id, event.speaker.name);
      if (event.on && !speaker.speaking) speaker.speeches += 1;
      speaker.lastHeardAt = event.at;
      speaker.speaking = event.on;
      break;
    }
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
      const delivered = event.state === 'cut_off' ? (event.delivered ?? '').trim() : playing.text;
      // Failed, or dropped before it started (a stop, a revoke): nothing got out.
      if (event.state === 'failed' || (!line && !delivered)) {
        state.agentLines = state.agentLines.filter((l) => l.replyId !== event.replyId);
        break;
      }
      if (line) Object.assign(line, { text: delivered, state: event.state === 'cut_off' ? 'cut_off' : 'done' });
      else state.agentLines.push({ replyId: event.replyId, text: delivered, state: 'done', at: event.at });
      state.agentLastSpokeAt = event.at;
      state.cutOffAfter = event.state === 'cut_off' ? delivered : null;
      const wake = state.wakes.find((w) => w.key === playing.wakeKey);
      if (wake) {
        state.lastReplyTo = { speakerId: wake.speakerId, at: event.at };
        state.exchangeSpeakerId = wake.speakerId;
      }
      break;
    }
    default:
      break;
  }
  if (state.lastReplyTo !== null && state.now - state.lastReplyTo.at > 60_000) state.exchangeSpeakerId = null;
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
  const speaker = (state.speakers[id] ??= {
    name,
    lastHeardAt: null,
    speaking: false,
    lastUttId: null,
    handled: [],
    speeches: 0,
    claimed: null,
    closedAt: 0,
  });
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

export function humansInRoom(state: CallState): number {
  if (state.policy.kind === 'voice') return 1;
  const heard = Object.values(state.speakers).filter(
    (speaker) => speaker.lastHeardAt !== null && speaker.lastHeardAt >= state.now - state.policy.windowMs,
  ).length;
  return Math.max(Object.keys(state.roster).length, heard);
}

const QUESTION_WORDS = new Set([
  '\u0447\u0438',
  '\u0449\u043e',
  '\u044f\u043a',
  '\u0434\u0435',
  '\u043a\u043e\u043b\u0438',
  '\u0447\u043e\u043c\u0443',
  '\u043d\u0430\u0432\u0456\u0449\u043e',
  '\u0441\u043a\u0456\u043b\u044c\u043a\u0438',
  '\u0445\u0442\u043e',
  '\u044f\u043a\u0438\u0439',
  '\u044f\u043a\u0430',
  '\u044f\u043a\u0435',
  '\u044f\u043a\u0456',
  '\u043c\u043e\u0436\u0435\u0448',
  '\u043c\u043e\u0436\u0435\u0442\u0435',
  '\u043f\u0456\u0434\u043a\u0430\u0436\u0438',
  '\u0441\u043a\u0430\u0436\u0438',
  '\u0440\u043e\u0437\u043a\u0430\u0436\u0438',
  '\u043f\u043e\u044f\u0441\u043d\u0438',
  'who',
  'what',
  'when',
  'where',
  'why',
  'how',
  'which',
  'can',
  'could',
  'would',
  'will',
  'do',
  'does',
  'did',
  'is',
  'are',
  'tell',
  'explain',
]);
const SECOND_PERSON_WORDS = new Set([
  '\u0442\u0438',
  '\u0442\u0435\u0431\u0435',
  '\u0442\u043e\u0431\u0456',
  '\u0442\u043e\u0431\u043e\u044e',
  '\u0442\u0432\u0456\u0439',
  '\u0442\u0432\u043e\u044f',
  '\u0442\u0432\u043e\u0454',
  '\u0442\u0432\u043e\u0457',
  '\u0432\u0438',
  '\u0432\u0430\u0441',
  '\u0432\u0430\u043c',
  '\u0432\u0430\u0448',
  'you',
  'your',
  'yours',
]);

/** The JSON `state` of a Jev request: the window as of the newest event, the facts and the policy. */
export function toJevState(state: CallState, latest: JevState['latest'] = null, addressedByName = false): JevState {
  const text = latest?.text ?? '';
  const words = normalize(text).match(/\p{L}+/gu) ?? [];
  const cyrillic = /(?=\p{L})\p{Script=Cyrillic}/u.test(text);
  const latin = /(?=\p{L})\p{Script=Latin}/u.test(text);
  const participants =
    state.policy.kind === 'meet'
      ? Object.values(state.roster)
      : [...new Set(Object.values(state.speakers).map((s) => s.name))];
  return {
    policy: humansInRoom(state) <= 1 ? state.policy.oneCaller.paragraph : state.policy.paragraph,
    agent_name: state.policy.agentName,
    participants,
    latest,
    window: lines(state).map(({ at, ...line }): JevLine => ({ t: secondsAgo(state, at), ...line })),
    facts: {
      humans_in_room: humansInRoom(state),
      agent_speaking: agentSpeaking(state),
      pending_answer: pendingAnswer(state),
      cut_off_after: state.cutOffAfter,
      agent_last_spoke_s_ago: state.agentLastSpokeAt === null ? null : secondsAgo(state, state.agentLastSpokeAt),
      last_reply_to:
        state.lastReplyTo === null
          ? null
          : {
              speaker: state.speakers[state.lastReplyTo.speakerId]?.name ?? state.lastReplyTo.speakerId,
              s_ago: secondsAgo(state, state.lastReplyTo.at),
            },
      in_exchange_with:
        state.exchangeSpeakerId === null
          ? null
          : (state.speakers[state.exchangeSpeakerId]?.name ?? state.exchangeSpeakerId),
      addressed_by_name: addressedByName,
      latest_is_question: text.trimEnd().endsWith('?') || QUESTION_WORDS.has(words[0] ?? ''),
      latest_to_you: words.some((word) => SECOND_PERSON_WORDS.has(word)),
      latest_language: cyrillic ? (latin ? 'mixed' : 'uk') : latin ? 'en' : 'other',
    },
  };
}

/**
 * What Jev would see, without the clock: equal fingerprints mean an unchanged window. A partial
 * turning final with the same words is no change unless punctuation changes a language fact.
 */
function fingerprint(state: CallState): string {
  const latest = state.utterances.reduce<Utterance | null>(
    (newest, utterance) => (!newest || utterance.startedAt >= newest.startedAt ? utterance : newest),
    null,
  );
  const jev = toJevState(state, latest ? { speaker: latest.speakerId, text: latest.text } : null);
  return JSON.stringify({
    roster: state.roster,
    participants: jev.participants,
    window: jev.window.map(({ t: _t, partial: _p, ...line }) => ({ ...line, text: comparable(line.text) })),
    facts: {
      ...jev.facts,
      agent_last_spoke_s_ago: null,
      last_reply_to: jev.facts.last_reply_to === null ? null : { ...jev.facts.last_reply_to, s_ago: null },
    },
  });
}

/** People's finished utterances with words that started after the wake's trigger. */
export const utterancesSince = (state: CallState, wake: Wake): Utterance[] =>
  state.utterances.filter((u) => u.final && hasWords(u.text) && u.startedAt > wake.triggerAt);

/** The JSON `state` of the answer-ready check for `wake`'s `reply`. */
export function toRecheckState(state: CallState, wake: Wake, reply: string): RecheckState {
  const { latest: _latest, ...jev } = toJevState(state);
  const name = state.speakers[wake.speakerId]?.name ?? wake.speakerId;
  return {
    ...jev,
    trigger: { speaker: name, text: wake.trigger },
    reply,
    since: lines(state)
      .filter((line) => line.at > wake.triggerAt && !line.agent && !line.partial)
      .map(({ at, ...line }): JevLine => ({ t: secondsAgo(state, at), ...line })),
  };
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
