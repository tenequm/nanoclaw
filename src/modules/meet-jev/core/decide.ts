/**
 * The decisions of the jev call loop. A decision changes the state (a wake's key, the stop mark,
 * the judge in flight), so `reduce` makes it and records its commands in the state; `decide`
 * returns them. Replaying the event log through `reduce` reproduces every decision.
 */
import type { Action, CallEvent, Command, RecheckVerdict, SessionStamp, Verdict } from './types.js';
import {
  agentSpeaking,
  applyWindow,
  awaitingAgent,
  floorTaken,
  hasWords,
  humansInRoom,
  isHandled,
  latestUtterance,
  latestWake,
  markHandled,
  normalize,
  openTurn,
  pendingAnswer,
  recordShown,
  refreshVersion,
  renderWindow,
  takesTurn,
  toJevState,
  toRecheckState,
  unmarkHandled,
  unpunctuated,
  unstartedWake,
  utterancesSince,
  type CallState,
  type ListenPiece,
  type Wake,
} from './window.js';

const PIECE_TIMER = 'listen-piece:';
const MARKER_OWN_SENTENCE = false;
const BOUNDARY_TIMER = 'boundary:';
const HOLD_TIMER = 'hold:';
/** A speaker's STT final comes up to ~3 s after their VAD end; a boundary waits that long for it. */
const FINAL_MARGIN_MS = 3_000;
/** Quiet after a held turn was judged to need no new answer, before its pending answer is released. */
const HOLD_RELEASE_MS = 3_000;
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
  // A retried POST can replay a final the host already has: it changes nothing.
  if (repeatsFinal(state, event)) return state;
  if (state.hangingUp && !['speech', 'utterance', 'hangup', 'timer'].includes(event.kind)) return state;
  if (
    state.afterListen &&
    (event.kind === 'listen' ||
      (event.kind === 'speech' && !endsDraftSpeech(state, event)) ||
      (event.kind === 'utterance' && !state.listenDraft?.some((piece) => piece.uttId === event.uttId)))
  ) {
    state.afterListen.push(event);
    return state;
  }
  applyWindow(state, event);
  if (!state.listenDraft && (event.kind === 'speech' || event.kind === 'utterance')) holdContinuation(state, event);
  if (event.kind === 'utterance' && event.final && continuationFor(state, event.speaker.id)) {
    const previous = latestUtterance(prev, event.speaker.id);
    if (previous?.uttId === event.uttId && previous.final && previous.text !== event.text.trim())
      unmarkHandled(state.speakers[event.speaker.id], event.uttId);
  }
  const out = state.commands;
  switch (event.kind) {
    case 'listen':
      if (state.policy.kind === 'voice') setListening(state, event.on);
      break;
    case 'hangup':
      if (!state.listenDraft) break;
      if (event.draining) {
        state.hangingUp = true;
      } else {
        for (const piece of state.listenDraft) piece.final = true;
        releaseMarkers(state);
        flushDraft(state, state.listenDraft.splice(0), !state.afterListen);
      }
      break;
    case 'overlap': {
      const latest = { speaker: event.speaker.name, text: event.text };
      const input = toJevState(state, latest, addressedByName(state, event.text));
      // Only the prefix already heard belongs in the playing line.
      for (const line of input.window) if (line.agent && line.partial) line.text = event.played;
      out.push({ kind: 'overlap', requestId: event.requestId, windowVersion: state.windowVersion, state: input });
      break;
    }
    case 'utterance':
      if (state.listenDraft) {
        capturePiece(state, event.speaker.id, event.uttId, event);
        break;
      }
      if (event.contextOnly) {
        // Words held over an older line settle a held piece too: its bounded hold starts from this final.
        if (event.final && continuationFor(state, event.speaker.id) && !stillSpeaking(state, event.speaker.id))
          boundary(state, event.speaker.id);
        break;
      }
      if (event.final && hasWords(event.text)) out.push({ kind: 'status', status: 'heard' });
      // An older final can settle the last open piece of a pending turn.
      if (
        event.final &&
        (state.speakers[event.speaker.id]?.lastUttId === event.uttId || continuationFor(state, event.speaker.id)) &&
        !stillSpeaking(state, event.speaker.id)
      )
        boundary(state, event.speaker.id);
      break;
    case 'speech': {
      if (state.listenDraft) {
        // A new speech also ends any earlier activity whose VAD-off POST was lost.
        for (const piece of state.listenDraft) armPiece(state, piece);
        if (event.on && event.uttId) capturePiece(state, event.speaker.id, event.uttId);
        break;
      }
      if (event.on) break;
      const held = continuationFor(state, event.speaker.id);
      if (
        !latestUtterance(state, event.speaker.id)?.final ||
        (held && continuationPieces(state, held).some((u) => !u.final))
      ) {
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
    }
    case 'timer': {
      const piece = event.key.startsWith(PIECE_TIMER)
        ? state.listenDraft?.find((item) => item.uttId === event.key.slice(PIECE_TIMER.length))
        : undefined;
      if (piece) delete piece.settling;
      // A piece still being said is timed again from its speech-off.
      if (piece && !piece.final && !beingSaid(state, piece)) {
        capturePiece(state, piece.speakerId, piece.uttId, { text: piece.text, final: true });
      }
      // A listening draft settles only through its own pieces; turn boundaries and holds wait for its release.
      if (state.listenDraft) break;
      if (event.key.startsWith(BOUNDARY_TIMER)) {
        const speakerId = event.key.slice(BOUNDARY_TIMER.length);
        if (stillSpeaking(state, speakerId)) break;
        // A lost final must not hold the turn: its piece counts as said so far.
        const held = continuationFor(state, speakerId);
        if (held) for (const piece of continuationPieces(state, held)) piece.final = true;
        boundary(state, speakerId);
      } else if (event.key.startsWith(HOLD_TIMER)) {
        const held = latestWake(state);
        // The held speaker's own speech is timed again by their next boundary.
        if (!held?.continuation || event.key !== HOLD_TIMER + held.key || stillSpeaking(state, held.speakerId)) break;
        const pieces = continuationPieces(state, held);
        const latest = latestUtterance(state, held.speakerId);
        // The handled mark, not `state.deferred`: another speaker's decision or deferral can take that slot.
        const undecided =
          !!latest &&
          pieces.includes(latest) &&
          !latest.contextOnly &&
          !isHandled(state.speakers[held.speakerId], latest.uttId) &&
          // A wordless piece adds nothing to a merged turn Jev already judged.
          (hasWords(latest.text) || openTurnOf(state, held.speakerId).text !== held.judged);
        if (undecided) {
          // Words still undecided wait for the floor and any judge in flight; that verdict reaches them itself.
          if (floorTaken(state) || state.judging) holdBriefly(state, held.speakerId);
          else boundary(state, held.speakerId);
        } else if (state.judging?.speakerId !== held.speakerId && pieces.every((u) => u.final)) release(state, held);
      }
      break;
    }
    case 'verdict':
      onVerdict(state, event.windowVersion, event.verdict, event.ms);
      // A different participant's judge may have taken the floor while the original speaker finished.
      if (prev.judging && !state.judging && !floorTaken(state)) {
        const wake = latestWake(state);
        if (wake?.continuation && prev.judging.speakerId !== wake.speakerId) boundary(state, wake.speakerId);
      }
      break;
    case 'recheck_verdict':
      onRecheck(state, event.wakeKey, event.verdict, event.ms);
      break;
    case 'turn': {
      const wake = state.wakes.find((w) => w.key === event.key);
      if (wake) {
        wake.turnId = event.turnId;
        wake.stored = event.stored;
      }
      break;
    }
    case 'turn_failed': {
      const wake = state.wakes.find((w) => w.key === event.key);
      if (wake) wake.dropped = true;
      if (wake && wake === latestWake(state)) out.push({ kind: 'status', status: 'idle' });
      log(state, 'turn_failed', { key: event.key, reason: event.reason });
      break;
    }
    case 'reply':
      onReply(state, event.replyId, event.turnId, event.text, event.produced);
      break;
    case 'playback': {
      const playing = prev.playout[event.replyId] ?? prev.stoppedPlayout[event.replyId];
      // An older line that ends, or was revoked, says nothing about the turn the agent still works on.
      if (playing) {
        const over = !state.listenDraft && awaitingAgent(state) ? 'thinking' : 'idle';
        out.push({ kind: 'status', status: event.state === 'started' ? 'speaking' : over });
      }
      if (playing && event.state !== 'started') logPlayback(state, event, playing.wakeKey);
      break;
    }
    case 'play_ready': {
      const line = state.playout[event.replyId];
      if (line) {
        line.requestId = event.requestId;
        // The worker did not play the grant (speech came first) and waits again.
        delete line.granted;
      }
      break;
    }
    case 'chat':
      break;
  }
  const pending = latestWake(state);
  if (pending?.continuation && !pendingAnswer(state)) endHold(pending);
  if (!pending?.continuation) {
    for (const [replyId, line] of Object.entries(state.playout)) {
      if (!line.requestId || line.held) continue;
      out.push({ kind: 'allow_play', replyId, requestId: line.requestId });
      delete line.requestId;
      line.granted = true;
    }
  }
  refreshVersion(state);
  if (state.afterListen && state.listenDraft?.every((piece) => piece.final)) {
    flushDraft(state, state.listenDraft.splice(0), false);
    state.listenDraft = null;
    const queued = state.afterListen;
    delete state.afterListen;
    if (!state.hangingUp && awaitingAgent(state)) out.push({ kind: 'status', status: 'thinking' });
    let nextState = state;
    for (const next of queued) {
      nextState = reduce(nextState, next);
      out.push(...nextState.commands);
    }
    nextState.commands = out;
    return nextState;
  }
  return state;
}

