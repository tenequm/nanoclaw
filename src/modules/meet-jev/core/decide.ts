/**
 * The decisions of the jev call loop. A decision changes the state (a wake's key, the stop mark,
 * the judge in flight), so `reduce` makes it and records its commands in the state; `decide`
 * returns them. Replaying the event log through `reduce` reproduces every decision.
 */
import type { Action, CallEvent, Command, Verdict } from './types.js';
import {
  agentSpeaking,
  applyWindow,
  comparable,
  hasWords,
  latestUtterance,
  latestWake,
  normalize,
  pendingAnswer,
  refreshVersion,
  renderWindow,
  toJevState,
  unpunctuated,
  type CallState,
  type Utterance,
} from './window.js';

const BOUNDARY_TIMER = 'boundary:';
/** The worker reports its STT final up to ~3 s after the VAD end; a voice boundary waits that long for it. */
const FINAL_MARGIN_MS = 3_000;
const WAKES_KEPT = 8;
const STOP_WORDS = new Set(['stop', 'please stop', 'stop please', 'стоп', 'стій', 'зупинись']);

export function reduce(prev: CallState, event: CallEvent): CallState {
  const state = structuredClone<CallState>({ ...prev, commands: [] });
  applyWindow(state, event);
  const out = state.commands;
  const voice = state.policy.kind === 'voice';
  switch (event.kind) {
    case 'utterance':
      // A voice call decides on the final, which the worker sends after its VAD end; a meeting on a pause.
      if (voice) {
        if (event.final && !stillSpeaking(state, event.speaker.id)) boundary(state, event.speaker.id);
      } else if (hasWords(event.text)) {
        out.push({ kind: 'wait', key: BOUNDARY_TIMER + event.speaker.id, ms: state.policy.boundaryFallbackMs });
      }
      break;
    case 'speech':
      if (event.on) break;
      if (voice && !latestUtterance(state, event.speaker.id)?.final) {
        // The timer decides on the partial only when the final never comes.
        out.push({
          kind: 'wait',
          key: BOUNDARY_TIMER + event.speaker.id,
          ms: state.policy.boundaryFallbackMs + FINAL_MARGIN_MS,
        });
      } else {
        boundary(state, event.speaker.id);
      }
      break;
    case 'timer':
      if (event.key.startsWith(BOUNDARY_TIMER)) {
        const speakerId = event.key.slice(BOUNDARY_TIMER.length);
        if (!stillSpeaking(state, speakerId)) boundary(state, speakerId);
      }
      break;
    case 'verdict':
      onVerdict(state, event.windowVersion, event.verdict, event.ms);
      break;
    case 'turn': {
      const wake = state.wakes.find((w) => w.key === event.key);
      if (wake) wake.turnId = event.turnId;
      break;
    }
    case 'turn_failed': {
      const wake = state.wakes.find((w) => w.key === event.key);
      if (wake) wake.dropped = true;
      log(state, 'turn_failed', { key: event.key, reason: event.reason });
      break;
    }
    case 'reply':
      onReply(state, event.replyId, event.turnId, event.text);
      break;
    case 'playback': {
      const playing = prev.playout[event.replyId] ?? prev.stoppedPlayout[event.replyId];
      if (playing && event.state !== 'started') logPlayback(state, event, playing.wakeKey);
      break;
    }
    case 'chat':
      break;
  }
  refreshVersion(state);
  return state;
}

export function decide(state: CallState, _event: CallEvent): Command[] {
  return state.commands;
}

/** The worker's VAD is exact; Recall's speech_off can lag, which is what the fallback timer covers. */
function stillSpeaking(state: CallState, speakerId: string): boolean {
  return state.policy.kind === 'voice' && !!state.speakers[speakerId]?.speaking;
}

function log(state: CallState, event: string, fields: Record<string, unknown>): void {
  state.commands.push({ kind: 'log', event, fields: { windowVersion: state.windowVersion, ...fields } });
}

/**
 * What `SpeakerState.handled` compares: a voice utterance is decided once; a meeting's again when its
 * words change, since Recall's boundary is a pause, not the end of the utterance.
 */
const handledKey = (state: CallState, utt: Utterance): string =>
  state.policy.kind === 'voice' ? utt.uttId : `${utt.uttId}\n${comparable(utt.text)}`;

/** A speaker finished an utterance: rules first, then Jev. Each utterance's words are decided once. */
function boundary(state: CallState, speakerId: string): void {
  const speaker = state.speakers[speakerId];
  const utt = latestUtterance(state, speakerId);
  if (!speaker || !utt || !hasWords(utt.text)) return;
  const key = handledKey(state, utt);
  if (speaker.handled === key) return;
  speaker.handled = key;

  const trigger = { trigger: utt.text, speaker: speaker.name };
  const { vocative, rest } = vocativeOf(utt.text, [state.policy.agentName, ...state.policy.agentAliases]);
  if (STOP_WORDS.has(rest)) {
    if (agentSpeaking(state) || pendingAnswer(state)) {
      stop(state);
      log(state, 'decision', { ...trigger, rule: 'stop', action: 'stop' });
      return;
    }
    if (vocative) {
      log(state, 'decision', { ...trigger, rule: 'stop', action: 'none', reason: 'nothing_to_stop' });
      return;
    }
  }
  if (vocative && hasWords(rest)) {
    log(state, 'decision', { ...trigger, rule: 'vocative', action: 'answer' });
    wake(state, speakerId, utt.text);
    return;
  }
  judge(state, speakerId, utt.text, false);
}

