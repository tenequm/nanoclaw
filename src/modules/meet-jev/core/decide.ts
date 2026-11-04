/**
 * The decisions of the jev call loop. A decision changes the state (a wake's key, the stop mark,
 * the judge in flight), so `reduce` makes it and records its commands in the state; `decide`
 * returns them. Replaying the event log through `reduce` reproduces every decision.
 */
import type { Action, CallEvent, Command, RecheckVerdict, Verdict } from './types.js';
import {
  agentSpeaking,
  applyWindow,
  floorTaken,
  hasWords,
  humansInRoom,
  isHandled,
  latestUtterance,
  latestWake,
  markHandled,
  normalize,
  pendingAnswer,
  refreshVersion,
  renderWindow,
  toJevState,
  toRecheckState,
  unmarkHandled,
  unpunctuated,
  utterancesSince,
  type CallState,
  type Wake,
} from './window.js';

const BOUNDARY_TIMER = 'boundary:';
/** A speaker's STT final comes up to ~3 s after their VAD end; a boundary waits that long for it. */
const FINAL_MARGIN_MS = 3_000;
const WAKES_KEPT = 8;
const STOP_WORDS = new Set([
  'stop',
  'wait',
  '\u0441\u0442\u043e\u043f',
  '\u0441\u0442\u0456\u0439',
  '\u0437\u0443\u043f\u0438\u043d\u0438\u0441\u044c',
  '\u043f\u043e\u0447\u0435\u043a\u0430\u0439',
  '\u0437\u0430\u0447\u0435\u043a\u0430\u0439',
]);