export function decide(state: CallState, _event: CallEvent): Command[] {
  return state.commands;
}

function isStop(rest: string): boolean {
  return (
    rest === 'please stop' ||
    rest === 'stop please' ||
    (rest.length > 0 &&
      rest
        .replace(/\bhold on\b/g, 'wait')
        .split(' ')
        .every((word) => STOP_WORDS.has(word)))
  );
}

function setListening(state: CallState, on: boolean): void {
  if (on === !!state.listenDraft) return;
  if (!on) {
    state.afterListen = [];
    // The activity still being said settles from its own speech-off, which passes the queue.
    for (const piece of state.listenDraft!) if (!beingSaid(state, piece)) armPiece(state, piece);
    return;
  }
  state.listenDraft = [];
  state.commands.push({ kind: 'status', status: agentSpeaking(state) ? 'speaking' : 'idle' });
  const judging = state.judging;
  state.judging = null;
  state.deferred = null;
  if (judging) unmarkHandled(state.speakers[judging.speakerId], judging.uttId);
  for (const [id, speaker] of Object.entries(state.speakers)) {
    if (speaker.pendingSpeech) capturePiece(state, id, speaker.pendingSpeech.uttId);
  }
  for (const utt of state.utterances) {
    if (!utt.final || (utt.uttId === judging?.uttId && utt.speakerId === judging.speakerId))
      capturePiece(state, utt.speakerId, utt.uttId, utt);
  }
  const wake = latestWake(state);
  if (wake) {
    // Lines held for the continuation are queued already and play once it ends; the rest are spoken now.
    const held = state.recheck?.replies ?? [];
    state.recheck = null;
    endHold(wake);
    for (const reply of held) {
      const line = state.playout[reply.replyId];
      if (line) delete line.held;
      else if (!reply.queued) onReply(state, reply.replyId, wake.turnId, reply.text);
    }
  }
}