function judge(state: CallState, speakerId: string, trigger: string, retried: boolean): void {
  state.judging = { version: state.windowVersion, speakerId, trigger, seq: state.seq, retried };
  const latest = { speaker: state.speakers[speakerId]?.name ?? speakerId, text: trigger };
  state.commands.push({ kind: 'judge', windowVersion: state.windowVersion, state: toJevState(state, latest) });
}

function onVerdict(state: CallState, version: number, verdict: Verdict | null, ms: number): void {
  const judging = state.judging;
  if (!judging || judging.version !== version) {
    log(state, 'verdict_dropped', { verdictVersion: version, reason: 'superseded' });
    return;
  }
  state.judging = null;
  const speaker = state.speakers[judging.speakerId];
  const trigger = { trigger: judging.trigger, speaker: speaker?.name };

  if (version !== state.windowVersion) {
    const wokeSince = state.wakes.some((w) => w.seq > judging.seq);
    const utt = latestUtterance(state, judging.speakerId);
    if (
      !judging.retried &&
      !wokeSince &&
      speaker &&
      !stillSpeaking(state, judging.speakerId) &&
      utt &&
      hasWords(utt.text)
    ) {
      log(state, 'verdict_stale', { ...trigger, verdictVersion: version, action: 'rejudge' });
      speaker.handled = handledKey(state, utt);
      judge(state, judging.speakerId, utt.text, true);
    } else {
      log(state, 'verdict_stale', { ...trigger, verdictVersion: version, action: 'none' });
    }
    return;
  }

  if (!verdict) {
    log(state, 'decision', { ...trigger, jev: null, ms, action: 'stay_silent', reason: 'jev_failed' });
    return;
  }
  const action = chosen(state, verdict);
  log(state, 'decision', {
    ...trigger,
    jev: { choice: verdict.action, probabilities: verdict.probabilities, confidence: verdict.confidence },
    ms,
    action,
  });
  if (action === 'stop') stop(state);
  else if (action === 'answer') wake(state, judging.speakerId, judging.trigger);
  else if (action === 'continue') {
    const cutOff = `You were cut off after "${state.cutOffAfter ?? ''}"; ${speaker?.name ?? 'the caller'} asked you to go on. Continue briefly from there.`;
    wake(state, judging.speakerId, judging.trigger, cutOff);
  }
}

/** The action to take: `stop` and `continue` only when the facts allow them, each over its threshold. */
function chosen(state: CallState, verdict: Verdict): Action {
  const { thresholds } = state.policy;
  const over = (action: Exclude<Action, 'stay_silent'>) =>
    verdict.probabilities[action] >= thresholds[action].p && verdict.confidence >= thresholds[action].confidence;
  if ((agentSpeaking(state) || pendingAnswer(state)) && over('stop')) return 'stop';
  if (state.cutOffAfter !== null && !agentSpeaking(state) && over('continue')) return 'continue';
  if (over('answer')) return 'answer';
  return 'stay_silent';
}

function stop(state: CallState): void {
  state.stoppedSeq = state.seq;
  // Lines not started yet are no pending answer; the worker may have started one already, so its reports still count.
  for (const [replyId, entry] of Object.entries(state.playout)) {
    if (state.agentLines.some((l) => l.replyId === replyId && l.state === 'playing')) continue;
    state.stoppedPlayout[replyId] = entry;
    delete state.playout[replyId];
  }
  state.commands.push({ kind: 'stop_playback' });
}

function wake(state: CallState, speakerId: string, message: string, extra?: string): void {
  const prev = latestWake(state);
  const supersedes = prev && prev.turnId === null && !prev.dropped ? prev.key : undefined;
  if (prev && supersedes) prev.dropped = true;
  const key = `w${++state.wakeCount}`;
  const note = [
    `You are on a live ${state.policy.kind === 'voice' ? 'voice call' : 'meeting call'}. What was said, oldest first, each line labelled with its speaker:`,
    renderWindow(state),
    ...(extra ? [extra] : []),
    'Reply in one or two short spoken sentences; your reply is read aloud. If nothing needs saying, reply exactly [silent].',
  ].join('\n\n');
  state.wakes = [
    ...state.wakes,
    { key, speakerId, seq: state.seq, at: state.now, turnId: null, dropped: false, replied: false },
  ].slice(-WAKES_KEPT);
  state.cutOffAfter = null;
  state.commands.push({ kind: 'turn', key, message, note, ...(supersedes ? { supersedes } : {}) });
}