export function reduce(prev: CallState, event: CallEvent): CallState {
  const state = structuredClone<CallState>({ ...prev, commands: [] });
  applyWindow(state, event);
  const out = state.commands;
  switch (event.kind) {
    case 'utterance':
      // Both kinds decide on the final, which comes after the speaker's own VAD end (the worker's, or the
      // host's per-participant pipeline in a meeting). Only the current utterance's final is a boundary: a late
      // final of an older one updates the window and decides nothing.
      if (
        event.final &&
        state.speakers[event.speaker.id]?.lastUttId === event.uttId &&
        !stillSpeaking(state, event.speaker.id)
      )
        boundary(state, event.speaker.id);
      break;
    case 'speech':
      if (event.on) break;
      if (!latestUtterance(state, event.speaker.id)?.final) {
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
    case 'recheck_verdict':
      onRecheck(state, event.wakeKey, event.verdict, event.ms);
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

/** The VAD is exact: a speaker it still hears is not done, whatever a timer says. */
function stillSpeaking(state: CallState, speakerId: string): boolean {
  return !!state.speakers[speakerId]?.speaking;
}

function log(state: CallState, event: string, fields: Record<string, unknown>): void {
  state.commands.push({ kind: 'log', event, fields: { windowVersion: state.windowVersion, ...fields } });
}

/**
 * A speaker's boundary: their current utterance is decided, or, when it has nothing new and nobody speaks, an
 * utterance deferred while someone spoke is.
 */
function boundary(state: CallState, speakerId: string): void {
  if (decideLatest(state, speakerId)) return;
  const deferred = state.deferred;
  if (!deferred || floorTaken(state)) return;
  state.deferred = null;
  if (state.speakers[deferred.speakerId]?.lastUttId === deferred.uttId) decideLatest(state, deferred.speakerId);
}

/**
 * The stop rule first, then Jev, on the speaker's current utterance; false when it has no words or was decided
 * already. A vocative is a fact for Jev, not a wake: "Dan, wait for Anna" or an unfinished "Dan, I was
 * wondering" are Jev's to read; only a failed Jev call on one still wakes.
 */
function decideLatest(state: CallState, speakerId: string): boolean {
  const speaker = state.speakers[speakerId];
  const utt = latestUtterance(state, speakerId);
  if (!speaker || !utt || !hasWords(utt.text) || isHandled(speaker, utt.uttId)) return false;
  markHandled(speaker, utt.uttId);
  // A newer decision sees the deferred utterance in its window; it is not decided again after it.
  const deferred = state.deferred;
  if (deferred) {
    const owner = state.speakers[deferred.speakerId];
    if (owner) markHandled(owner, deferred.uttId);
    state.deferred = null;
  }

  const trigger = { trigger: utt.text, speaker: speaker.name };
  const { vocative, rest } = vocativeOf(utt.text, [state.policy.agentName, ...state.policy.agentAliases]);
  if (
    rest === 'please stop' ||
    rest === 'stop please' ||
    (rest.length > 0 &&
      rest
        .replace(/\bhold on\b/g, 'wait')
        .split(' ')
        .every((word) => STOP_WORDS.has(word)))
  ) {
    if (agentSpeaking(state) || pendingAnswer(state)) {
      stop(state);
      log(state, 'decision', { ...trigger, rule: 'stop', action: 'stop' });
      return true;
    }
    if (vocative) {
      log(state, 'decision', { ...trigger, rule: 'stop', action: 'none', reason: 'nothing_to_stop' });
      return true;
    }
  }
  // Someone else took the floor before this boundary: a verdict now would be deferred anyway, so Jev is not asked.
  if (floorTaken(state)) {
    unmarkHandled(speaker, utt.uttId);
    state.deferred = { speakerId, uttId: utt.uttId };
    log(state, 'boundary_deferred', trigger);
    return true;
  }
  judge(state, speakerId, utt.uttId, utt.text, false);
  return true;
}

/** The agent called by name with words after it ("Dan, ..."), not the name alone. */
function addressedByName(state: CallState, text: string): boolean {
  const { vocative, rest } = vocativeOf(text, [state.policy.agentName, ...state.policy.agentAliases]);
  return vocative && hasWords(rest);
}

function judge(state: CallState, speakerId: string, uttId: string, trigger: string, retried: boolean): void {
  const named = addressedByName(state, trigger);
  state.judging = {
    version: state.windowVersion,
    speakerId,
    uttId,
    trigger,
    addressedByName: named,
    seq: state.seq,
    retried,
  };
  const latest = { speaker: state.speakers[speakerId]?.name ?? speakerId, text: trigger };
  state.commands.push({
    kind: 'judge',
    windowVersion: state.windowVersion,
    state: toJevState(state, latest, named),
  });
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

  // The pause the verdict was asked on is over: acting now would talk into live speech, or start a turn on a
  // thought still being finished. The utterance stays undecided for the next boundary.
  if (floorTaken(state)) {
    if (speaker) unmarkHandled(speaker, judging.uttId);
    state.deferred = { speakerId: judging.speakerId, uttId: judging.uttId };
    log(state, 'verdict_deferred', { ...trigger, verdictVersion: version, choice: verdict?.action ?? null });
    return;
  }

  if (version !== state.windowVersion) {
    const wokeSince = state.wakes.some((w) => w.seq > judging.seq);
    const utt = latestUtterance(state, judging.speakerId);
    if (!judging.retried && !wokeSince && speaker && utt && hasWords(utt.text)) {
      log(state, 'verdict_stale', { ...trigger, verdictVersion: version, action: 'rejudge' });
      markHandled(speaker, utt.uttId);
      judge(state, judging.speakerId, utt.uttId, utt.text, true);
    } else {
      log(state, 'verdict_stale', { ...trigger, verdictVersion: version, action: 'none' });
    }
    return;
  }

  if (!verdict) {
    // Never deaf to its name: without Jev, a vocative wakes; anything else is silence.
    const action = judging.addressedByName ? 'answer' : 'stay_silent';
    log(state, 'decision', { ...trigger, jev: null, ms, action, reason: 'jev_failed' });
    if (action === 'answer') wake(state, judging.speakerId, judging.uttId, judging.trigger);
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
  else if (action === 'answer') wake(state, judging.speakerId, judging.uttId, judging.trigger);
  else if (action === 'continue') {
    const cutOff = `You were cut off after "${state.cutOffAfter ?? ''}"; ${speaker?.name ?? 'the caller'} asked you to go on. Continue briefly from there.`;
    wake(state, judging.speakerId, judging.uttId, judging.trigger, cutOff);
  }
}

/** The action to take: `stop` and `continue` only when the facts allow them, each over its threshold. */
function chosen(state: CallState, verdict: Verdict): Action {
  const { thresholds } = state.policy;
  const over = (action: Exclude<Action, 'stay_silent'>) => {
    const threshold =
      action === 'answer' && humansInRoom(state) <= 1 ? state.policy.oneCaller.answer : thresholds[action];
    return verdict.action === action && verdict.probabilities[action] >= threshold.p;
  };
  if ((agentSpeaking(state) || pendingAnswer(state)) && over('stop')) return 'stop';
  if (state.cutOffAfter !== null && !agentSpeaking(state) && over('continue')) return 'continue';
  if (over('answer')) return 'answer';
  return 'stay_silent';
}

/**
 * Take the lines not started yet out of `playout`: they are no pending answer. The worker may have started one
 * already, so its reports still count.
 */
function takeBackUnstarted(state: CallState): string[] {
  const taken: string[] = [];
  for (const [replyId, entry] of Object.entries(state.playout)) {
    if (state.agentLines.some((l) => l.replyId === replyId && l.state === 'playing')) continue;
    state.stoppedPlayout[replyId] = entry;
    delete state.playout[replyId];
    taken.push(replyId);
  }
  return taken;
}

/** The stop also answers a judge in flight: its verdict, asked before the stop, is dropped as superseded. */
function stop(state: CallState): void {
  state.stoppedSeq = state.seq;
  state.judging = null;
  endRecheck(state, 'stopped');
  takeBackUnstarted(state);
  state.commands.push({ kind: 'stop_playback' });
}

/**
 * A new turn for the agent. An answer to an older turn that has not started playing is revoked: the newer turn
 * replaces it. One already playing plays on; the reflex and a stop cover talking over it.
 */
function wake(state: CallState, speakerId: string, uttId: string, message: string, extra?: string): void {
  endRecheck(state, 'replaced');
  for (const replyId of takeBackUnstarted(state)) {
    state.commands.push({ kind: 'revoke', replyId });
    log(state, 'reply', { replyId, outcome: 'revoked', reason: 'replaced' });
  }
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
  const triggerAt = state.utterances.find((u) => u.speakerId === speakerId && u.uttId === uttId)?.startedAt;
  state.wakes = [
    ...state.wakes,
    {
      key,
      speakerId,
      seq: state.seq,
      at: state.now,
      turnId: null,
      dropped: false,
      replied: false,
      trigger: message,
      triggerAt: triggerAt ?? state.now,
      rechecked: null,
    },
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
  if (reason || !latest) {
    state.commands.push({ kind: 'show', replyId, text });
    log(state, 'reply', { ...fields, outcome: 'shown', reason });
    return;
  }
  // People spoke after the trigger: the answer may no longer be wanted. Ask Jev once before speaking (held
  // meanwhile; a stop or a newer wake shows it); nobody spoke, or the same people since the last check: no call.
  if (state.recheck?.wakeKey === latest.key) {
    state.recheck.replies.push({ replyId, text });
    log(state, 'reply', { ...fields, outcome: 'held', reason: 'recheck' });
    return;
  }
  const since = utterancesSince(state, latest).length;
  if (since > 0 && latest.rechecked?.since !== since) {
    state.recheck = { wakeKey: latest.key, since, replies: [{ replyId, text }] };
    state.commands.push({
      kind: 'recheck',
      windowVersion: state.windowVersion,
      wakeKey: latest.key,
      state: toRecheckState(state, latest, text),
    });
    log(state, 'reply', { ...fields, outcome: 'held', reason: 'recheck', since });
    return;
  }
  if (since > 0 && latest.rechecked?.outcome === 'show') {
    state.commands.push({ kind: 'show', replyId, text });
    log(state, 'reply', { ...fields, outcome: 'shown', reason: 'not_wanted' });
    return;
  }
  speak(state, replyId, text, latest);
}

function speak(state: CallState, replyId: string, text: string, wake: Wake): void {
  state.playout[replyId] = { text, wakeKey: wake.key };
  state.commands.push({ kind: 'speak', replyId, text });
  log(state, 'reply', { replyId, turnId: wake.turnId, outcome: 'speak' });
}

/** The answer-ready check's verdict: speak the held replies unless Jev is sure they are no longer wanted. */
function onRecheck(state: CallState, wakeKey: string, verdict: RecheckVerdict | null, ms: number): void {
  const recheck = state.recheck;
  // A stop or a newer wake already showed them.
  if (!recheck || recheck.wakeKey !== wakeKey) return;
  state.recheck = null;
  const wake = state.wakes.find((w) => w.key === wakeKey);
  const { p } = state.policy.recheckShow;
  const show = !wake || (!!verdict && verdict.action === 'show' && verdict.probabilities.show >= p);
  if (wake) wake.rechecked = { outcome: show ? 'show' : 'speak', since: recheck.since };
  log(state, 'recheck', {
    trigger: wake?.trigger,
    replyIds: recheck.replies.map((r) => r.replyId),
    jev: verdict && { choice: verdict.action, probabilities: verdict.probabilities, confidence: verdict.confidence },
    ms,
    outcome: show ? 'shown' : 'spoken',
    ...(verdict ? {} : { reason: 'jev_failed' }),
  });
  for (const { replyId, text } of recheck.replies) {
    if (show || !wake) state.commands.push({ kind: 'show', replyId, text });
    else speak(state, replyId, text, wake);
  }
}

/** A stop or a newer wake during the answer-ready check: its held replies are shown, and its verdict ignored. */
function endRecheck(state: CallState, reason: 'stopped' | 'replaced'): void {
  const recheck = state.recheck;
  if (!recheck) return;
  state.recheck = null;
  log(state, 'recheck', { replyIds: recheck.replies.map((r) => r.replyId), outcome: 'shown', reason });
  for (const { replyId, text } of recheck.replies) state.commands.push({ kind: 'show', replyId, text });
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
  const words = names.map(normalize).filter((name) => name && !/\s/.test(name));
  const lead = /^(?:(?:hey|hi|гей|хей|эй|привіт)\s+)?([\p{L}]+)\s*[,!:]\s*(.*)$/u.exec(said);
  if (lead && sameName(lead[1], words)) return { vocative: true, rest: unpunctuated(lead[2]) };
  const tail = /^(.*?)\s*,\s*([\p{L}]+)\s*[.?!]*$/u.exec(said);
  if (tail && sameName(tail[2], words)) return { vocative: true, rest: unpunctuated(tail[1]) };
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

const scriptOf = (word: string): 'cyrillic' | 'latin' | null =>
  /\p{Script=Cyrillic}/u.test(word) ? 'cyrillic' : /\p{Script=Latin}/u.test(word) ? 'latin' : null;

/**
 * A word is one of the (normalized, one-word) names: spelled the same in the same script, or sounding the same
 * across Cyrillic and Latin (`Ден` for `Dan`, never `Don` for `Dan`); also in a Cyrillic vocative case ending in
 * -е or -у (`Дене`).
 */
function sameName(word: string, names: string[]): boolean {
  const forms = /^[\p{Script=Cyrillic}]{4,}$/u.test(word) && /[еу]$/u.test(word) ? [word, word.slice(0, -1)] : [word];
  return forms.some((form) =>
    names.some((name) => {
      const [a, b] = [scriptOf(form), scriptOf(name)];
      return a !== null && b !== null && a !== b ? nameKey(form) === nameKey(name) : form === name;
    }),
  );
}