function flushDraft(state: CallState, pieces: ListenPiece[], hangup: boolean): void {
  const last = pieces.at(-1);
  if (!last) return;
  const text = pieces
    .map((piece) => piece.text)
    .filter(hasWords)
    .join(' ');
  for (const piece of pieces) {
    markHandled(state.speakers[piece.speakerId], piece.uttId);
  }
  if (!text) return;
  if (hangup) state.commands.push({ kind: 'post_caller', text });
  else wake(state, last.speakerId, last.uttId, text);
}

function capturePiece(
  state: CallState,
  speakerId: string,
  uttId: string,
  transcript?: { text: string; final: boolean; contextOnly?: boolean },
): void {
  const draft = state.listenDraft!;
  if (isHandled(state.speakers[speakerId], uttId)) return;
  let piece = draft.find((item) => item.uttId === uttId);
  if (!piece) {
    const pending = state.speakers[speakerId].pendingSpeech;
    const startedAt =
      pending?.uttId === uttId
        ? pending.startedAt
        : (state.utterances.find((u) => u.speakerId === speakerId && u.uttId === uttId)?.startedAt ?? state.now);
    piece = { speakerId, uttId, startedAt, text: '', final: false, interrupted: agentSpeaking(state) };
    draft.push(piece);
    draft.sort((a, b) => a.startedAt - b.startedAt);
  }
  if (!transcript) {
    if (!stillSpeaking(state, speakerId)) armPiece(state, piece);
    return;
  }
  // A settled piece stays settled: a later partial or held overlap final cannot reopen it.
  if (piece.final && (!transcript.final || transcript.contextOnly)) return;
  // A held overlap can become dictation after the worker reports a cut. Until then it has no draft words.
  piece.text = transcript.contextOnly ? '' : transcript.text.trim();
  piece.final = transcript.final && !transcript.contextOnly;
  if (!piece.final) {
    if (!stillSpeaking(state, speakerId)) armPiece(state, piece);
    return;
  }
  if (
    (piece.interrupted || agentSpeaking(state) || pendingAnswer(state)) &&
    isStop(vocativeOf(piece.text, [state.policy.agentName, ...state.policy.agentAliases]).rest)
  ) {
    if (!state.hangingUp) stop(state);
    markHandled(state.speakers[speakerId], uttId);
    draft.splice(draft.indexOf(piece), 1);
  } else {
    const rest = beforeMarker(piece.text, state.policy.overWords ?? []);
    piece.releases = rest !== null;
    if (rest !== null) piece.text = rest;
  }
  releaseMarkers(state);
}