function onReply(state: CallState, replyId: string, turnId: string | null, raw: string): void {
  const text = raw.trim();
  const wake = turnId === null ? undefined : state.wakes.find((w) => w.turnId === turnId);
  if (wake) wake.replied = true;
  const fields = { replyId, turnId };

  if (text.toLowerCase() === '[silent]') {
    state.commands.push({ kind: 'drop', replyId });
    log(state, 'reply', { ...fields, outcome: 'dropped', reason: 'silent' });
    return;
  }
  const latest = latestWake(state);
  const reason =
    turnId === null
      ? 'unprompted'
      : !latest || latest.turnId !== turnId
        ? 'replaced'
        : state.stoppedSeq !== null && state.stoppedSeq > latest.seq
          ? 'stopped'
          : null;
  if (reason) {
    state.commands.push({ kind: 'show', replyId, text });
    log(state, 'reply', { ...fields, outcome: 'shown', reason });
    return;
  }
  state.playout[replyId] = { text, wakeKey: latest?.key ?? null };
  state.commands.push({ kind: 'speak', replyId, text });
  log(state, 'reply', { ...fields, outcome: 'speak' });
}

function logPlayback(state: CallState, event: Extract<CallEvent, { kind: 'playback' }>, wakeKey: string | null): void {
  const wake = state.wakes.find((w) => w.key === wakeKey);
  const names = state.utterances
    .filter((u) => wake && u.startedAt > wake.at)
    .map((u) => state.speakers[u.speakerId]?.name ?? u.speakerId);
  log(state, 'playback', {
    replyId: event.replyId,
    outcome: event.state === 'completed' ? 'spoken' : event.state,
    ...(event.state === 'cut_off' ? { delivered: event.delivered ?? '' } : {}),
    spoke_since_trigger: [...new Set(names)],
  });
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether `text` addresses the agent by one of `names` as a vocative ("Dan, ...", "hey Dan, ...",
 * "..., Dan?"), and the rest of it, lower-cased and without punctuation. A mention in the third
 * person ("Dan's result", "I told Dan") is no vocative.
 */
export function vocativeOf(text: string, names: string[]): { vocative: boolean; rest: string } {
  const said = normalize(text);
  for (const name of names.map(normalize).filter(Boolean)) {
    const n = escapeRegExp(name);
    const match =
      new RegExp(`^(?:hey )?${n}\\s*[,!:]\\s*(.*)$`, 'u').exec(said) ??
      new RegExp(`^(.*?)\\s*,\\s*${n}\\s*[.?!]*$`, 'u').exec(said);
    if (match) return { vocative: true, rest: unpunctuated(match[1]) };
  }
  // One-word names in another script or case form ("Ден, ...", "Дене, ...", "..., Ден?").
  const keys = new Set(names.filter((name) => !/\s/.test(name.trim())).map(nameKey));
  const lead = /^(?:(?:hey|hi|гей|хей|эй|привіт)\s+)?([\p{L}]+)\s*[,!:]\s*(.*)$/u.exec(said);
  if (lead && sameName(lead[1], keys)) return { vocative: true, rest: unpunctuated(lead[2]) };
  const tail = /^(.*?)\s*,\s*([\p{L}]+)\s*[.?!]*$/u.exec(said);
  if (tail && sameName(tail[2], keys)) return { vocative: true, rest: unpunctuated(tail[1]) };
  return { vocative: false, rest: unpunctuated(said) };
}

/** Cyrillic letters as Latin sounds (the worker's wake matching uses the same table). */
const CYRILLIC_LATIN: Record<string, string> = Object.fromEntries(
  'а:a б:b в:v г:h ґ:g д:d е:e є:ye ё:yo ж:zh з:z и:y і:i ї:yi й:y к:k л:l м:m н:n о:o п:p р:r с:s т:t у:u ф:f х:h ц:ts ч:ch ш:sh щ:shch ь: ъ: ы:y э:e ю:yu я:ya'
    .split(' ')
    .map((pair) => pair.split(':')),
);

/** A name's sound: Latin letters, every vowel one mark, doubled letters once (`Ден` and `Dan` agree). */
function nameKey(word: string): string {
  let latin = '';
  for (const ch of word.normalize('NFKC').toLowerCase()) latin += CYRILLIC_LATIN[ch] ?? ch;
  return latin
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/kh/g, 'h')
    .replace(/[aeiouy]/g, '*')
    .replace(/([^*])\1+/g, '$1');
}

/** A word is one of the names, also in a Cyrillic vocative case ending in -е or -у (`Дене`). */
function sameName(word: string, keys: Set<string>): boolean {
  if (keys.has(nameKey(word))) return true;
  return /^[\p{Script=Cyrillic}]{4,}$/u.test(word) && /[еу]$/u.test(word) && keys.has(nameKey(word.slice(0, -1)));
}