/** The speaker is still saying this piece: its VAD is on and it is their latest activity. */
function beingSaid(state: CallState, piece: ListenPiece): boolean {
  return stillSpeaking(state, piece.speakerId) && state.speakers[piece.speakerId]?.pendingSpeech?.uttId === piece.uttId;
}

/** A speech-off that ends a draft piece's activity after a toggle-off: it settles that piece, so it is not queued. */
function endsDraftSpeech(state: CallState, event: Extract<CallEvent, { kind: 'speech' }>): boolean {
  return (
    !event.on && !!state.listenDraft?.some((piece) => piece.speakerId === event.speaker.id && beingSaid(state, piece))
  );
}

function repeatsFinal(state: CallState, event: CallEvent): boolean {
  if (event.kind !== 'utterance' || !event.final) return false;
  const utt = state.utterances.find((u) => u.speakerId === event.speaker.id && u.uttId === event.uttId);
  return !!utt?.final && utt.text === event.text.trim() && !!utt.contextOnly === !!event.contextOnly;
}

function armPiece(state: CallState, piece: ListenPiece): void {
  if (piece.final || piece.settling) return;
  piece.settling = true;
  state.commands.push({
    kind: 'wait',
    key: PIECE_TIMER + piece.uttId,
    ms: state.policy.boundaryFallbackMs + FINAL_MARGIN_MS,
  });
}

function releaseMarkers(state: CallState): void {
  const draft = state.listenDraft!;
  // A later activity can finalize first. A marker only releases through its own position.
  for (let i = 0; i < draft.length && draft[i].final; i++) {
    if (!draft[i].releases) continue;
    flushDraft(state, draft.splice(0, i + 1), false);
    i = -1;
  }
}

export function beforeMarker(text: string, markers: string[], ownSentence = MARKER_OWN_SENTENCE): string | null {
  let rest = text;
  let matched = false;
  // Keep sentence punctuation between words until every repeated marker has been examined.
  for (;;) {
    const end = rest.replace(/[\s\p{P}]+$/gu, '');
    const marker = markers.find(
      (word) => word.length && new RegExp(`(?:^|[\\s\\p{P}])${escapeRegExp(word)}$`, 'iu').test(end),
    );
    if (!marker) break;
    const before = end.slice(0, -marker.length);
    if (/[-\u2010\u2011]$/u.test(before)) break;
    if (ownSentence && !/(^|[.!?,;:\u2013\u2014-])\s*$/u.test(before)) break;
    rest = before;
    matched = true;
  }
  return matched ? rest.replace(/[\s,;:\u2013\u2014-]+$/gu, '') : null;
}

function continuationFor(state: CallState, speakerId: string): Wake | undefined {
  const wake = latestWake(state);
  return wake?.continuation && wake.speakerId === speakerId ? wake : undefined;
}

/** A speaker can extend their wake until its first audio. Other speakers keep the usual recheck. */
function holdContinuation(state: CallState, event: Extract<CallEvent, { kind: 'speech' | 'utterance' }>): void {
  const wake = unstartedWake(state, event.speaker.id);
  if (!wake || wake.continuation) return;
  if (event.kind === 'speech') {
    // Without an uttId no final can settle the speech.
    if (!event.on || !event.uttId) return;
  } else {
    const utt = latestUtterance(state, wake.speakerId);
    if (utt?.uttId !== event.uttId || !continuationPieces(state, wake).includes(utt)) return;
  }
  wake.continuation = true;
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
  const wake = continuationFor(state, speakerId);
  if (!wake) {
    if (!decideLatest(state, speakerId)) decideDeferred(state);
    return;
  }
  const current = latestUtterance(state, speakerId);
  const pieces = continuationPieces(state, wake);
  if (!current || !pieces.includes(current) || pieces.some((u) => !u.final)) return;
  const speaker = state.speakers[speakerId];
  // This boundary decides the speaker's own deferred piece too.
  if (state.deferred?.speakerId === speakerId && !floorTaken(state)) state.deferred = null;
  if (!pieces.some((u) => takesTurn(u.text))) {
    markHandled(speaker, current.uttId);
    release(state, wake);
    return;
  }
  if (hasWords(current.text)) {
    if (!decideLatest(state, speakerId)) decideDeferred(state);
  } else if (floorTaken(state)) {
    // Decided again through this boundary once the floor is free; a worded piece deferred before it stays.
    if (state.deferred?.speakerId !== speakerId) state.deferred = { speakerId, uttId: current.uttId };
  } else if (!isHandled(speaker, current.uttId)) {
    // A wordless last activity can settle after a substantive fragment from the same turn; it adds nothing to a
    // merged turn Jev already found needs no new answer.
    markHandled(speaker, current.uttId);
    if (openTurnOf(state, speakerId).text !== wake.judged) judge(state, speakerId, current.uttId, false);
  }
  // Nothing on its way decides the hold (no judge for this speaker): it ends after the quiet, bounded.
  if (continuationFor(state, speakerId) && state.judging?.speakerId !== speakerId) holdBriefly(state, speakerId, false);
}

/** An utterance deferred while someone spoke, decided once the floor is free; a held speaker's through their boundary. */
function decideDeferred(state: CallState): void {
  const deferred = state.deferred;
  if (!deferred || floorTaken(state)) return;
  state.deferred = null;
  if (continuationFor(state, deferred.speakerId)) boundary(state, deferred.speakerId);
  else if (state.speakers[deferred.speakerId]?.lastUttId === deferred.uttId) decideLatest(state, deferred.speakerId);
}

/**
 * The stop rule first, then Jev, on the speaker's current utterance; false when it has no words or was decided
 * already. A vocative is a fact for Jev, not a wake: "Dan, wait for Anna" or an unfinished "Dan, I was
 * wondering" are Jev's to read; only a failed Jev call on one still wakes.
 */
function decideLatest(state: CallState, speakerId: string): boolean {
  const speaker = state.speakers[speakerId];
  const utt = latestUtterance(state, speakerId);
  if (!speaker || !utt || utt.contextOnly || !hasWords(utt.text) || isHandled(speaker, utt.uttId)) return false;
  markHandled(speaker, utt.uttId);
  // A newer decision sees the deferred utterance in its window; it is not decided again after it.
  const deferred = state.deferred;
  if (deferred) {
    const owner = state.speakers[deferred.speakerId];
    if (owner && !continuationFor(state, deferred.speakerId)) markHandled(owner, deferred.uttId);
    state.deferred = null;
  }

  const names = [state.policy.agentName, ...state.policy.agentAliases];
  const piece = { trigger: utt.text, speaker: speaker.name };
  const { vocative, rest } = vocativeOf(utt.text, names);
  if (isStop(rest)) {
    if (agentSpeaking(state) || pendingAnswer(state)) {
      speaker.closedAt = utt.startedAt;
      stop(state);
      log(state, 'decision', { ...piece, rule: 'stop', action: 'stop' });
      return true;
    }
    if (vocative) {
      speaker.closedAt = utt.startedAt;
      log(state, 'decision', { ...piece, rule: 'stop', action: 'none', reason: 'nothing_to_stop' });
      return true;
    }
  }
  const trigger = { trigger: openTurnOf(state, speakerId).text, speaker: speaker.name };
  // Someone else took the floor before this boundary: a verdict now would be deferred anyway, so Jev is not asked.
  if (floorTaken(state)) {
    unmarkHandled(speaker, utt.uttId);
    state.deferred = { speakerId, uttId: utt.uttId };
    log(state, 'boundary_deferred', trigger);
    return true;
  }
  // One caller saying only the name is checking the agent is there; mid-answer it is Jev's to read.
  if (humansInRoom(state) <= 1 && nameAlone(utt.text, names) && !agentSpeaking(state) && !pendingAnswer(state)) {
    log(state, 'decision', { ...trigger, rule: 'name_alone', action: 'answer' });
    wake(state, speakerId, utt.uttId, trigger.trigger);
    return true;
  }
  judge(state, speakerId, utt.uttId, false);
  return true;
}

function continuationPieces(state: CallState, wake: Wake) {
  const trigger = state.utterances.findIndex((u) => u.speakerId === wake.speakerId && u.uttId === wake.triggerUttId);
  return state.utterances
    .filter(
      (u, i) =>
        u.speakerId === wake.speakerId &&
        (u.startedAt > wake.triggerAt || (u.startedAt === wake.triggerAt && i > trigger)),
    )
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** The speaker's open turn as one text, and whether any of it calls the agent by name with words after. */
function openTurnOf(state: CallState, speakerId: string): { text: string; named: boolean } {
  const wake = latestWake(state);
  const pieces =
    wake?.continuation && wake.speakerId === speakerId
      ? [
          wake.trigger,
          ...continuationPieces(state, wake)
            .filter((u) => hasWords(u.text))
            .map((u) => u.text),
        ]
      : openTurn(state, speakerId).map((utterance) => utterance.text);
  const text = pieces.join(' ');
  return { text, named: [...pieces, text].some((said) => addressedByName(state, said)) };
}

/** The agent called by name with words after it ("Dan, ..."), not the name alone. */
function addressedByName(state: CallState, text: string): boolean {
  const { vocative, rest } = vocativeOf(text, [state.policy.agentName, ...state.policy.agentAliases]);
  return vocative && hasWords(rest);
}

function judge(state: CallState, speakerId: string, uttId: string, retried: boolean): void {
  const previous = state.judging;
  if (previous && previous.speakerId !== speakerId && continuationFor(state, previous.speakerId)) {
    unmarkHandled(state.speakers[previous.speakerId], previous.uttId);
  }
  const { text: trigger, named } = openTurnOf(state, speakerId);
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
    holdBriefly(state, judging.speakerId, false);
    return;
  }

  const wakeInProgress = latestWake(state);
  if (wakeInProgress?.continuation && wakeInProgress.speakerId === judging.speakerId) {
    const current = latestUtterance(state, judging.speakerId);
    if (!current?.final || current.uttId !== judging.uttId) return;
  }
  if (version !== state.windowVersion) {
    const wokeSince = state.wakes.some((w) => w.seq > judging.seq);
    const utt = latestUtterance(state, judging.speakerId);
    if (!judging.retried && !wokeSince && speaker && utt && hasWords(utt.text)) {
      log(state, 'verdict_stale', { ...trigger, verdictVersion: version, action: 'rejudge' });
      markHandled(speaker, utt.uttId);
      judge(state, judging.speakerId, utt.uttId, true);
    } else {
      log(state, 'verdict_stale', { ...trigger, verdictVersion: version, action: 'none' });
      holdBriefly(state, judging.speakerId);
    }
    return;
  }

  if (!verdict) {
    // Never deaf to its name: without Jev, a vocative wakes; anything else is silence.
    const action = judging.addressedByName ? 'answer' : 'stay_silent';
    log(state, 'decision', { ...trigger, jev: null, ms, action, reason: 'jev_failed' });
    if (action === 'answer') wake(state, judging.speakerId, judging.uttId, judging.trigger);
    else {
      // Without Jev a held answer goes the usual way: checked if people spoke, spoken if that check fails too.
      const held = continuationFor(state, judging.speakerId);
      if (held) release(state, held);
    }
    return;
  }
  const action = chosen(state, verdict, judging.addressedByName);
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
  } else {
    const held = continuationFor(state, judging.speakerId);
    if (held) held.judged = judging.trigger;
    holdBriefly(state, judging.speakerId);
  }
}

/**
 * A held turn that needs no new answer: its pending answer is released after HOLD_RELEASE_MS of quiet. Only a new
 * verdict (`fresh`) restarts that time; anything else keeps the deadline already set.
 */
function holdBriefly(state: CallState, speakerId: string, fresh = true): void {
  const held = continuationFor(state, speakerId);
  if (!held) return;
  if (fresh || held.holdUntil === undefined) held.holdUntil = state.now + HOLD_RELEASE_MS;
  state.commands.push({ kind: 'wait', key: HOLD_TIMER + held.key, ms: Math.max(0, held.holdUntil - state.now) });
}

/** The hold on a wake ends: a hold opened again later gets its full quiet. */
function endHold(wake: Wake): void {
  delete wake.continuation;
  delete wake.holdUntil;
}

/**
 * The hold on a wake ends without a new turn: its queued lines play, after the answer-ready check when people
 * spoke since the trigger.
 */
function release(state: CallState, wake: Wake): void {
  endHold(wake);
  // A granted line is on its way to the room: nothing to hold back.
  const queued = Object.entries(state.playout).filter(
    ([replyId, line]) =>
      line.wakeKey === wake.key &&
      !line.granted &&
      !state.agentLines.some((l) => l.replyId === replyId && l.state === 'playing'),
  );
  const since = sinceTrigger(state, wake);
  if (queued.length === 0 || since === 0) return;
  if (state.recheck || wake.rechecked?.since !== since) {
    for (const [, line] of queued) line.held = true;
    const replies = queued.map(([replyId, line]) => ({ replyId, text: line.text, queued: true as const }));
    if (state.recheck) {
      const asked = new Set(state.recheck.replies.map((r) => r.replyId));
      state.recheck.replies.push(...replies.filter((r) => !asked.has(r.replyId)));
      return;
    }
    state.recheck = { wakeKey: wake.key, since, replies };
    state.commands.push({
      kind: 'recheck',
      windowVersion: state.windowVersion,
      wakeKey: wake.key,
      state: toRecheckState(state, wake, replies[0].text),
    });
    log(state, 'reply', { replyIds: replies.map((r) => r.replyId), outcome: 'held', reason: 'recheck', since });
    return;
  }
  if (wake.rechecked.outcome === 'show') for (const [replyId] of queued) revokeQueued(state, replyId);
}

/** Take back a queued line that is no longer wanted: the worker reports it cut off with nothing delivered. */
function revokeQueued(state: CallState, replyId: string): void {
  state.stoppedPlayout[replyId] = state.playout[replyId];
  delete state.playout[replyId];
  state.commands.push({ kind: 'revoke', replyId });
  log(state, 'reply', { replyId, outcome: 'revoked', reason: 'not_wanted' });
}

/** Utterances since the wake's trigger that could change whether its answer is wanted. */
const sinceTrigger = (state: CallState, wake: Wake): number =>
  utterancesSince(state, wake).filter((u) => wake.started || u.speakerId !== wake.speakerId || takesTurn(u.text))
    .length;

/**
 * The action to take: `stop` and `continue` only when the facts allow them, each over its threshold. Answering
 * a lone human or a vocative is low-risk, so both take the one-caller bar; named hold-backs score near zero.
 */
function chosen(state: CallState, verdict: Verdict, addressedByName: boolean): Action {
  const { thresholds, oneCaller } = state.policy;
  const alone = humansInRoom(state) <= 1;
  const lowRisk = alone || addressedByName;
  const busy = agentSpeaking(state) || pendingAnswer(state);
  const over = (action: Exclude<Action, 'stay_silent'>) => {
    const threshold =
      action === 'answer' && lowRisk
        ? oneCaller.answer
        : action === 'continue' && alone
          ? oneCaller.continue
          : thresholds[action];
    return verdict.action === action && verdict.probabilities[action] >= threshold.p;
  };
  if (busy && over('stop')) return 'stop';
  if (state.cutOffAfter !== null && !agentSpeaking(state) && over('continue')) return 'continue';
  if (over('answer')) return 'answer';
  // One human has nobody else to talk to: a fair chance of `answer` is enough while the agent is idle.
  if (alone && !busy && verdict.action !== 'stop' && verdict.probabilities.answer >= oneCaller.speak.p) return 'answer';
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
  state.commands.push({ kind: 'stop_playback' }, { kind: 'status', status: 'idle' });
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
  const supersedes = !state.listenDraft && prev && prev.turnId === null && !prev.dropped ? prev.key : undefined;
  if (prev && supersedes) prev.dropped = true;
  const key = `w${++state.wakeCount}`;
  const note = [
    ...(state.listenDraft
      ? ['You are on a live voice call.']
      : [
          `You are on a live ${state.policy.kind === 'voice' ? 'voice call' : 'meeting call'}. What was said, oldest first, each line labelled with its speaker:`,
          renderWindow(state),
        ]),
    ...(extra ? [extra] : []),
    state.listenDraft
      ? 'Reply in one or two short spoken sentences. Your reply is read aloud.'
      : 'Reply in one or two short spoken sentences; your reply is read aloud. If nothing needs saying, reply exactly [silent].',
  ].join('\n\n');
  const triggerAt = state.utterances.find((u) => u.speakerId === speakerId && u.uttId === uttId)?.startedAt;
  const speaker = state.speakers[speakerId];
  if (speaker) speaker.closedAt = triggerAt ?? state.now;
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
      triggerUttId: uttId,
      rechecked: null,
    },
  ].slice(-WAKES_KEPT);
  state.cutOffAfter = null;
  if (!state.listenDraft) state.commands.push({ kind: 'status', status: 'thinking' });
  state.commands.push({ kind: 'turn', key, message, note, ...(supersedes ? { supersedes } : {}) });
}

function onReply(state: CallState, replyId: string, turnId: string | null, raw: string, produced?: SessionStamp): void {
  const text = raw.trim();
  const silent = text.toLowerCase() === '[silent]';
  const tagged = turnId === null ? undefined : state.wakes.find((w) => w.turnId === turnId);
  const latest = latestWake(state);
  // A runner that takes a newer request into its running turn keeps the older tag. A further reply to a turn that
  // already had its answer, written after the newer turn was stored in the same session, answers the newer one.
  const retagged =
    !silent &&
    !!tagged?.replied &&
    !tagged.dropped &&
    tagged !== latest &&
    !!latest?.stored &&
    awaitingAgent(state) &&
    !!produced &&
    produced.sessionId === latest.stored.sessionId &&
    tagged.stored?.sessionId === produced.sessionId &&
    produced.at > latest.stored.at;
  const wake = retagged ? latest : tagged;
  if (wake) wake.replied = true;
  const fields = { replyId, turnId, ...(retagged ? { answeringTurnId: wake?.turnId } : {}) };

  if (silent) {
    if (wake && wake === latest) state.commands.push({ kind: 'status', status: 'idle' });
    state.commands.push({ kind: 'drop', replyId });
    log(state, 'reply', { ...fields, outcome: 'dropped', reason: 'silent' });
    return;
  }
  const reason =
    turnId === null
      ? 'unprompted'
      : !latest || wake !== latest
        ? 'replaced'
        : state.stoppedSeq !== null && state.stoppedSeq > latest.seq
          ? 'stopped'
          : null;
  if (reason || !latest) {
    showReply(state, replyId, text);
    log(state, 'reply', { ...fields, outcome: 'shown', reason });
    return;
  }
  if (state.listenDraft) {
    speak(state, replyId, text, latest, fields);
    return;
  }
  // Synthesized meanwhile: its first audio waits for the boundary of the turn the speaker is still finishing.
  if (latest.continuation) {
    speak(state, replyId, text, latest, { ...fields, outcome: 'held', reason: 'continuation' });
    return;
  }
  if (state.recheck?.wakeKey === latest.key) {
    state.recheck.replies.push({ replyId, text });
    log(state, 'reply', { ...fields, outcome: 'held', reason: 'recheck' });
    return;
  }
  // People spoke after the trigger: the answer may no longer be wanted. Ask Jev once before speaking (held
  // meanwhile; a stop or a newer wake shows it); nobody spoke, or the same people since the last check: no call.
  const since = sinceTrigger(state, latest);
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
    showReply(state, replyId, text);
    log(state, 'reply', { ...fields, outcome: 'shown', reason: 'not_wanted' });
    return;
  }
  speak(state, replyId, text, latest, fields);
}

function showReply(state: CallState, replyId: string, text: string): void {
  recordShown(state, replyId, text);
  state.commands.push({ kind: 'show', replyId, text });
}

function speak(
  state: CallState,
  replyId: string,
  text: string,
  wake: Wake,
  logged: Record<string, unknown> = {},
): void {
  state.playout[replyId] = { text, wakeKey: wake.key };
  state.commands.push({ kind: 'speak', replyId, text, turnId: wake.turnId });
  log(state, 'reply', { replyId, turnId: wake.turnId, outcome: 'speak', ...logged });
}

/** The answer-ready check's verdict: speak the held replies unless Jev is sure they are no longer wanted. */
function onRecheck(state: CallState, wakeKey: string, verdict: RecheckVerdict | null, ms: number): void {
  const recheck = state.recheck;
  // A stop or a newer wake already showed them.
  if (!recheck || recheck.wakeKey !== wakeKey) return;
  state.recheck = null;
  const wake = state.wakes.find((w) => w.key === wakeKey);
  // The speaker resumed during the check: the turn's boundary decides instead, the lines queued meanwhile.
  if (wake?.continuation) {
    for (const { replyId, text, queued } of recheck.replies) {
      const line = state.playout[replyId];
      if (line) delete line.held;
      else if (!queued) speak(state, replyId, text, wake, { outcome: 'held', reason: 'continuation' });
    }
    return;
  }
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
  if (show) state.commands.push({ kind: 'status', status: 'idle' });
  for (const { replyId, text, queued } of recheck.replies) {
    const line = state.playout[replyId];
    // A queued line that left playout during the check (played, failed, revoked) was reported already.
    if (!line && queued) continue;
    if (line && (show || !wake)) revokeQueued(state, replyId);
    else if (line) delete line.held;
    else if (show || !wake) showReply(state, replyId, text);
    else speak(state, replyId, text, wake);
  }
}

/**
 * A stop or a newer wake ends the hold and the answer-ready check, whose verdict is then ignored. Held replies
 * not yet queued are shown; the caller takes back the queued ones.
 */
function endRecheck(state: CallState, reason: 'stopped' | 'replaced'): void {
  const wake = latestWake(state);
  if (wake) endHold(wake);
  const recheck = state.recheck;
  if (!recheck) return;
  state.recheck = null;
  log(state, 'recheck', { replyIds: recheck.replies.map((r) => r.replyId), outcome: 'shown', reason });
  for (const { replyId, text, queued } of recheck.replies)
    if (!state.playout[replyId] && !queued) showReply(state, replyId, text);
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

/** The agent's name and nothing else ("Dan", "Hey Dan.", "Ден?"). */
export function nameAlone(text: string, names: string[]): boolean {
  const said = unpunctuated(normalize(text)).replace(/^(?:hey|hi|ok|okay|гей|хей|привіт|окей) /u, '');
  const known = names.map((name) => unpunctuated(normalize(name))).filter(Boolean);
  return (
    known.includes(said) ||
    (!/\s/.test(said) &&
      sameName(
        said,
        known.filter((name) => !/\s/.test(name)),
      ))
  );
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
