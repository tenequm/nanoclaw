/**
 * The jev call loop's pure core, driven by text fixtures: event sequences in, commands out. No
 * LiveKit, Recall or Jev; a verdict is just another event.
 */
import { describe, expect, it } from 'vitest';

import { CALL_COMMAND_WORDS } from '../../channels/voice-mode-protocol.js';
import { beforeMarker, spokenCommand, vocativeOf } from './core/decide.js';
import { callCore, type CallState } from './core/index.js';
import type { Action, CallEvent, CallKind, Command, Speaker, Verdict } from './core/types.js';
import { renderWindow, toJevState } from './core/window.js';
import { policyFor } from './policy.js';

/** A fixture event: `at` defaults to 100 ms after the previous one. */
type Fed = {
  [K in CallEvent['kind']]: Omit<Extract<CallEvent, { kind: K }>, 'at'> & { at?: number };
}[CallEvent['kind']];

const misha: Speaker = { id: 'p1', name: 'Misha' };
const olena: Speaker = { id: 'p2', name: 'Olena' };

class Call {
  state: CallState;
  logs: Extract<Command, { kind: 'log' }>[] = [];
  statuses: Extract<Command, { kind: 'status' }>[] = [];
  private at = 1_000;
  /** Armed `wait`s and when each comes due; a re-armed key replaces its timer, as the runtime does. */
  private timers = new Map<string, number>();
  /** Fire every due timer, earliest first, before each fed event, as the runtime would. */
  realTimers = false;

  constructor(kind: CallKind = 'voice') {
    this.state = callCore.initial(policyFor(kind, 'Dan', ['Ден']), 0);
  }

  /** Feed events (each 100 ms after the last unless it says otherwise); returns the action commands. */
  feed(...events: Fed[]): Command[] {
    const out: Command[] = [];
    for (const partial of events) {
      const at = partial.at ?? this.at + 100;
      if (this.realTimers) out.push(...this.until(at));
      this.at = at;
      out.push(...this.reduce({ ...partial, at } as CallEvent));
    }
    return out;
  }

  /** Fire the timers due by `at` in the order they come due; returns their action commands. */
  until(at: number): Command[] {
    const out: Command[] = [];
    for (;;) {
      const [next] = [...this.timers].filter(([, due]) => due <= at).sort((a, b) => a[1] - b[1]);
      if (!next) return out;
      this.at = Math.max(this.at, next[1]);
      out.push(...this.reduce({ kind: 'timer', key: next[0], at: this.at }));
    }
  }

  private reduce(event: CallEvent): Command[] {
    const out: Command[] = [];
    if (event.kind === 'timer') this.timers.delete(event.key);
    this.state = callCore.reduce(this.state, event);
    for (const command of callCore.decide(this.state, event)) {
      if (command.kind === 'wait') this.timers.set(command.key, event.at + command.ms);
      if (command.kind === 'cancel_wait') this.timers.delete(command.key);
      if (command.kind === 'log') this.logs.push(command);
      else if (command.kind === 'status') this.statuses.push(command);
      else out.push(command);
    }
    return out;
  }

  /**
   * A speaker says `text` as one utterance: speech on, a partial, the final, speech off. `worker`: in
   * the worker's order instead, the final (`final`, or `text`) after speech off and `partial` before it.
   */
  say(who: Speaker, uttId: string, text: string, worker?: { partial?: string; final?: string }): Command[] {
    const half = worker?.partial ?? text.slice(0, Math.ceil(text.length / 2));
    const partial: Fed = { kind: 'utterance', speaker: who, uttId, text: half, final: false };
    const final: Fed = { kind: 'utterance', speaker: who, uttId, text: worker?.final ?? text, final: true };
    const on: Fed = { kind: 'speech', speaker: who, on: true };
    const off: Fed = { kind: 'speech', speaker: who, on: false };
    return this.feed(on, partial, ...(worker ? [off, final] : [final, off]));
  }

  verdict(windowVersion: number, action: Action | null, p = 0.9, confidence = 0.8): Command[] {
    // A voice call's Choice offers the spoken commands too; a fixture names them only when it picks one.
    const offered: Action[] = ['answer', 'stay_silent', 'stop', 'continue'];
    if (action === 'send' || action === 'discard') offered.push('send', 'discard');
    const probabilities = Object.fromEntries(
      offered.map((a) => [a, action ? (a === action ? p : (1 - p) / (offered.length - 1)) : 0]),
    ) as Verdict['probabilities'];
    return this.feed({
      kind: 'verdict',
      windowVersion,
      verdict: action ? { action, probabilities, confidence } : null,
      ms: 400,
    });
  }

  /** `say`, then Jev's `answer` on the judge it asked for: the commands of both. */
  sayAnswered(who: Speaker, uttId: string, text: string, worker?: { partial?: string; final?: string }): Command[] {
    const said = this.say(who, uttId, text, worker);
    const judges = only(said, 'judge');
    expect(judges).toHaveLength(1);
    return [...said, ...this.verdict(judges[0].windowVersion, 'answer')];
  }

  lastLog(event: string) {
    return [...this.logs].reverse().find((l) => l.event === event)?.fields;
  }
}

const only = <K extends Command['kind']>(commands: Command[], kind: K) =>
  commands.filter((c): c is Extract<Command, { kind: K }> => c.kind === kind);

/** Wake by Jev's answer, deliver the turn, land the reply and play it: returns the reply id. */
function wakeAndSpeak(call: Call, text: string, answer: string, n: number): string {
  const [turn] = only(call.sayAnswered(misha, `u${n}`, text), 'turn');
  call.feed({ kind: 'turn', key: turn.key, turnId: `t${n}` });
  const replyId = `r${n}`;
  expect(call.feed({ kind: 'reply', replyId, turnId: `t${n}`, text: answer })).toEqual([
    { kind: 'speak', replyId, turnId: `t${n}`, text: answer },
  ]);
  call.feed({ kind: 'playback', replyId, state: 'started' });
  return replyId;
}

describe('listen until over', () => {
  const caller: Speaker = { id: 'caller', name: 'Caller' };
  function listening() {
    const call = new Call();
    call.feed({ kind: 'listen', on: true });
    return call;
  }

  it('releases on the spoken send words, by their rules', () => {
    expect(new Call().state.policy.releaseWords).toEqual(
      CALL_COMMAND_WORDS.send.map(({ say, ownSentence }) => ({ say, ...(ownSentence ? { ownSentence } : {}) })),
    );
    expect(new Call('meet').state.policy.releaseWords).toBeUndefined();
  });

  it.each([
    'zulu.',
    'Zulu',
    'ZULU!',
    'зулу?',
    'Зулу',
    'прийом.',
    'Прийом!',
    'приём',
    'pryyom',
    'copy',
    'Copy!',
    'copy that.',
    'Copy that',
  ])('strips a final %s and answers a marker alone with nope', (marker) => {
    const call = listening();
    expect(call.say(caller, 'empty', marker)).toEqual([{ kind: 'cue', cue: 'nope' }]);
    expect(call.say(caller, 'one', 'Go over the handover')).toEqual([]);
    const commands = call.say(caller, 'two', 'Next, ' + marker);
    expect(commands).toEqual([
      expect.objectContaining({ kind: 'turn', message: 'Go over the handover Next' }),
      { kind: 'cue', cue: 'sent' },
    ]);
    expect(call.statuses).not.toContainEqual({ kind: 'status', status: 'thinking' });
  });

  it('waits for an earlier final before releasing a later marker; each new draft remains separate', () => {
    const call = listening();
    const speech = (uttId: string, on: boolean) => call.feed({ kind: 'speech', speaker: caller, uttId, on });
    const final = (uttId: string, text: string) =>
      call.feed({ kind: 'utterance', speaker: caller, uttId, text, final: true });
    speech('a', true);
    speech('a', false);
    speech('b', true);
    speech('b', false);
    expect(final('b', 'Plan, copy that.')).toEqual([]);
    expect(final('a', 'Look over')).toEqual([
      expect.objectContaining({ kind: 'turn', message: 'Look over Plan' }),
      { kind: 'cue', cue: 'sent' },
    ]);
    call.feed({ kind: 'turn', key: 'w1', turnId: 't1' });
    expect(final('c', 'Next draft')).toEqual([]);
    expect(call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: 'Confirmed.' })).toEqual([
      { kind: 'speak', replyId: 'r1', text: 'Confirmed.', turnId: 't1' },
    ]);
    call.feed({ kind: 'playback', replyId: 'r1', state: 'started' });
    expect(final('stop', 'стоп')).toContainEqual({ kind: 'stop_playback' });
    expect(call.feed({ kind: 'hangup' })).toEqual([{ kind: 'post_caller', text: 'Next draft' }]);
  });

  it('holds an overlap marker out of the draft until the worker releases it after a cut', () => {
    const call = listening();
    call.say(caller, 'a', 'Draft');
    const words = { kind: 'utterance', speaker: caller, uttId: 'b', text: 'Next, прийом.' } as const;
    call.feed(
      { kind: 'speech', speaker: caller, uttId: 'b', on: true },
      { ...words, final: false },
      { kind: 'speech', speaker: caller, on: false },
    );
    expect(only(call.feed({ ...words, final: true, contextOnly: true }), 'turn')).toEqual([]);
    expect(call.state.listenDraft?.map((piece) => piece.text)).toEqual(['Draft', '']);
    expect(only(call.feed({ ...words, final: true }), 'turn').map((turn) => turn.message)).toEqual(['Draft Next']);
  });

  it('settles a lost final with its last partial and unblocks later releases', () => {
    const call = listening();
    call.feed(
      { kind: 'speech', speaker: caller, uttId: 'a', on: true },
      { kind: 'utterance', speaker: caller, uttId: 'a', text: 'Keep this', final: false },
    );
    const [timer] = only(call.feed({ kind: 'speech', speaker: caller, on: false }), 'wait');
    expect(timer?.ms).toBeGreaterThan(0);
    expect(only(call.say(caller, 'b', 'and this, zulu.'), 'turn')).toEqual([]);
    expect(only(call.feed({ kind: 'timer', key: timer.key }), 'turn')[0]?.message).toBe('Keep this and this');
    expect(only(call.say(caller, 'c', 'Next, zulu.'), 'turn')[0]?.message).toBe('Next');
  });

  it('strips consecutive markers', () => {
    const call = listening();
    expect(call.say(caller, 'a', 'Прийом, прийом.')).toEqual([{ kind: 'cue', cue: 'nope' }]);
    expect(call.say(caller, 'b', 'hand it over')).toEqual([]);
    expect(only(call.say(caller, 'c', 'Прийом, прийом.'), 'turn')[0]?.message).toBe('hand it over');
  });

  it.each([
    ['the game is done, zulu.', 'the game is done'],
    ['the game is done zulu', 'the game is done'],
    ['say it\u2014прийом', 'say it'],
    ['tell me, zulu, zulu.', 'tell me'],
    ['say it. Copy!', 'say it.'],
    ['say it, copy that.', 'say it'],
    ['Copy that.', ''],
    ['zulu, call Anna', null],
    ['send me a copy', null],
    ['send me a Copy', null],
    ['copy that file', null],
    ['I need a copy that works', null],
    ['the game is over.', null],
    ['Over!', null],
    ['овер', null],
    ['Next, over.', null],
  ])('reads %s as %s before the release words', (text, rest) => {
    expect(beforeMarker(text!, new Call().state.policy.releaseWords!)).toBe(rest);
  });

  it('keeps everyday copy and over in the draft', () => {
    const call = listening();
    expect(call.say(caller, 'a', 'send me a copy')).toEqual([]);
    expect(call.say(caller, 'b', 'copy that file')).toEqual([]);
    expect(call.say(caller, 'c', 'Next, over.')).toEqual([]);
    expect(call.say(caller, 'd', 'овер')).toEqual([]);
    expect(only(call.say(caller, 'e', 'Done. Copy.'), 'turn')[0]?.message).toBe(
      'send me a copy copy that file Next, over. овер Done.',
    );
  });

  it('shows pending and playing replies accurately at toggle-on and releases a held continuation', () => {
    const call = new Call();
    const [turn] = only(call.sayAnswered(caller, 'a', 'What time is it?'), 'turn');
    call.feed({ kind: 'turn', key: turn.key, turnId: 't' });
    call.feed({ kind: 'speech', speaker: caller, uttId: 'b', on: true });
    // Synthesized at once, granted no playback while the caller finishes; listening ends the hold.
    expect(only(call.feed({ kind: 'reply', replyId: 'r', text: 'Two.', turnId: 't' }), 'speak')[0]?.text).toBe('Two.');
    expect(call.feed({ kind: 'play_ready', replyId: 'r', requestId: 'q' })).toEqual([]);
    expect(only(call.feed({ kind: 'listen', on: true }), 'allow_play')).toEqual([
      { kind: 'allow_play', replyId: 'r', requestId: 'q' },
    ]);
    expect(call.statuses.at(-1)?.status).toBe('idle');
    const playing = new Call();
    wakeAndSpeak(playing, 'What time is it?', 'Two.', 1);
    playing.feed({ kind: 'listen', on: true });
    expect(playing.statuses.at(-1)?.status).toBe('speaking');
  });

  it('speaks a reply held for recheck when listening starts', () => {
    const call = new Call();
    const [turn] = only(call.sayAnswered(caller, 'a', 'What time is it?'), 'turn');
    call.feed({ kind: 'turn', key: turn.key, turnId: 't' });
    call.say(olena, 'b', 'One more detail.');
    expect(only(call.feed({ kind: 'reply', replyId: 'r', text: 'Two.', turnId: 't' }), 'recheck')).toHaveLength(1);
    expect(only(call.feed({ kind: 'listen', on: true }), 'speak')[0]?.text).toBe('Two.');
  });

  it('orders an utterance started before toggle-on ahead of a later marker', () => {
    const call = new Call();
    call.feed(
      { kind: 'speech', speaker: caller, uttId: 'a', on: true },
      { kind: 'listen', on: true },
      { kind: 'speech', speaker: caller, on: false },
    );
    expect(only(call.say(caller, 'b', 'Second, zulu.'), 'turn')).toHaveLength(0);
    expect(
      only(call.feed({ kind: 'utterance', speaker: caller, uttId: 'a', text: 'First.', final: true }), 'turn')[0]
        ?.message,
    ).toBe('First. Second');
  });

  it('resumes automatic decisions after the toggle-off deadline, even with new speech in flight', () => {
    const call = listening();
    call.feed(
      { kind: 'speech', speaker: caller, uttId: 'a', on: true },
      { kind: 'utterance', speaker: caller, uttId: 'a', text: 'First', final: false },
    );
    // The piece still being said is timed from its own speech-off.
    expect(only(call.feed({ kind: 'listen', on: false }), 'wait')).toEqual([]);
    const [timer] = only(call.feed({ kind: 'speech', speaker: caller, on: false }), 'wait');
    expect(only(call.say(caller, 'b', 'What next?'), 'judge')).toHaveLength(0);
    const commands = call.feed({ kind: 'timer', key: timer.key });
    expect(only(commands, 'turn')[0]?.message).toBe('First');
    expect(only(commands, 'judge')).toHaveLength(1);
  });

  it('turning off waits for the corrected final and resumes thinking', () => {
    const call = listening();
    const part = { kind: 'utterance', speaker: caller, uttId: 'a' } as const;
    call.feed({ ...part, text: 'First', final: false });
    expect(only(call.feed({ kind: 'listen', on: false }), 'turn')).toEqual([]);
    const [turn] = only(call.feed({ ...part, text: 'Corrected first.', final: true }), 'turn');
    expect(turn?.message).toBe('Corrected first.');
    expect(turn.note).not.toContain('[silent]');
    expect(call.statuses.at(-1)?.status).toBe('thinking');
    expect(only(call.say(caller, 'b', 'What next?'), 'judge')).toHaveLength(1);
  });

  it('a boundary timer armed before listening neither settles nor releases the draft', () => {
    const call = new Call();
    call.feed(
      { kind: 'speech', speaker: caller, uttId: 'a', on: true },
      { kind: 'utterance', speaker: caller, uttId: 'a', text: 'Keep this', final: false },
    );
    const [boundary] = only(call.feed({ kind: 'speech', speaker: caller, on: false }), 'wait');
    expect(boundary?.key).toBe('boundary:caller');
    const [piece] = only(call.feed({ kind: 'listen', on: true }), 'wait');
    expect(call.feed({ kind: 'timer', key: boundary.key })).toEqual([]);
    expect(call.state.listenDraft?.map((p) => [p.text, p.final])).toEqual([['Keep this', false]]);
    expect(only(call.say(caller, 'b', 'and this, zulu.'), 'turn')).toEqual([]);
    expect(only(call.feed({ kind: 'timer', key: piece.key }), 'turn')[0]?.message).toBe('Keep this and this');
  });

  it('adds nothing to the draft for a wordless or noise activity', () => {
    const call = listening();
    call.say(caller, 'a', 'Draft');
    const noise = (uttId: string) =>
      call.feed(
        { kind: 'speech', speaker: caller, uttId, on: true },
        { kind: 'speech', speaker: caller, on: false },
        { kind: 'utterance', speaker: caller, uttId, text: '', final: true },
      );
    expect(only(noise('n1'), 'turn')).toEqual([]);
    expect(only(call.say(caller, 'b', 'Next, zulu.'), 'turn').map((turn) => turn.message)).toEqual(['Draft Next']);
    expect(only(noise('n2'), 'turn')).toEqual([]);
    const off = call.feed({ kind: 'listen', on: false });
    expect(only(off, 'turn')).toEqual([]);
    expect(call.state.listenDraft).toBeNull();
    expect(only(call.say(caller, 'c', 'What next?'), 'judge')).toHaveLength(1);
  });

  it('ignores listen settings in a meeting', () => {
    const call = new Call('meet');
    call.feed({ kind: 'listen', on: true });
    expect(call.state.listenDraft).toBeNull();
  });

  it('a held overlap final after its piece timer keeps the piece settled, so later releases still go out', () => {
    const call = listening();
    call.feed(
      { kind: 'speech', speaker: caller, uttId: 'a', on: true },
      { kind: 'utterance', speaker: caller, uttId: 'a', text: 'ага, так', final: false, contextOnly: true },
    );
    const [timer] = only(call.feed({ kind: 'speech', speaker: caller, on: false }), 'wait');
    call.feed({ kind: 'timer', key: timer.key });
    call.feed({ kind: 'utterance', speaker: caller, uttId: 'a', text: 'ага, так', final: true, contextOnly: true });
    expect(call.state.listenDraft?.map((piece) => piece.final)).toEqual([true]);
    expect(only(call.say(caller, 'b', 'Нове питання, прийом.'), 'turn').map((turn) => turn.message)).toEqual([
      'Нове питання',
    ]);
  });

  it('switching off mid-sentence waits for the rest of that utterance', () => {
    const call = listening();
    const words = (text: string, final: boolean) =>
      ({ kind: 'utterance', speaker: caller, uttId: 'a', text, final }) as const;
    call.feed({ kind: 'speech', speaker: caller, uttId: 'a', on: true }, words('я хочу сказати що', false));
    expect(only(call.feed({ kind: 'listen', on: false }), 'wait')).toEqual([]);
    // Even a piece timer cannot cut the utterance while the caller is still saying it.
    expect(only(call.feed({ kind: 'timer', key: 'listen-piece:a' }), 'turn')).toEqual([]);
    call.feed(words('я хочу сказати що завтра', false));
    expect(only(call.feed({ kind: 'speech', speaker: caller, on: false }), 'wait')).toHaveLength(1);
    const [turn] = only(call.feed(words('я хочу сказати що завтра буде дощ.', true)), 'turn');
    expect(turn?.message).toBe('я хочу сказати що завтра буде дощ.');
  });

  it('a final replayed by a retried POST changes nothing, while listening or not', () => {
    const call = listening();
    call.say(caller, 'a', 'Draft');
    const final = { kind: 'utterance', speaker: caller, uttId: 'b', text: 'Next, zulu.', final: true } as const;
    call.feed(
      { kind: 'speech', speaker: caller, uttId: 'b', on: true },
      { kind: 'speech', speaker: caller, on: false },
    );
    expect(only(call.feed(final), 'turn').map((turn) => turn.message)).toEqual(['Draft Next']);
    expect(call.feed(final)).toEqual([]);
    call.feed({ kind: 'listen', on: false }, { kind: 'turn', key: 'w1', turnId: 't1' });
    const [judge] = only(call.say(caller, 'c', 'What next?'), 'judge');
    const logs = call.logs.length;
    const statuses = call.statuses.length;
    expect(call.feed({ kind: 'utterance', speaker: caller, uttId: 'c', text: 'What next?', final: true })).toEqual([]);
    expect([call.logs.length, call.statuses.length]).toEqual([logs, statuses]);
    expect(only(call.verdict(judge.windowVersion, 'answer'), 'turn')).toHaveLength(1);
  });

  it('takes the discard words from the spoken commands, on a voice call only', () => {
    expect(new Call().state.policy.discardWords).toEqual(CALL_COMMAND_WORDS.discard.map(({ say }) => ({ say })));
    expect(new Call('meet').state.policy.discardWords).toBeUndefined();
  });

  it.each(CALL_COMMAND_WORDS.discard.map(({ say }) => say))(
    'drops the whole unsent draft on a final %s, sends nothing, cues discard and keeps listening',
    (phrase) => {
      const call = listening();
      expect(call.say(caller, 'a', 'Book a table')).toEqual([]);
      expect(call.say(caller, 'b', `for eight, ${phrase}.`)).toEqual([{ kind: 'cue', cue: 'discard' }]);
      expect(call.state.listenDraft).toEqual([]);
      // Listening goes on: the next draft goes out without the dropped words.
      expect(call.say(caller, 'c', 'Call Anna, zulu')).toEqual([
        expect.objectContaining({ kind: 'turn', message: 'Call Anna' }),
        { kind: 'cue', cue: 'sent' },
      ]);
      expect(call.feed({ kind: 'hangup' })).toEqual([]);
    },
  );

  it.each(['Scratch that.', 'discard turn', 'Discard this turn!', 'scratch that, scratch that'])(
    'answers %s with an empty draft with nope',
    (said) => {
      const call = listening();
      expect(call.say(caller, 'a', said)).toEqual([{ kind: 'cue', cue: 'nope' }]);
      expect(call.say(caller, 'b', 'Next, zulu.')).toEqual([
        expect.objectContaining({ kind: 'turn', message: 'Next' }),
        { kind: 'cue', cue: 'sent' },
      ]);
    },
  );

  it('waits for an earlier final before a later discard acts, and keeps what was said after it', () => {
    const call = listening();
    const speech = (uttId: string, on: boolean) => call.feed({ kind: 'speech', speaker: caller, uttId, on });
    const final = (uttId: string, text: string) =>
      call.feed({ kind: 'utterance', speaker: caller, uttId, text, final: true });
    for (const uttId of ['a', 'b', 'c']) {
      speech(uttId, true);
      speech(uttId, false);
    }
    expect(final('b', 'Scratch that.')).toEqual([]);
    expect(final('c', 'Call Anna')).toEqual([]);
    expect(final('a', 'Book a table')).toEqual([{ kind: 'cue', cue: 'discard' }]);
    expect(call.state.listenDraft?.map((piece) => piece.text)).toEqual(['Call Anna']);
    expect(only(call.say(caller, 'd', 'zulu'), 'turn').map((turn) => turn.message)).toEqual(['Call Anna']);
  });

  it('keeps a discard phrase inside a sentence as words', () => {
    const call = listening();
    expect(call.say(caller, 'a', 'scratch that idea and call the plumber')).toEqual([]);
    expect(only(call.say(caller, 'b', 'zulu'), 'turn').map((turn) => turn.message)).toEqual([
      'scratch that idea and call the plumber',
    ]);
  });

  it('saves no discarded words as the caller at hangup, and plays no cue while hanging up', () => {
    const call = listening();
    call.say(caller, 'a', 'Book a table, scratch that.');
    call.say(caller, 'b', 'Keep this');
    call.feed({ kind: 'hangup', draining: true });
    expect(call.say(caller, 'c', 'and this, zulu')).toEqual([
      expect.objectContaining({ kind: 'turn', message: 'Keep this and this' }),
    ]);
  });

  it.each([
    ['Book it, scratch that.', { command: 'discard', rest: 'Book it' }],
    ['call the plumber discard turn', { command: 'discard', rest: 'call the plumber' }],
    ['Discard this turn', { command: 'discard', rest: '' }],
    ['Book it, zulu', { command: 'send', rest: 'Book it' }],
    ['Scratch that, zulu', { command: 'send', rest: 'Scratch that' }],
    ['scratch that idea', null],
    ['send me a copy', null],
  ])('reads %s as %j', (text, command) => {
    expect(spokenCommand(text, new Call().state.policy)).toEqual(command);
  });

  it('ignores a judge verdict already in flight when listening starts', () => {
    const call = new Call();
    const [judge] = only(call.say(caller, 'a', 'What time is it?'), 'judge');
    call.feed({ kind: 'listen', on: true });
    expect(call.verdict(judge.windowVersion, 'answer')).toEqual([]);
    expect(only(call.feed({ kind: 'listen', on: false }), 'turn')[0]?.message).toBe('What time is it?');
  });
});

describe('spoken commands on a voice call', () => {
  const caller: Speaker = { id: 'caller', name: 'Caller' };
  /** `say`, then Jev's verdict `action` on the judge it asked for. */
  function judged(call: Call, uttId: string, text: string, action: Action, p = 0.9): Command[] {
    const said = call.say(caller, uttId, text);
    const [judge] = only(said, 'judge');
    expect(judge).toBeDefined();
    return [...said, ...call.verdict(judge.windowVersion, action, p)];
  }

  it('sends the words judged silent since the last turn on send, without the send word, with the sent cue', () => {
    const call = new Call();
    expect(only(judged(call, 'a', 'I have to be there at 17:12.', 'stay_silent'), 'turn')).toEqual([]);
    const sent = judged(call, 'b', 'And bring the keys, прийом.', 'send');
    expect(sent.filter((c) => c.kind === 'cue' || c.kind === 'turn')).toEqual([
      { kind: 'cue', cue: 'sent' },
      expect.objectContaining({ kind: 'turn', message: 'I have to be there at 17:12. And bring the keys' }),
    ]);
    expect(call.lastLog('command')).toMatchObject({ command: 'send', outcome: 'sent' });
    // Those words are sent: a lone send word after them has nothing to send.
    expect(judged(call, 'c', 'zulu', 'send').filter((c) => c.kind === 'cue' || c.kind === 'turn')).toEqual([
      { kind: 'cue', cue: 'nope' },
    ]);
  });

  it('answers a send with nothing unsent with nope and nothing else', () => {
    const call = new Call();
    expect(judged(call, 'a', 'Copy that.', 'send')).toEqual([
      expect.objectContaining({ kind: 'judge' }),
      { kind: 'cue', cue: 'nope' },
    ]);
    expect(call.lastLog('command')).toMatchObject({ command: 'send', outcome: 'nothing' });
  });

  it("sends a held turn's continuation with its trigger on send, replacing the answer not started yet", () => {
    const call = new Call();
    call.sayAnswered(caller, 'a', 'What is the weather');
    call.feed({ kind: 'turn', key: 'w1', turnId: 't1' }, { kind: 'speech', speaker: caller, uttId: 'b', on: true });
    call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: 'Sunny.' });
    const result = [
      ...call.feed(
        { kind: 'utterance', speaker: caller, uttId: 'b', text: 'in Kyiv, zulu', final: true },
        { kind: 'speech', speaker: caller, on: false },
      ),
    ];
    const [judge] = only(result, 'judge');
    expect(judge.state.latest?.text).toBe('What is the weather in Kyiv, zulu');
    const sent = call.verdict(judge.windowVersion, 'send');
    expect(only(sent, 'revoke').map((c) => c.replyId)).toEqual(['r1']);
    expect(only(sent, 'cue')).toEqual([{ kind: 'cue', cue: 'sent' }]);
    expect(only(sent, 'turn').map((c) => c.message)).toEqual(['What is the weather in Kyiv']);
  });

  it('drops the unsent words on discard with the discard cue; they never join a later turn', () => {
    const call = new Call();
    judged(call, 'a', 'Book a table', 'stay_silent');
    const dropped = judged(call, 'b', 'for eight, scratch that.', 'discard');
    expect(only(dropped, 'cue')).toEqual([{ kind: 'cue', cue: 'discard' }]);
    expect(only(dropped, 'turn')).toEqual([]);
    expect(only(dropped, 'revoke')).toEqual([]);
    expect(call.lastLog('command')).toMatchObject({ command: 'discard', dropped: true, revokedTurn: false });
    expect(judged(call, 'c', 'zulu', 'send').filter((c) => c.kind === 'cue')).toEqual([{ kind: 'cue', cue: 'nope' }]);
    expect(only(judged(call, 'd', 'What time is it?', 'answer'), 'turn').map((c) => c.message)).toEqual([
      'What time is it?',
    ]);
  });

  it('answers a discard with nothing unsent and no answer to take back with nope', () => {
    const call = new Call();
    expect(judged(call, 'a', 'Scratch that.', 'discard')).toEqual([
      expect.objectContaining({ kind: 'judge' }),
      { kind: 'cue', cue: 'nope' },
    ]);
  });

  it('takes back a sent turn whose answer has not started: a queued line is revoked', () => {
    const call = new Call();
    call.sayAnswered(caller, 'a', 'What time is it?');
    call.feed({ kind: 'turn', key: 'w1', turnId: 't1' }, { kind: 'speech', speaker: caller, uttId: 'b', on: true });
    call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: 'Noon.' });
    const [judge] = only(
      call.feed(
        { kind: 'utterance', speaker: caller, uttId: 'b', text: 'Scratch that.', final: true },
        { kind: 'speech', speaker: caller, on: false },
      ),
      'judge',
    );
    call.statuses = [];
    const result = call.verdict(judge.windowVersion, 'discard');
    expect(only(result, 'revoke').map((c) => c.replyId)).toEqual(['r1']);
    expect(only(result, 'cue')).toEqual([{ kind: 'cue', cue: 'discard' }]);
    expect(only(result, 'stop_playback')).toEqual([]);
    expect(call.statuses.map((c) => c.status)).toEqual(['idle']);
    expect(call.lastLog('command')).toMatchObject({ command: 'discard', revokedTurn: true, revoked: ['r1'] });
  });

  it('takes back a sent turn whose answer has not come: the answer is shown only', () => {
    const call = new Call();
    const [turn] = only(call.sayAnswered(caller, 'a', 'What time is it?'), 'turn');
    call.feed({ kind: 'turn', key: turn.key, turnId: 't1' });
    expect(only(judged(call, 'b', 'Scratch that.', 'discard'), 'cue')).toEqual([{ kind: 'cue', cue: 'discard' }]);
    expect(call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: 'Noon.' })).toEqual([
      { kind: 'show', replyId: 'r1', text: 'Noon.' },
    ]);
  });

  it('leaves a line already playing alone: a discard with nothing unsent is nope', () => {
    const call = new Call();
    wakeAndSpeak(call, 'what time is it?', 'Noon.', 1);
    const result = judged(call, 'u2', 'scratch that', 'discard');
    expect(only(result, 'cue')).toEqual([{ kind: 'cue', cue: 'nope' }]);
    expect(only(result, 'stop_playback')).toEqual([]);
    expect(only(result, 'revoke')).toEqual([]);
  });

  it('does not answer a discard below its bar on p(answer)', () => {
    const call = new Call();
    const [judge] = only(call.say(caller, 'a', 'Book a table, scratch that'), 'judge');
    const result = call.feed({
      kind: 'verdict',
      windowVersion: judge.windowVersion,
      verdict: {
        action: 'discard',
        probabilities: { answer: 0.4, stay_silent: 0, stop: 0, continue: 0, send: 0, discard: 0.6 - 0.01 },
        confidence: 0.3,
      },
      ms: 300,
    });
    expect(only(result, 'turn')).toEqual([]);
    expect(only(result, 'cue')).toEqual([]);
  });

  it('never acts on a send or discard in a meeting, which offers neither', () => {
    const call = new Call('meet');
    call.feed({ kind: 'presence', speaker: olena, joined: true }, { kind: 'presence', speaker: misha, joined: true });
    const [judge] = only(call.say(misha, 'a', 'Book a table, zulu'), 'judge');
    for (const action of ['send', 'discard'] as const) {
      const result = call.verdict(judge.windowVersion, action);
      expect(result.filter((c) => c.kind === 'cue' || c.kind === 'turn' || c.kind === 'revoke')).toEqual([]);
    }
  });
});

describe('follow-up exchanges', () => {
  it('has no exchange before a reply finishes', () => {
    const call = new Call('meet');
    expect(toJevState(call.state).facts).toMatchObject({ last_reply_to: null, in_exchange_with: null });
    wakeAndSpeak(call, 'Dan, what is two plus two?', 'Four.', 1);
    expect(toJevState(call.state).facts).toMatchObject({ last_reply_to: null, in_exchange_with: null });
  });

  it.each(['completed', 'cut_off'] as const)('sets the exchange after playback is %s', (state) => {
    const call = new Call('meet');
    const replyId = wakeAndSpeak(call, 'Dan, what is two plus two?', 'Four.', 1);
    call.feed({ kind: 'playback', replyId, state, delivered: 'Four.' });
    expect(toJevState(call.state).facts).toMatchObject({
      last_reply_to: { speaker: 'Misha', s_ago: 0 },
      in_exchange_with: 'Misha',
    });
    call.say(misha, 'u2', 'And three plus three?');
    expect(toJevState(call.state).facts.in_exchange_with).toBe('Misha');
  });

  it('ends on another speaker final, and does not resume when the first speaker returns', () => {
    const call = new Call('meet');
    const replyId = wakeAndSpeak(call, 'Dan, what is two plus two?', 'Four.', 1);
    call.feed({ kind: 'playback', replyId, state: 'completed' });
    call.feed({ kind: 'utterance', speaker: olena, uttId: 'o1', text: 'My turn', final: false });
    expect(toJevState(call.state).facts.in_exchange_with).toBe('Misha');
    const version = call.state.windowVersion;
    call.feed({ kind: 'utterance', speaker: olena, uttId: 'o1', text: 'My turn', final: true });
    expect(toJevState(call.state).facts.in_exchange_with).toBeNull();
    expect(call.state.windowVersion).toBeGreaterThan(version);
    call.say(misha, 'u2', 'And three plus three?');
    expect(toJevState(call.state).facts).toMatchObject({
      last_reply_to: { speaker: 'Misha' },
      in_exchange_with: null,
    });
  });

  it('expires after 60 seconds and rejudges an in-flight verdict', () => {
    const call = new Call('meet');
    const replyId = wakeAndSpeak(call, 'Dan, what is two plus two?', 'Four.', 1);
    call.feed({ kind: 'playback', replyId, state: 'completed' });
    const endedAt = call.state.now;
    const [judge] = only(call.say(misha, 'u2', 'And three plus three?'), 'judge');
    const version = call.state.windowVersion;
    call.feed({ kind: 'timer', key: 'clock', at: endedAt + 60_000 });
    expect(toJevState(call.state).facts).toMatchObject({
      last_reply_to: { speaker: 'Misha', s_ago: 60 },
      in_exchange_with: 'Misha',
    });
    expect(call.state.windowVersion).toBe(version);
    call.feed({ kind: 'timer', key: 'clock', at: endedAt + 60_001 });
    expect(toJevState(call.state).facts.in_exchange_with).toBeNull();
    expect(call.state.windowVersion).toBeGreaterThan(version);
    const commands = call.verdict(judge.windowVersion, 'answer');
    expect(only(commands, 'turn')).toEqual([]);
    expect(only(commands, 'judge')).toHaveLength(1);
  });

  it('does not start an exchange for failed or unprompted replies', () => {
    const call = new Call('meet');
    const replyId = wakeAndSpeak(call, 'Dan, what is two plus two?', 'Four.', 1);
    call.feed({ kind: 'playback', replyId, state: 'failed' });
    call.feed({ kind: 'reply', replyId: 'unprompted', turnId: null, text: 'Hello.' });
    call.feed({ kind: 'playback', replyId: 'unprompted', state: 'completed' });
    expect(toJevState(call.state).facts).toMatchObject({ last_reply_to: null, in_exchange_with: null });
  });
});

describe('a named question', () => {
  it('goes to Jev with addressed_by_name, and an answer wakes with the window in the note', () => {
    const call = new Call();
    const said = call.say(misha, 'u1', 'Dan, what is two plus two?');
    expect(only(said, 'turn')).toEqual([]);
    const [judge] = only(said, 'judge');
    expect(judge.state.facts.addressed_by_name).toBe(true);
    expect(judge.state.latest).toEqual({ speaker: 'Misha', text: 'Dan, what is two plus two?' });
    const [turn] = only(call.verdict(judge.windowVersion, 'answer'), 'turn');
    expect(turn.message).toBe('Dan, what is two plus two?');
    expect(turn.supersedes).toBeUndefined();
    expect(turn.note).toContain('Misha: Dan, what is two plus two?');
    expect(turn.note).toContain('reply exactly [silent]');
    expect(call.lastLog('decision')).toMatchObject({ action: 'answer', speaker: 'Misha' });
  });

  it('stays silent when Jev reads the vocative as no request now', () => {
    const call = new Call();
    for (const [n, text] of ["Dan, don't answer that.", 'Dan, wait for Anna.', 'Dan, I was wondering'].entries()) {
      const [judge] = only(call.say(misha, `u${n}`, text), 'judge');
      expect(judge.state.facts.addressed_by_name).toBe(true);
      expect(call.verdict(judge.windowVersion, 'stay_silent')).toEqual([]);
    }
  });

  it('still wakes on a vocative when Jev fails; never deaf to its name', () => {
    const call = new Call();
    const [judge] = only(call.say(misha, 'u1', 'Dan, what time is it?'), 'judge');
    const [turn] = only(call.verdict(judge.windowVersion, null), 'turn');
    expect(turn.message).toBe('Dan, what time is it?');
    expect(call.lastLog('decision')).toMatchObject({ jev: null, action: 'answer', reason: 'jev_failed' });
  });

  it('a name alone or a third-person mention is not addressed_by_name', () => {
    const call = new Call('meet');
    call.feed({ kind: 'presence', speaker: misha, joined: true }, { kind: 'presence', speaker: olena, joined: true });
    const [named] = only(call.say(misha, 'u1', 'Dan?'), 'judge');
    expect(named.state.facts.addressed_by_name).toBe(false);
    call.verdict(named.windowVersion, 'stay_silent');
    const [mention] = only(call.say(misha, 'u2', 'I told Dan about it.'), 'judge');
    expect(mention.state.facts.addressed_by_name).toBe(false);
  });

  it.each(['Dan', 'Hey Dan.', 'Ден?', 'Дене!'])('one caller saying only the name wakes without Jev: %s', (text) => {
    const call = new Call();
    const commands = call.say(misha, 'u1', text);
    expect(only(commands, 'judge')).toEqual([]);
    expect(only(commands, 'turn')).toMatchObject([{ message: text }]);
    expect(call.lastLog('decision')).toMatchObject({ rule: 'name_alone', action: 'answer' });
  });

  it('the name alone carries what the caller said just before it', () => {
    const call = new Call();
    const [judge] = only(call.say(misha, 'u1', 'what time is it'), 'judge');
    call.verdict(judge.windowVersion, 'stay_silent');
    expect(only(call.say(misha, 'u2', 'Dan?'), 'turn')).toMatchObject([{ message: 'what time is it Dan?' }]);
  });

  it('the name alone is left to Jev while an answer is on its way', () => {
    const call = new Call();
    call.sayAnswered(misha, 'u1', 'Dan, what time is it?');
    const commands = call.say(misha, 'u2', 'Dan?');
    expect(only(commands, 'turn')).toEqual([]);
    expect(only(commands, 'judge')).toHaveLength(1);
  });

  it('speaks the reply and puts the agent line in the window from the playback reports', () => {
    const call = new Call();
    const replyId = wakeAndSpeak(call, 'Dan, how warm is it?', 'Twelve degrees.', 1);
    expect(toJevState(call.state).facts).toMatchObject({ agent_speaking: true, pending_answer: true });
    call.feed({ kind: 'playback', replyId, state: 'completed' });
    const jev = toJevState(call.state);
    expect(jev.window.at(-1)).toMatchObject({ speaker: 'Dan', text: 'Twelve degrees.', agent: true });
    expect(jev.window.at(-1)?.cut_off).toBeUndefined();
    expect(jev.facts).toMatchObject({ agent_speaking: false, pending_answer: false, cut_off_after: null });
    expect(call.lastLog('playback')).toMatchObject({ outcome: 'spoken', spoke_since_trigger: [] });
  });

  it('matches the vocative at the end, in another script, and ignores case', () => {
    expect(vocativeOf('What time is it, dan?', ['Dan'])).toEqual({ vocative: true, rest: 'what time is it' });
    expect(vocativeOf('Ден, котра година?', ['Dan', 'Ден'])).toEqual({ vocative: true, rest: 'котра година' });
    expect(vocativeOf('Hey Dan! Stop.', ['Dan'])).toEqual({ vocative: true, rest: 'stop' });
    expect(vocativeOf("Dan's result was wrong", ['Dan']).vocative).toBe(false);
    expect(vocativeOf('Ден, можеш відповісти?', ['Dan'])).toEqual({ vocative: true, rest: 'можеш відповісти' });
    expect(vocativeOf('Дене, ти тут?', ['Dan'])).toEqual({ vocative: true, rest: 'ти тут' });
    expect(vocativeOf('Яка погода, Ден?', ['Dan'])).toEqual({ vocative: true, rest: 'яка погода' });
    expect(vocativeOf('Денис, ти тут?', ['Dan']).vocative).toBe(false);
    expect(vocativeOf('Я сказав Дену, що все добре.', ['Dan']).vocative).toBe(false);
    expect(vocativeOf('I told Dan to stop', ['Dan']).vocative).toBe(false);
    expect(vocativeOf('Danny, hi', ['Dan']).vocative).toBe(false);
  });

  it('matches a name by its sound only across Cyrillic and Latin', () => {
    expect(vocativeOf('Don, what time is it?', ['Dan']).vocative).toBe(false);
    expect(vocativeOf('Den, what time is it?', ['Dan']).vocative).toBe(false);
    expect(vocativeOf('What time is it, Don?', ['Dan']).vocative).toBe(false);
    expect(vocativeOf('Дон, котра година?', ['Ден']).vocative).toBe(false);
    expect(vocativeOf('Ден, котра година?', ['Dan']).vocative).toBe(true);
    expect(vocativeOf('Дене, котра година?', ['Dan']).vocative).toBe(true);
    expect(vocativeOf('Дене, котра година?', ['Ден']).vocative).toBe(true);
    expect(vocativeOf('Dan, what time is it?', ['Ден']).vocative).toBe(true);
    expect(vocativeOf('Hey Dan, what time is it?', ['Dan']).vocative).toBe(true);
  });
});

describe('a third-person mention', () => {
  it('goes to Jev with the whole window, not to a rule', () => {
    const call = new Call('meet');
    call.say(olena, 'u1', 'Let us look at the numbers.');
    const commands = call.say(misha, 'u2', "Dan's result was wrong yesterday.");
    expect(only(commands, 'turn')).toEqual([]);
    const [judge] = only(commands, 'judge');
    expect(judge.state.window.map((l) => l.speaker)).toEqual(['Olena', 'Misha']);
    expect(judge.state.latest).toEqual({ speaker: 'Misha', text: expect.any(String) });
    expect(judge.state.facts.humans_in_room).toBe(2);
    expect(call.verdict(judge.windowVersion, 'stay_silent')).toEqual([]);
  });

  it('is no stop rule while the agent speaks', () => {
    const call = new Call();
    wakeAndSpeak(call, 'Dan, tell me a story.', 'Once upon a time.', 1);
    const commands = call.say(misha, 'u2', 'I told Dan to stop.');
    expect(only(commands, 'stop_playback')).toEqual([]);
    expect(only(commands, 'judge')).toHaveLength(1);
  });
});

describe('a half sentence, then its rest', () => {
  it('stays silent on the half and answers the whole', () => {
    const call = new Call();
    const [first] = only(call.say(misha, 'u1', 'So what I want to know is'), 'judge');
    expect(first.state.window).toEqual([{ t: 0.2, speaker: 'Misha', text: 'So what I want to know is' }]);
    expect(call.verdict(first.windowVersion, 'answer', 0.29, 0.4)).toEqual([]);
    expect(call.lastLog('decision')).toMatchObject({ action: 'stay_silent' });

    const [second] = only(call.say(misha, 'u2', 'whether it rains tomorrow'), 'judge');
    expect(second.state.window.map((l) => l.text)).toEqual(['So what I want to know is', 'whether it rains tomorrow']);
    const [turn] = only(call.verdict(second.windowVersion, 'answer'), 'turn');
    expect(second.state.latest?.text).toBe('So what I want to know is whether it rains tomorrow');
    expect(turn.message).toBe('So what I want to know is whether it rains tomorrow');
    expect(turn.note).toContain('Misha: So what I want to know is\nMisha: whether it rains tomorrow');
  });

  it('decides each utterance once: the fallback timer after the speech-off boundary is a no-op', () => {
    const call = new Call('meet');
    expect(only(call.say(misha, 'u1', 'Can someone check the logs'), 'judge')).toHaveLength(1);
    expect(call.feed({ kind: 'timer', key: 'boundary:p1' })).toEqual([]);
  });
});

describe('the boundary', () => {
  it("in a meeting, decides each speaker on their own VAD end and final, never another's speech", () => {
    const call = new Call('meet');
    call.feed(
      { kind: 'speech', speaker: misha, on: true },
      { kind: 'speech', speaker: olena, on: true },
      { kind: 'utterance', speaker: misha, uttId: 'p1-0', text: 'Dan, what is', final: false },
    );
    // A partial is no boundary; a final while the speaker still speaks is none either.
    expect(call.feed({ kind: 'utterance', speaker: misha, uttId: 'p1-0', text: 'Dan, what is', final: true })).toEqual(
      [],
    );
    // Misha's VAD end, Olena still talking: Misha's utterance waits for the floor, and Jev is not asked yet.
    expect(only(call.feed({ kind: 'speech', speaker: misha, on: false }), 'judge')).toEqual([]);
    // Olena's VAD end before her final: the fallback waits for it, then the final decides, Misha's line in its window.
    call.feed({ kind: 'utterance', speaker: olena, uttId: 'p2-0', text: 'I think', final: false });
    expect(call.feed({ kind: 'speech', speaker: olena, on: false })).toEqual([
      { kind: 'wait', key: 'boundary:p2', ms: 3_700 },
    ]);
    const [judge] = only(
      call.feed({ kind: 'utterance', speaker: olena, uttId: 'p2-0', text: 'I think so', final: true }),
      'judge',
    );
    expect(judge.state.latest).toEqual({ speaker: 'Olena', text: 'I think so' });
    expect(judge.state.window.map((line) => line.text)).toContain('Dan, what is');
    expect(call.feed({ kind: 'timer', key: 'boundary:p2' })).toEqual([]);
  });

  it('in a meeting, an utterance deferred for the floor is decided once the floor is free and nothing newer came', () => {
    const call = new Call('meet');
    call.feed(
      { kind: 'speech', speaker: misha, on: true },
      { kind: 'speech', speaker: olena, on: true },
      { kind: 'utterance', speaker: misha, uttId: 'p1-0', text: 'Dan, what time is it?', final: true },
    );
    expect(only(call.feed({ kind: 'speech', speaker: misha, on: false }), 'judge')).toEqual([]);
    // Olena's speech heard nothing: past her final's wait the floor is free, and Misha's question is judged.
    expect(only(call.feed({ kind: 'speech', speaker: olena, on: false }), 'wait')).toHaveLength(1);
    const [judge] = only(call.feed({ kind: 'timer', key: 'boundary:p2' }), 'judge');
    expect(judge.state.latest).toEqual({ speaker: 'Misha', text: 'Dan, what time is it?' });
  });

  it('a stop drops the judge in flight: its verdict, asked before the stop, acts on nothing', () => {
    const call = new Call();
    wakeAndSpeak(call, 'Dan, tell me a long story.', 'Once upon a time...', 1);
    const [inFlight] = only(call.say(misha, 'u2', 'And then a joke.'), 'judge');
    expect(only(call.say(misha, 'u3', 'Stop.'), 'stop_playback')).toHaveLength(1);
    expect(call.verdict(inFlight.windowVersion, 'answer')).toEqual([]);
    expect(call.lastLog('verdict_dropped')).toMatchObject({ reason: 'superseded' });
  });

  it('on a voice call, a timer is no boundary while the VAD says the caller still speaks', () => {
    const call = new Call('voice');
    call.feed(
      { kind: 'speech', speaker: misha, on: true },
      { kind: 'utterance', speaker: misha, uttId: 'u1', text: 'So the thing', final: false },
    );
    expect(call.feed({ kind: 'timer', key: 'boundary:p1' })).toEqual([]);
  });

  it('on a voice call, waits past speech off for the final: a vocative in worker order is one turn', () => {
    const call = new Call();
    const commands = call.sayAnswered(misha, 'u1', 'Dan, what is the weather', {
      final: 'Dan, what is the weather in Kyiv?',
    });
    const turns = only(commands, 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0].message).toBe('Dan, what is the weather in Kyiv?');
    expect(only(commands, 'judge')).toHaveLength(1);
    call.feed({ kind: 'turn', key: turns[0].key, turnId: 't1' });
    expect(call.feed({ kind: 'timer', key: 'boundary:p1' })).toEqual([]);
  });

  it('on a voice call, a final in worker order that differs only in punctuation is one judge and one turn', () => {
    const call = new Call();
    const commands = call.say(misha, 'u1', 'what is the weather', {
      partial: 'what is the weather',
      final: 'What is the weather?',
    });
    const judges = only(commands, 'judge');
    expect(judges).toHaveLength(1);
    expect(judges[0].state.window).toEqual([{ t: 0.2, speaker: 'Misha', text: 'What is the weather?' }]);
    expect(call.feed({ kind: 'timer', key: 'boundary:p1' })).toEqual([]);
    const [turn] = only(call.verdict(judges[0].windowVersion, 'answer'), 'turn');
    expect(turn.message).toBe('What is the weather?');
    expect(call.logs.filter((l) => l.event === 'decision')).toHaveLength(1);
  });

  it('on a voice call whose final never comes, decides on the partial once the fallback runs out', () => {
    const call = new Call();
    const waits = only(
      call.feed(
        { kind: 'speech', speaker: misha, on: true },
        { kind: 'utterance', speaker: misha, uttId: 'u1', text: 'what is the weather', final: false },
        { kind: 'speech', speaker: misha, on: false },
      ),
      'wait',
    );
    expect(waits).toEqual([{ kind: 'wait', key: 'boundary:p1', ms: 3_700 }]);
    const [judge] = only(call.feed({ kind: 'timer', key: 'boundary:p1' }), 'judge');
    expect(judge.state.window).toEqual([expect.objectContaining({ text: 'what is the weather', partial: true })]);
    // A final after all is no second decision: it makes the verdict stale, which re-judges once.
    expect(
      call.feed({ kind: 'utterance', speaker: misha, uttId: 'u1', text: 'what is the weather in Kyiv', final: true }),
    ).toEqual([]);
    const [rejudge] = only(call.verdict(judge.windowVersion, 'answer'), 'judge');
    expect(rejudge.state.window.at(-1)).toMatchObject({ text: 'what is the weather in Kyiv' });
  });
});

describe('"Dan, stop"', () => {
  it('during generation: stops, and the late reply is shown, not spoken', () => {
    const call = new Call();
    const [turn] = only(call.sayAnswered(misha, 'u1', 'Dan, summarise the meeting.'), 'turn');
    call.feed({ kind: 'turn', key: turn.key, turnId: 't1' });
    expect(toJevState(call.state).facts.pending_answer).toBe(true);
    expect(only(call.say(misha, 'u2', 'Dan, stop.'), 'stop_playback')).toHaveLength(1);
    expect(call.lastLog('decision')).toMatchObject({ rule: 'stop', action: 'stop' });
    expect(toJevState(call.state).facts.pending_answer).toBe(false);
    expect(call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: 'The meeting covered...' })).toEqual([
      { kind: 'show', replyId: 'r1', text: 'The meeting covered...' },
    ]);
    expect(call.lastLog('reply')).toMatchObject({ outcome: 'shown', reason: 'stopped' });
  });

  it('a bare "stop" while the agent speaks stops it, and the cut-off tail enters the window', () => {
    const call = new Call();
    const replyId = wakeAndSpeak(call, 'Dan, read me the news.', 'First, the weather. Then sport.', 1);
    expect(only(call.say(misha, 'u2', 'Stop!'), 'stop_playback')).toHaveLength(1);
    call.feed({ kind: 'playback', replyId, state: 'cut_off', delivered: 'First, the weather.' });
    const jev = toJevState(call.state);
    expect(jev.window.find((l) => l.agent)).toMatchObject({ text: 'First, the weather.', cut_off: true });
    expect(jev.facts).toMatchObject({ agent_speaking: false, cut_off_after: 'First, the weather.' });
    expect(call.lastLog('playback')).toMatchObject({
      outcome: 'cut_off',
      delivered: 'First, the weather.',
      spoke_since_trigger: ['Misha'],
    });
  });

  it('a line the worker started before the stop reached it is still cut off into the window', () => {
    const call = new Call();
    const [turn] = only(call.sayAnswered(misha, 'u1', 'Dan, read me the news.'), 'turn');
    call.feed({ kind: 'turn', key: turn.key, turnId: 't1' });
    call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: 'First, the weather. Then sport.' });
    expect(only(call.say(misha, 'u2', 'Dan, stop.'), 'stop_playback')).toHaveLength(1);
    expect(toJevState(call.state).facts).toMatchObject({ agent_speaking: false, pending_answer: false });
    call.feed({ kind: 'playback', replyId: 'r1', state: 'started' });
    expect(toJevState(call.state).facts).toMatchObject({ agent_speaking: true, pending_answer: false });
    call.feed({ kind: 'playback', replyId: 'r1', state: 'cut_off', delivered: 'First,' });
    const jev = toJevState(call.state);
    expect(jev.window.find((l) => l.agent)).toMatchObject({ text: 'First,', cut_off: true });
    expect(jev.facts).toMatchObject({ agent_speaking: false, cut_off_after: 'First,' });
    expect(call.lastLog('playback')).toMatchObject({ replyId: 'r1', outcome: 'cut_off' });
  });

  it('"Dan, stop" with nothing to stop does nothing', () => {
    const call = new Call();
    expect(call.say(misha, 'u1', 'Dan, stop.').filter((c) => c.kind !== 'wait')).toEqual([]);
    expect(call.lastLog('decision')).toMatchObject({ reason: 'nothing_to_stop' });
  });

  it('a stop verdict counts only when something can be stopped', () => {
    const call = new Call();
    const [judge] = only(call.say(misha, 'u1', 'enough already'), 'judge');
    expect(call.verdict(judge.windowVersion, 'stop')).toEqual([]);
    expect(call.lastLog('decision')).toMatchObject({ action: 'stay_silent' });

    wakeAndSpeak(call, 'Dan, list every planet.', 'Mercury, Venus, Earth.', 2);
    const [second] = only(call.say(misha, 'u3', 'that is enough thanks'), 'judge');
    expect(only(call.verdict(second.windowVersion, 'stop'), 'stop_playback')).toHaveLength(1);
  });
});

describe('a cut-off, then "go on"', () => {
  it('judges with cut_off_after and turns a continue into a fresh turn saying so', () => {
    const call = new Call();
    const replyId = wakeAndSpeak(call, 'Dan, what is the forecast?', 'The forecast for Kyiv is rain.', 1);
    call.feed({ kind: 'playback', replyId, state: 'cut_off', delivered: 'The forecast for' });
    const [judge] = only(call.say(misha, 'u2', 'sorry, go on'), 'judge');
    expect(judge.state.facts.cut_off_after).toBe('The forecast for');
    const [turn] = only(call.verdict(judge.windowVersion, 'continue'), 'turn');
    expect(turn.message).toBe('sorry, go on');
    expect(turn.note).toContain('You were cut off after "The forecast for"; Misha asked you to go on.');
    expect(turn.note).toContain('Dan (you): The forecast for [cut off here]');
    expect(toJevState(call.state).facts.cut_off_after).toBeNull();
  });

  it('a continue verdict without a cut-off is not acted on', () => {
    const call = new Call();
    const [judge] = only(call.say(misha, 'u1', 'go on'), 'judge');
    expect(call.verdict(judge.windowVersion, 'continue')).toEqual([]);
  });
});

describe('replies', () => {
  it('drops [silent], trimmed and in any case', () => {
    const call = new Call();
    const [turn] = only(call.sayAnswered(misha, 'u1', 'Dan, any thoughts?'), 'turn');
    call.feed({ kind: 'turn', key: turn.key, turnId: 't1' });
    expect(call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: '  [SILENT]\n' })).toEqual([
      { kind: 'drop', replyId: 'r1' },
    ]);
    expect(toJevState(call.state).facts.pending_answer).toBe(false);
  });

  it('a newer wake supersedes an undelivered turn; a reply to the replaced turn is shown', () => {
    const call = new Call();
    const [first] = only(call.sayAnswered(misha, 'u1', 'Dan, what day is it?'), 'turn');
    const [second] = only(call.sayAnswered(misha, 'u2', 'Dan, actually, what time is it?'), 'turn');
    expect(second.supersedes).toBe(first.key);
    call.feed(
      { kind: 'turn', key: first.key, turnId: 't1', stored: { sessionId: 's', at: 2000 } },
      { kind: 'turn', key: second.key, turnId: 't2', stored: { sessionId: 's', at: 2100 } },
    );
    expect(
      call.feed({
        kind: 'reply',
        replyId: 'r1',
        turnId: 't1',
        text: 'Tuesday.',
        produced: { sessionId: 's', at: 3000 },
      }),
    ).toEqual([{ kind: 'show', replyId: 'r1', text: 'Tuesday.' }]);
    expect(call.lastLog('reply')).toMatchObject({ reason: 'replaced' });
    expect(
      call.feed({
        kind: 'reply',
        replyId: 'r2',
        turnId: 't2',
        text: 'Ten past four.',
        produced: { sessionId: 's', at: 3100 },
      }),
    ).toEqual([{ kind: 'speak', replyId: 'r2', turnId: 't2', text: 'Ten past four.' }]);
  });

  it('does not supersede a turn already delivered', () => {
    const call = new Call();
    const [first] = only(call.sayAnswered(misha, 'u1', 'Dan, what day is it?'), 'turn');
    call.feed({ kind: 'turn', key: first.key, turnId: 't1' });
    const [second] = only(call.sayAnswered(misha, 'u2', 'Dan, and the time?'), 'turn');
    expect(second.supersedes).toBeUndefined();
  });

  it('shows an unprompted reply', () => {
    const call = new Call();
    expect(call.feed({ kind: 'reply', replyId: 'r1', turnId: null, text: 'Reminder: standup.' })).toEqual([
      { kind: 'show', replyId: 'r1', text: 'Reminder: standup.' },
    ]);
  });
});

describe('verdicts', () => {
  it('re-judges a stale verdict once, then drops the next stale one', () => {
    const call = new Call('meet');
    const [judge] = only(call.say(misha, 'u1', 'who can take this ticket'), 'judge');
    call.feed({ kind: 'chat', speaker: olena, text: 'link in the doc' });
    const [rejudge] = only(call.verdict(judge.windowVersion, 'answer'), 'judge');
    expect(rejudge.windowVersion).toBeGreaterThan(judge.windowVersion);
    expect(rejudge.state.window.at(-1)).toMatchObject({ speaker: 'Olena (chat)', text: 'link in the doc' });
    expect(call.lastLog('verdict_stale')).toMatchObject({ action: 'rejudge' });

    call.feed({ kind: 'chat', speaker: olena, text: 'and the dashboard' });
    expect(call.verdict(rejudge.windowVersion, 'answer')).toEqual([]);
    expect(call.lastLog('verdict_stale')).toMatchObject({ action: 'none' });
  });

  it('drops a verdict superseded by a newer judge', () => {
    const call = new Call('meet');
    const [first] = only(call.say(misha, 'u1', 'who can take this ticket'), 'judge');
    const [second] = only(call.say(olena, 'u2', 'I can, after lunch'), 'judge');
    expect(call.verdict(first.windowVersion, 'answer')).toEqual([]);
    expect(call.lastLog('verdict_dropped')).toMatchObject({ reason: 'superseded' });
    expect(call.verdict(second.windowVersion, 'stay_silent')).toEqual([]);
  });

  it('treats a null verdict (Jev failed) as silence and logs it', () => {
    const call = new Call();
    const [judge] = only(call.say(misha, 'u1', 'what is the capital of Peru'), 'judge');
    expect(call.verdict(judge.windowVersion, null)).toEqual([]);
    expect(call.lastLog('decision')).toMatchObject({ jev: null, action: 'stay_silent', reason: 'jev_failed' });
  });

  it('answers at the probability threshold regardless of confidence', () => {
    const call = new Call();
    const [judge] = only(call.say(misha, 'u1', 'what is the capital of Peru'), 'judge');
    expect(call.verdict(judge.windowVersion, 'answer', 0.29, 0.9)).toEqual([]);
    const [again] = only(call.say(misha, 'u2', 'the capital of Peru, anyone?'), 'judge');
    const [turn] = only(call.verdict(again.windowVersion, 'answer', 0.5, 0.1), 'turn');
    expect(turn.message).toBe('what is the capital of Peru the capital of Peru, anyone?');
    expect(call.lastLog('decision')).toMatchObject({
      jev: { choice: 'answer', confidence: 0.1 },
      action: 'answer',
      ms: 400,
    });
  });
});

describe('the window', () => {
  it('grows its version monotonically, only when what Jev sees changes', () => {
    const call = new Call();
    const versions: number[] = [];
    const track = (...events: Parameters<Call['feed']>) => {
      call.feed(...events);
      versions.push(call.state.windowVersion);
    };
    track({ kind: 'speech', speaker: misha, on: true });
    track({ kind: 'utterance', speaker: misha, uttId: 'u1', text: 'hello', final: false });
    track({ kind: 'utterance', speaker: misha, uttId: 'u1', text: 'hello there', final: false });
    track({ kind: 'utterance', speaker: misha, uttId: 'u1', text: 'hello there', final: true });
    // A new participant is a change too; a final repeating the partial is not.
    expect(versions).toEqual([1, 2, 3, 3]);
  });

  it('keeps windowMs of history and at most windowBytes of text', () => {
    const call = new Call();
    call.feed({ kind: 'utterance', speaker: misha, uttId: 'old', text: 'long ago', final: true, at: 1_000 });
    call.feed({ kind: 'utterance', speaker: misha, uttId: 'new', text: 'just now', final: true, at: 400_000 });
    expect(toJevState(call.state).window.map((l) => l.text)).toEqual(['just now']);

    const big = 'x'.repeat(10_000);
    for (const id of ['a', 'b', 'c']) call.feed({ kind: 'chat', speaker: olena, text: `${id}${big}` });
    const texts = toJevState(call.state).window.map((l) => l.text[0]);
    expect(texts).toEqual(['b', 'c']);
  });
});

describe('a replacement wake', () => {
  const startTwoWakes = () => {
    const call = new Call();
    const t = 10_000;
    const sessionId = 'call-session';
    const store = (turnId: string, text: string, at: number) => {
      const [judge] = only(
        call.feed({ kind: 'utterance', speaker: misha, uttId: turnId, text, final: true, at: at - 100 }),
        'judge',
      );
      const [turn] = only(call.verdict(judge.windowVersion, 'answer'), 'turn');
      call.feed({ kind: 'turn', key: turn.key, turnId, stored: { sessionId, at }, at });
    };
    store('17', 'I have a long journey and I need an alternative route.', t);
    store('18', 'Які ще є варіанти?', t + 2400);
    const reply = (
      replyId: string,
      text: string,
      producedAt: number,
      arrival: number,
      session = sessionId,
      turnId = '17',
    ) =>
      call.feed({
        kind: 'reply',
        replyId,
        turnId,
        text,
        produced: { sessionId: session, at: t + producedAt },
        at: t + arrival,
      });
    return { call, reply };
  };

  it('shows the first turn-17 reply and speaks a further one, written after turn 18 was stored, for turn 18', () => {
    const { call, reply } = startTwoWakes();
    expect(reply('r1', 'Take the train.', 6500, 6500)).toEqual([
      { kind: 'show', replyId: 'r1', text: 'Take the train.' },
    ]);
    expect(call.lastLog('reply')).toMatchObject({ outcome: 'shown', reason: 'replaced' });
    expect(call.state.wakes.at(-1)?.replied).toBe(false);
    expect(reply('r2', 'Take the express train.', 23600, 23600)).toEqual([
      { kind: 'speak', replyId: 'r2', turnId: '18', text: 'Take the express train.' },
    ]);
    expect(call.lastLog('reply')).toMatchObject({ replyId: 'r2', turnId: '17', answeringTurnId: '18' });
    expect(call.state.wakes.at(-1)?.replied).toBe(true);
    call.feed(
      { kind: 'playback', replyId: 'r2', state: 'started' },
      { kind: 'playback', replyId: 'r2', state: 'completed' },
    );
    expect(reply('r3', 'Or a bus.', 24000, 24000)).toEqual([{ kind: 'show', replyId: 'r3', text: 'Or a bus.' }]);
    const [next] = only(call.sayAnswered(misha, 'next', 'How long does it take?'), 'turn');
    expect(next.note).toContain('Dan (you): Take the train. [shown, not spoken]');
    expect(next.note).toContain('Dan (you): Take the express train.\n');
  });

  it.each([
    ['answers turn 18 itself', '18'],
    ['comes under the older tag', '17'],
  ] as const)('speaks the real answer once after an in-flight [silent] to turn 17, when it %s', (_case, turnId) => {
    const { call, reply } = startTwoWakes();
    call.statuses = [];
    expect(reply('r1', '[silent]', 2600, 2600)).toEqual([{ kind: 'drop', replyId: 'r1' }]);
    expect(call.statuses).toEqual([]);
    expect(call.state.wakes.at(-1)?.replied).toBe(false);
    expect(reply('r2', 'Take the train.', 6500, 6500, 'call-session', turnId)).toEqual([
      { kind: 'speak', replyId: 'r2', turnId: '18', text: 'Take the train.' },
    ]);
  });

  it('rechecks a reassigned reply against turn 18 when another speaker has answered', () => {
    const { call, reply } = startTwoWakes();
    reply('first', 'Take the train.', 3000, 3000);
    call.say(olena, 'suggestion', 'There is also a train.');
    const [check] = only(reply('old-tag', 'Take the train.', 6500, 6500), 'recheck');
    expect(check.wakeKey).toBe('w2');
    expect(check.state.trigger.text).toContain('Які ще є варіанти?');
    expect(check.state.since.map((line) => line.text)).toEqual(['There is also a train.']);
    expect(call.feed({ kind: 'recheck_verdict', wakeKey: check.wakeKey, verdict: null, ms: 100 })).toEqual([
      { kind: 'speak', replyId: 'old-tag', text: 'Take the train.', turnId: '18' },
    ]);
  });

  it.each([
    ['a delayed delivery', 2399, 'call-session'],
    ['an ambiguous timestamp', 2400, 'call-session'],
    ['a different session', 6500, 'another-session'],
  ] as const)('keeps a further reply with %s shown and leaves turn 18 unanswered', (_reason, at, session) => {
    const { call, reply } = startTwoWakes();
    reply('first', 'First answer.', 2300, 2300);
    expect(reply('old', 'Earlier answer.', at, 6500, session)).toEqual([
      { kind: 'show', replyId: 'old', text: 'Earlier answer.' },
    ]);
    expect(call.lastLog('reply')).toMatchObject({ reason: 'replaced' });
    expect(call.state.wakes.at(-1)?.replied).toBe(false);
    expect(toJevState(call.state).facts.agent_last_spoke_s_ago).toBeNull();
    const [next] = only(call.sayAnswered(misha, 'next', 'Which route is fastest?'), 'turn');
    expect(next.note).toContain('Dan (you): Earlier answer. [shown, not spoken]');
  });

  it('revokes an older answer queued but not started, and records it as shown once the worker confirms no audio', () => {
    const call = new Call();
    const [first] = only(call.sayAnswered(misha, 'u1', 'Dan, what day is it?'), 'turn');
    call.feed({ kind: 'turn', key: first.key, turnId: 't1' });
    expect(call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: 'Tuesday.' })).toEqual([
      { kind: 'speak', replyId: 'r1', turnId: 't1', text: 'Tuesday.' },
    ]);
    const commands = call.sayAnswered(misha, 'u2', 'Dan, actually, what time is it?');
    expect(commands.filter((c) => c.kind === 'revoke' || c.kind === 'turn').map((c) => c.kind)).toEqual([
      'revoke',
      'turn',
    ]);
    expect(only(commands, 'revoke')).toEqual([{ kind: 'revoke', replyId: 'r1' }]);
    expect(call.lastLog('reply')).toMatchObject({ replyId: 'r1', outcome: 'revoked' });
    // The worker drops it before its first audio and reports it cut off with nothing delivered.
    call.statuses = [];
    call.feed({ kind: 'playback', replyId: 'r1', state: 'cut_off', delivered: '' });
    // The old line is gone, the agent still works on the new turn: never `idle` here.
    expect(call.statuses.map((s) => s.status)).toEqual(['thinking']);
    // Shown only, never heard: not in Jev's window, but in the agent's next note.
    const jev = toJevState(call.state);
    expect(jev.window.some((l) => l.agent)).toBe(false);
    expect(jev.facts).toMatchObject({ agent_speaking: false, pending_answer: true, cut_off_after: null });
    expect(renderWindow(call.state)).toContain('Dan (you): Tuesday. [shown, not spoken]');
  });

  it('lets a line already playing play on and revokes only what is queued behind it', () => {
    const call = new Call();
    wakeAndSpeak(call, 'Dan, read me the news.', 'First, the weather.', 1);
    call.feed({ kind: 'reply', replyId: 'r1b', turnId: 't1', text: 'Then sport.' });
    const commands = call.sayAnswered(misha, 'u2', 'Dan, what about traffic?');
    expect(only(commands, 'revoke')).toEqual([{ kind: 'revoke', replyId: 'r1b' }]);
    expect(only(commands, 'stop_playback')).toEqual([]);
    expect(toJevState(call.state).facts.agent_speaking).toBe(true);
  });

  it('revokes nothing when no answer waits to play', () => {
    const call = new Call();
    only(call.sayAnswered(misha, 'u1', 'Dan, what day is it?'), 'turn');
    expect(only(call.sayAnswered(misha, 'u2', 'Dan, and the time?'), 'revoke')).toEqual([]);
  });
});

describe('late finals', () => {
  const on: Fed = { kind: 'speech', speaker: misha, on: true };
  const off: Fed = { kind: 'speech', speaker: misha, on: false };

  it('A partial, B final (wakes), A final: no second decision on A, B stays current', () => {
    const call = new Call();
    call.feed(on, { kind: 'utterance', speaker: misha, uttId: 'a', text: 'Dan, old', final: false }, off);
    call.feed(on, { kind: 'utterance', speaker: misha, uttId: 'b', text: 'Dan, new', final: false }, off);
    const [judge] = only(
      call.feed({ kind: 'utterance', speaker: misha, uttId: 'b', text: 'Dan, new request', final: true }),
      'judge',
    );
    expect(only(call.verdict(judge.windowVersion, 'answer'), 'turn')).toHaveLength(1);
    expect(call.feed({ kind: 'utterance', speaker: misha, uttId: 'a', text: 'Dan, old request', final: true })).toEqual(
      [],
    );
    expect(call.state.speakers.p1.lastUttId).toBe('b');
    expect(toJevState(call.state).window.map((l) => l.text)).toEqual(['Dan, old request', 'Dan, new request']);
    // A's final timer, or B's, is no decision either.
    expect(call.feed({ kind: 'timer', key: 'boundary:p1' })).toEqual([]);
  });

  it('a late final of an utterance never seen before goes before the current line and decides nothing', () => {
    const call = new Call();
    call.feed(on, off, on, { kind: 'utterance', speaker: misha, uttId: 'b', text: 'what time', final: false }, off);
    const [judge] = only(
      call.feed({ kind: 'utterance', speaker: misha, uttId: 'b', text: 'what time is it', final: true }),
      'judge',
    );
    expect(call.feed({ kind: 'utterance', speaker: misha, uttId: 'a', text: 'Dan, hello', final: true })).toEqual([]);
    expect(call.state.speakers.p1.lastUttId).toBe('b');
    expect(toJevState(call.state).window.map((l) => l.text)).toEqual(['Dan, hello', 'what time is it']);
    // The verdict on B is stale (A's line arrived) and B is re-judged, not A.
    const [rejudge] = only(call.verdict(judge.windowVersion, 'answer'), 'judge');
    expect(rejudge.state.latest?.text).toBe('Dan, hello what time is it');
  });

  it("an older utterance's final while the current one awaits its own is no boundary for the current one", () => {
    const call = new Call();
    call.feed(on, { kind: 'utterance', speaker: misha, uttId: 'a', text: 'so', final: false }, off);
    call.feed(on, { kind: 'utterance', speaker: misha, uttId: 'b', text: 'Dan, what', final: false }, off);
    expect(
      only(call.feed({ kind: 'utterance', speaker: misha, uttId: 'a', text: 'so', final: true }), 'judge'),
    ).toEqual([]);
    const [judge] = only(
      call.feed({ kind: 'utterance', speaker: misha, uttId: 'b', text: 'Dan, what is the time?', final: true }),
      'judge',
    );
    expect(judge.state.latest).toEqual({ speaker: 'Misha', text: 'so Dan, what is the time?' });
    expect(judge.state.facts.addressed_by_name).toBe(true);
  });

  it('two finals of utterances never seen as partials, in order, are each decided', () => {
    const call = new Call('meet');
    call.feed(on, off, on, off);
    expect(
      only(
        call.feed({ kind: 'utterance', speaker: misha, uttId: 'a', text: 'who has the link', final: true }),
        'judge',
      ),
    ).toHaveLength(1);
    expect(
      only(
        call.feed({ kind: 'utterance', speaker: misha, uttId: 'b', text: 'the dashboard one', final: true }),
        'judge',
      ),
    ).toHaveLength(1);
  });
});

describe('a verdict after the speaker resumed', () => {
  it('is deferred, not acted on, and the next boundary decides', () => {
    const call = new Call();
    const [judge] = only(call.say(misha, 'u1', 'what is the capital of France'), 'judge');
    call.feed({ kind: 'speech', speaker: misha, on: true });
    expect(call.verdict(judge.windowVersion, 'answer')).toEqual([]);
    expect(call.lastLog('verdict_deferred')).toMatchObject({ choice: 'answer' });
    // They resumed with words: the new utterance is decided, with the first in its window.
    call.feed({ kind: 'utterance', speaker: misha, uttId: 'u2', text: 'and of Spain', final: false });
    call.feed({ kind: 'speech', speaker: misha, on: false });
    const [next] = only(
      call.feed({ kind: 'utterance', speaker: misha, uttId: 'u2', text: 'and of Spain?', final: true }),
      'judge',
    );
    expect(next.state.latest?.text).toBe('what is the capital of France and of Spain?');
    expect(next.state.window.map((l) => l.text)).toEqual(['what is the capital of France', 'and of Spain?']);
    expect(only(call.verdict(next.windowVersion, 'answer'), 'turn')).toHaveLength(1);
  });

  it('when the resumed speech has no words, the same utterance is decided again at its end', () => {
    const call = new Call();
    const [judge] = only(call.say(misha, 'u1', 'what is the capital of France'), 'judge');
    call.feed({ kind: 'speech', speaker: misha, on: true });
    expect(call.verdict(judge.windowVersion, 'answer')).toEqual([]);
    const [again] = only(call.feed({ kind: 'speech', speaker: misha, on: false }), 'judge');
    expect(again.state.latest?.text).toBe('what is the capital of France');
    const [turn] = only(call.verdict(again.windowVersion, 'answer'), 'turn');
    expect(turn.message).toBe('what is the capital of France');
  });

  it('in a meeting, waits while anyone speaks and decides once the floor is free', () => {
    const call = new Call('meet');
    const [judge] = only(call.say(misha, 'u1', 'can someone check the logs'), 'judge');
    call.feed({ kind: 'speech', speaker: olena, on: true });
    expect(call.verdict(judge.windowVersion, 'answer')).toEqual([]);
    expect(call.lastLog('verdict_deferred')).toBeDefined();
    // Olena's speech had no words: her boundary (the fallback timer) decides nothing new, so Misha's request is.
    call.feed({ kind: 'speech', speaker: olena, on: false });
    const [again] = only(call.feed({ kind: 'timer', key: 'boundary:p2' }), 'judge');
    expect(again.state.latest).toEqual({ speaker: 'Misha', text: 'can someone check the logs' });
  });

  it('in a meeting, a newer utterance decided meanwhile takes over the deferred one', () => {
    const call = new Call('meet');
    const [judge] = only(call.say(misha, 'u1', 'can someone check the logs'), 'judge');
    call.feed({ kind: 'speech', speaker: olena, on: true });
    expect(call.verdict(judge.windowVersion, 'answer')).toEqual([]);
    call.feed(
      { kind: 'utterance', speaker: olena, uttId: 'o1', text: 'I will', final: false },
      { kind: 'speech', speaker: olena, on: false },
    );
    const [next] = only(
      call.feed({ kind: 'utterance', speaker: olena, uttId: 'o1', text: 'I will.', final: true }),
      'judge',
    );
    expect(next.state.latest).toEqual({ speaker: 'Olena', text: 'I will.' });
    expect(call.verdict(next.windowVersion, 'stay_silent')).toEqual([]);
    expect(call.feed({ kind: 'timer', key: 'boundary:p1' })).toEqual([]);
  });
});

describe('continuing a turn before playback', () => {
  const speaker = { id: 'caller', name: 'Caller' };
  const reply: Fed = { kind: 'reply', replyId: 'r1', turnId: 't1', text: 'The first answer.' };
  const say = (uttId: string, text: string, at?: number): Fed => ({
    kind: 'utterance',
    speaker,
    uttId,
    text,
    final: true,
    ...(at === undefined ? {} : { at }),
  });
  const speakR1: Command = { kind: 'speak', replyId: 'r1', turnId: 't1', text: 'The first answer.' };
  const ready = (replyId = 'r1', requestId = 'q1'): Fed => ({ kind: 'play_ready', replyId, requestId });
  const allow = (replyId = 'r1', requestId = 'q1'): Command => ({ kind: 'allow_play', replyId, requestId });

  /** The caller asks, Jev answers, the turn is stored; the caller starts speaking again before the reply plays. */
  function resumed(kind: CallKind = 'voice', question = 'Can you check'): Call {
    const call = new Call(kind);
    call.sayAnswered(speaker, 'a', question);
    call.feed({ kind: 'turn', key: 'w1', turnId: 't1' }, { kind: 'speech', speaker, on: true, uttId: 'b' });
    return call;
  }

  it('waits through the fragment, quiet and late final, then speaks only the replacement', () => {
    const call = new Call();
    const trigger = 'Can you help me understand';
    const [first] = only(call.feed(say('a', trigger, 1000)), 'judge');
    call.feed({
      kind: 'verdict',
      windowVersion: first.windowVersion,
      ms: 260,
      at: 1260,
      verdict: {
        action: 'answer',
        probabilities: { answer: 0.66, stop: 0, continue: 0, stay_silent: 0.34 },
        confidence: 0.66,
      },
    });
    call.feed({ kind: 'turn', key: 'w1', turnId: 't1' });
    const beforeFinal = call.feed(
      { kind: 'speech', speaker, on: true, uttId: 'c', at: 1520 },
      say('b', 'whether', 3900),
      { ...reply, at: 5090 },
      { kind: 'play_ready', replyId: 'r1', requestId: 'old', at: 5200 },
      { kind: 'speech', speaker, on: false, at: 11150 },
    );
    // Synthesized at once; no grant while the caller finishes.
    expect(beforeFinal.filter((c) => c.kind !== 'wait')).toEqual([speakR1]);
    const merged = trigger + ' whether the library is open?';
    const [judge] = only(call.feed(say('c', 'the library is open?', 11160)), 'judge');
    expect(judge.state.latest?.text).toBe(merged);
    const result = call.verdict(judge.windowVersion, 'answer');
    expect(only(result, 'revoke').map((c) => c.replyId)).toEqual(['r1']);
    expect(only(result, 'allow_play')).toEqual([]);
    expect(only(result, 'turn').map((c) => c.message)).toEqual([merged]);
    call.feed({ kind: 'turn', key: 'w2', turnId: 't2' });
    expect(call.feed({ ...reply, turnId: 't2', replyId: 'r2', text: 'It opens at ten.' })).toEqual([
      { kind: 'speak', replyId: 'r2', turnId: 't2', text: 'It opens at ten.' },
    ]);
    expect(call.feed({ kind: 'play_ready', replyId: 'r1', requestId: 'old' })).toEqual([]);
    expect(call.feed(ready('r2', 'new'))).toEqual([allow('r2', 'new')]);
    call.feed(
      { kind: 'playback', replyId: 'r1', state: 'cut_off', delivered: '' },
      { kind: 'playback', replyId: 'r2', state: 'started' },
      { kind: 'playback', replyId: 'r2', state: 'completed' },
    );
    expect(call.state.agentLines.map((l) => [l.state, l.text])).toEqual([
      ['shown', reply.text],
      ['done', 'It opens at ten.'],
    ]);
  });

  it('speaks only the answer to the merged turn when the fragment answer lands after it was stored', () => {
    const call = new Call();
    const session = 'call-session';
    const [first] = only(call.feed(say('a', 'Can you help me understand', 1000)), 'judge');
    only(call.verdict(first.windowVersion, 'answer'), 'turn');
    call.feed({ kind: 'turn', key: 'w1', turnId: '17', stored: { sessionId: session, at: 1300 }, at: 1300 });
    call.feed(
      { kind: 'speech', speaker, on: true, uttId: 'b', at: 1520 },
      { kind: 'speech', speaker, on: false, at: 3000 },
    );
    const [judge] = only(call.feed(say('b', 'whether the library is open?', 3100)), 'judge');
    only(call.verdict(judge.windowVersion, 'answer'), 'turn');
    call.feed({ kind: 'turn', key: 'w2', turnId: '18', stored: { sessionId: session, at: 3400 }, at: 3400 });
    const fragment: Fed = {
      kind: 'reply',
      replyId: 'r1',
      turnId: '17',
      text: 'Sure, what about?',
      produced: { sessionId: session, at: 4000 },
      at: 4000,
    };
    expect(call.feed(fragment)).toEqual([{ kind: 'show', replyId: 'r1', text: 'Sure, what about?' }]);
    const answer: Fed = {
      kind: 'reply',
      replyId: 'r2',
      turnId: '18',
      text: 'It opens at ten.',
      produced: { sessionId: session, at: 6000 },
      at: 6000,
    };
    expect(call.feed(answer)).toEqual([{ kind: 'speak', replyId: 'r2', turnId: '18', text: 'It opens at ten.' }]);
    expect(call.feed(ready('r2'))).toEqual([allow('r2')]);
  });

  it('waits for outstanding finals in either order and takes back the queued answer on stop', () => {
    const call = resumed();
    call.feed({ kind: 'speech', speaker, on: false }, { kind: 'speech', speaker, uttId: 'c', on: true });
    call.feed({ kind: 'speech', speaker, on: false });
    expect(call.feed(reply, say('c', ''), ready())).toEqual([speakR1]);
    const [judge] = only(call.feed(say('b', 'the library hours')), 'judge');
    expect(judge.state.latest?.text).toBe('Can you check the library hours');
    const result = call.verdict(judge.windowVersion, 'stop');
    expect(only(result, 'stop_playback')).toHaveLength(1);
    expect(only(result, 'allow_play')).toEqual([]);
    expect(Object.keys(call.state.playout)).toEqual([]);
    expect(Object.keys(call.state.stoppedPlayout)).toEqual(['r1']);
  });

  it.each([
    ['a wordless piece', '', 'allow'],
    ['a piece with words', 'the library hours', 'judge'],
  ] as const)('settles %s whose final never comes when the boundary timer fires', (_case, partial, outcome) => {
    const call = resumed();
    if (partial) call.feed({ kind: 'utterance', speaker, uttId: 'b', text: partial, final: false });
    const [wait] = only(call.feed({ kind: 'speech', speaker, on: false }), 'wait');
    expect(wait.key).toBe('boundary:caller');
    expect(call.feed(reply, ready())).toEqual([speakR1]);
    const fired = call.feed({ kind: 'timer', key: wait.key });
    if (outcome === 'allow') expect(fired).toEqual([allow()]);
    else expect(only(fired, 'judge').map((j) => j.state.latest?.text)).toEqual(['Can you check the library hours']);
  });

  it('arms the boundary timer when an earlier piece is still open after a later final', () => {
    const call = resumed();
    call.feed({ kind: 'speech', speaker, on: false }, { kind: 'speech', speaker, uttId: 'c', on: true });
    call.feed({ kind: 'utterance', speaker, uttId: 'c', text: 'please', final: true });
    expect(only(call.feed({ kind: 'speech', speaker, on: false }), 'wait')).toHaveLength(1);
  });

  it('releases the original answer after a backchannel final', () => {
    const call = new Call();
    call.sayAnswered(speaker, 'a', 'When does the library open?');
    call.feed({ kind: 'turn', key: 'w1', turnId: 't1' }, { kind: 'speech', speaker, on: true, uttId: 'b' });
    expect(call.feed(reply, ready())).toEqual([speakR1]);
    call.feed({ kind: 'speech', speaker, on: false });
    expect(call.feed(say('b', 'угу'))).toEqual([allow()]);
  });

  it('opens no hold on a speech start without an uttId', () => {
    const call = new Call();
    call.sayAnswered(speaker, 'a', 'When does the library open?');
    call.feed({ kind: 'turn', key: 'w1', turnId: 't1' }, { kind: 'speech', speaker, on: true });
    expect(call.state.wakes.at(-1)?.continuation).toBeUndefined();
    call.feed({ kind: 'speech', speaker, on: false });
    expect(call.feed(reply, ready())).toEqual([speakR1, allow()]);
  });

  it('keeps a queued reply held after stay_silent and revokes it on a later answer', () => {
    const call = new Call('meet');
    call.feed({ kind: 'presence', speaker: olena, joined: true }, { kind: 'presence', speaker, joined: true });
    call.sayAnswered(speaker, 'a', 'Can you check');
    call.feed({ kind: 'turn', key: 'w1', turnId: 't1' }, reply);
    const [judge] = only(call.say(speaker, 'b', 'the opening hours'), 'judge');
    expect(judge.state.latest?.text).toBe('Can you check the opening hours');
    expect(call.feed(ready())).toEqual([]);
    expect(call.verdict(judge.windowVersion, 'stay_silent')).toEqual([{ kind: 'wait', key: 'hold:w1', ms: 3000 }]);
    const result = call.sayAnswered(speaker, 'c', 'for the library?');
    expect(only(result, 'turn').map((c) => c.message)).toEqual(['Can you check the opening hours for the library?']);
    expect(only(result, 'revoke').map((c) => c.replyId)).toEqual(['r1']);
    expect(only(result, 'allow_play')).toEqual([]);
    // The hold timer of the replaced wake does nothing.
    expect(call.feed({ kind: 'timer', key: 'hold:w1' })).toEqual([]);
  });

  /** The caller adds words, the reply lands meanwhile and Jev's verdict on the merged turn is `verdict`. */
  function heldAfter(verdict: Action | null): { call: Call; commands: Command[] } {
    const call = resumed();
    call.feed({ kind: 'speech', speaker, on: false }, reply, ready());
    const [judge] = only(call.feed(say('b', 'the opening hours')), 'judge');
    return { call, commands: call.verdict(judge.windowVersion, verdict) };
  }
  const recheck = (call: Call, action: 'speak' | 'show' | null) =>
    call.feed({
      kind: 'recheck_verdict',
      wakeKey: 'w1',
      verdict: action && {
        action,
        probabilities: { speak: action === 'speak' ? 0.9 : 0.1, show: action === 'show' ? 0.9 : 0.1 },
        confidence: 0.8,
      },
      ms: 300,
    });

  it.each([
    ['speak', [allow()]],
    ['show', [{ kind: 'revoke', replyId: 'r1' }]],
    [null, [allow()]],
  ] as const)('after stay_silent and quiet, the held answer goes to the answer-ready check (%s)', (action, after) => {
    const { call, commands } = heldAfter('stay_silent');
    expect(commands).toEqual([{ kind: 'wait', key: 'hold:w1', ms: 3000 }]);
    const [check] = only(call.feed({ kind: 'timer', key: 'hold:w1' }), 'recheck');
    expect(check.state.reply).toBe(reply.text);
    expect(check.state.since.map((l) => l.text)).toEqual(['the opening hours']);
    expect(call.feed(ready('r1', 'q2'))).toEqual([]);
    expect(recheck(call, action)).toEqual(after.map((c) => (c.kind === 'allow_play' ? allow('r1', 'q2') : c)));
  });

  it('a failed Jev call on the merged turn sends the held answer to the check at once', () => {
    const { call, commands } = heldAfter(null);
    expect(only(commands, 'recheck').map((c) => c.wakeKey)).toEqual(['w1']);
    expect(recheck(call, null)).toEqual([allow()]);
  });

  it.each([
    ['the hold wait', false],
    ['the answer-ready check', true],
  ] as const)('listening that starts during %s plays the queued answer and holds the draft', (_, checking) => {
    const { call } = heldAfter('stay_silent');
    if (checking) expect(only(call.feed({ kind: 'timer', key: 'hold:w1' }), 'recheck')).toHaveLength(1);
    expect(only(call.feed({ kind: 'listen', on: true }), 'allow_play')).toEqual([allow()]);
    expect(call.feed({ kind: 'timer', key: 'hold:w1' })).toEqual([]);
    expect(recheck(call, 'show')).toEqual([]);
    expect(only(call.say(speaker, 'd', 'And tomorrow'), 'turn')).toEqual([]);
    expect(only(call.say(speaker, 'e', 'Zulu.'), 'turn').map((turn) => turn.message)).toEqual(['And tomorrow']);
  });

  it('the hold timer waits while the caller speaks again, and their next boundary decides', () => {
    const { call } = heldAfter('stay_silent');
    call.feed({ kind: 'speech', speaker, on: true, uttId: 'c' });
    expect(call.feed({ kind: 'timer', key: 'hold:w1' })).toEqual([]);
    call.feed({ kind: 'speech', speaker, on: false });
    const [judge] = only(call.feed(say('c', 'for the library?')), 'judge');
    expect(only(call.verdict(judge.windowVersion, 'answer'), 'revoke').map((c) => c.replyId)).toEqual(['r1']);
  });

  it.each([
    ['words', false, 'I think the web one shipped on Monday'],
    ['words and a cough', true, 'I think the web one shipped on Monday'],
    ['words and a cough, the other sound wordless', true, null],
  ] as const)(
    "in a meeting, a held speaker's %s under another speaker wait for the floor, then the merged turn is judged",
    (_, cough, olenaSays) => {
      const call = new Call('meet');
      call.realTimers = true;
      call.feed({ kind: 'presence', speaker: olena, joined: true }, { kind: 'presence', speaker, joined: true });
      call.sayAnswered(speaker, 'a', 'Can you check the release notes');
      call.feed({ kind: 'turn', key: 'w1', turnId: 't1' }, { kind: 'speech', speaker, on: true, uttId: 'b' });
      const quietAt = call.state.now + 6_000;
      const underOlena = call.feed(
        reply,
        ready(),
        { kind: 'speech', speaker: olena, on: true },
        { kind: 'speech', speaker, on: false },
        say('b', 'for the mobile app'),
        ...(cough
          ? ([
              { kind: 'speech', speaker, on: true, uttId: 'c' },
              { kind: 'speech', speaker, on: false },
              say('c', ''),
            ] as Fed[])
          : []),
        // Olena talks on, well past the hold's 3 s.
        { kind: 'speech', speaker: olena, on: false, at: quietAt },
      );
      // Nothing is released into the answer-ready check or played while Olena has the floor.
      expect(underOlena.filter((c) => c.kind !== 'wait')).toEqual([speakR1]);
      const merged = 'Can you check the release notes for the mobile app';
      let judges: Extract<Command, { kind: 'judge' }>[];
      if (olenaSays) {
        const [olenaJudge] = only(
          call.feed({ kind: 'utterance', speaker: olena, uttId: 'o1', text: olenaSays, final: true }),
          'judge',
        );
        expect(olenaJudge.state.latest?.text).toBe(olenaSays);
        judges = only(call.verdict(olenaJudge.windowVersion, 'stay_silent'), 'judge');
      } else {
        // Olena's sound had no words: her boundary or the hold's bound, whichever comes first, decides the held turn.
        judges = only(call.until(call.state.now + 5_000), 'judge');
      }
      expect(judges.map((j) => j.state.latest?.text)).toEqual([merged]);
      const result = call.verdict(judges[0].windowVersion, 'answer');
      expect(only(result, 'revoke').map((c) => c.replyId)).toEqual(['r1']);
      expect(only(result, 'turn').map((c) => c.message)).toEqual([merged]);
    },
  );

  it("in a meeting, a held speaker's addition judged stay_silent after the floor freed releases the answer 3 s later", () => {
    const call = new Call('meet');
    call.realTimers = true;
    call.feed({ kind: 'presence', speaker: olena, joined: true }, { kind: 'presence', speaker, joined: true });
    call.sayAnswered(speaker, 'a', 'Can you check the release notes');
    call.feed({ kind: 'turn', key: 'w1', turnId: 't1' }, { kind: 'speech', speaker, on: true, uttId: 'b' });
    const quietAt = call.state.now + 6_000;
    call.feed(
      reply,
      ready(),
      { kind: 'speech', speaker: olena, on: true },
      { kind: 'speech', speaker, on: false },
      say('b', 'for the mobile app'),
      { kind: 'speech', speaker: olena, on: false, at: quietAt },
    );
    const [judge] = only(call.until(call.state.now + 5_000), 'judge');
    expect(call.verdict(judge.windowVersion, 'stay_silent')).toEqual([{ kind: 'wait', key: 'hold:w1', ms: 3000 }]);
    expect(only(call.until(call.state.now + 3_000), 'recheck')).toHaveLength(1);
  });

  describe('a held speaker in a meeting adds words while others talk', () => {
    const anna: Speaker = { id: 'p3', name: 'Anna' };
    const merged = 'Can you check the release notes for the mobile app';
    const spoke = (who: Speaker, on: boolean, at: number): Fed => ({ kind: 'speech', speaker: who, on, at });
    const said = (who: Speaker, uttId: string, text: string, at: number): Fed => ({
      kind: 'utterance',
      speaker: who,
      uttId,
      text,
      final: true,
      at,
    });

    /** The caller's answer is ready while they add "for the mobile app" under Olena: the hold ticks at 7.3 and 10.3 s. */
    function addedUnderOlena(...others: Speaker[]): Call {
      const call = new Call('meet');
      call.realTimers = true;
      call.feed(...[speaker, olena, ...others].map((who): Fed => ({ kind: 'presence', speaker: who, joined: true })));
      call.sayAnswered(speaker, 'a', 'Can you check the release notes');
      call.feed(
        { kind: 'turn', key: 'w1', turnId: 't1' },
        { kind: 'speech', speaker, on: true, uttId: 'b', at: 3_000 },
        spoke(olena, true, 3_200),
        { ...reply, at: 3_500 },
        ready(),
        spoke(speaker, false, 4_000),
        say('b', 'for the mobile app', 4_300),
      );
      return call;
    }

    /** Jev on whatever it is asked, in order: the merged question needs a new answer, the others' talk does not. */
    function jevDecides(call: Call): Command[] {
      const out: Command[] = [];
      for (let i = 0; call.state.judging && i < 5; i++) {
        const { version, trigger } = call.state.judging;
        out.push(...call.verdict(version, trigger === merged ? 'answer' : 'stay_silent'));
      }
      return out;
    }

    function expectMergedTurn(out: Command[]): void {
      expect(only(out, 'recheck')).toEqual([]);
      expect(only(out, 'allow_play')).toEqual([]);
      expect(only(out, 'revoke').map((c) => c.replyId)).toEqual(['r1']);
      expect(only(out, 'turn').map((c) => c.message)).toEqual([merged]);
    }

    it("a hold tick during another speaker's judge waits for that verdict, then the merged turn is judged", () => {
      const call = addedUnderOlena();
      const out = call.feed(spoke(olena, false, 9_900));
      const [olenaJudge] = only(
        call.feed(said(olena, 'o1', 'I think we shipped the web one on Monday', 10_100)),
        'judge',
      );
      expect(olenaJudge.state.latest?.text).toBe('I think we shipped the web one on Monday');
      // The hold ticks at 10.3 s, before Jev's verdict on Olena: it waits again instead of releasing the old answer.
      expect(call.until(10_400)).toEqual([{ kind: 'wait', key: 'hold:w1', ms: 3000 }]);
      out.push(...jevDecides(call), ...call.until(call.state.now + 10_000));
      expectMergedTurn(out);
    });

    it("with a third participant, another speaker's deferred words do not stand in for the held speaker's", () => {
      const call = addedUnderOlena(anna);
      // Anna starts before Olena ends, so Olena's words are deferred too and take the one deferred slot.
      const out = call.feed(
        spoke(anna, true, 7_900),
        spoke(olena, false, 8_000),
        said(olena, 'o1', 'I think we shipped the web one on Monday', 8_300),
        spoke(anna, false, 10_000),
      );
      // The hold ticks at 10.3 s with the floor free and no judge in flight; Anna's final is still on its way.
      out.push(...call.until(10_400), ...call.feed(said(anna, 'n1', 'no, that was the week before', 10_800)));
      out.push(...jevDecides(call), ...call.until(call.state.now + 10_000));
      expectMergedTurn(out);
    });

    it("another speaker's judge replacing the merged turn's in flight does not let the hold tick release", () => {
      const call = addedUnderOlena(anna);
      call.feed(spoke(olena, false, 6_000));
      const [olenaJudge] = only(
        call.feed(said(olena, 'o1', 'I think we shipped the web one on Monday', 6_200)),
        'judge',
      );
      const [mergedJudge] = only(call.verdict(olenaJudge.windowVersion, 'stay_silent'), 'judge');
      expect(mergedJudge.state.latest?.text).toBe(merged);
      // Anna's short remark is judged in its place before that verdict; the hold ticks at 7.3 s meanwhile.
      const out = call.feed(spoke(anna, true, 6_700), spoke(anna, false, 6_900), said(anna, 'n1', 'right', 7_100));
      expect(call.state.judging?.speakerId).toBe(anna.id);
      out.push(...call.until(7_400));
      out.push(...jevDecides(call), ...call.until(call.state.now + 10_000));
      expectMergedTurn(out);
    });

    it('a hold with nothing left to decide ends 3 s after its verdict, though others talk on', () => {
      const call = new Call('meet');
      call.realTimers = true;
      call.feed(...[speaker, olena, anna].map((who): Fed => ({ kind: 'presence', speaker: who, joined: true })));
      call.sayAnswered(speaker, 'a', 'Can you check the release notes');
      call.feed({ kind: 'turn', key: 'w1', turnId: 't1' }, reply, { kind: 'speech', speaker, on: true, uttId: 'b' });
      call.feed(ready(), spoke(speaker, false, call.state.now + 400));
      const [judge] = only(call.feed(say('b', 'thanks in advance')), 'judge');
      expect(call.verdict(judge.windowVersion, 'stay_silent')).toEqual([{ kind: 'wait', key: 'hold:w1', ms: 3000 }]);
      const verdictAt = call.state.now;
      // Olena and Anna talk across the whole hold, one picking up as the other stops.
      call.feed(spoke(olena, true, verdictAt + 400), spoke(anna, true, verdictAt + 2_000));
      call.feed(spoke(olena, false, verdictAt + 2_500));
      expect(only(call.until(verdictAt + 3_000), 'recheck').map((c) => c.wakeKey)).toEqual(['w1']);
    });

    it('a wordless sound from the held speaker under another speaker does not keep a decided hold waiting', () => {
      const call = new Call('meet');
      call.realTimers = true;
      call.feed(...[speaker, olena, anna].map((who): Fed => ({ kind: 'presence', speaker: who, joined: true })));
      call.sayAnswered(speaker, 'a', 'Can you check the release notes');
      call.feed({ kind: 'turn', key: 'w1', turnId: 't1' }, reply, { kind: 'speech', speaker, on: true, uttId: 'b' });
      call.feed(ready(), spoke(speaker, false, call.state.now + 400));
      const [judge] = only(call.feed(say('b', 'thanks in advance')), 'judge');
      expect(call.verdict(judge.windowVersion, 'stay_silent')).toEqual([{ kind: 'wait', key: 'hold:w1', ms: 3000 }]);
      const verdictAt = call.state.now;
      // Olena talks across the whole hold; the held speaker coughs under her and STT settles it with an empty final.
      call.feed(
        spoke(olena, true, verdictAt + 400),
        { kind: 'speech', speaker, on: true, uttId: 'c', at: verdictAt + 900 },
        spoke(speaker, false, verdictAt + 1_200),
        say('c', '', verdictAt + 1_600),
      );
      expect(only(call.until(verdictAt + 3_000), 'recheck').map((c) => c.wakeKey)).toEqual(['w1']);
    });
  });

  it('bounds a hold whose last words were held over an older playing line (context only) from their final', () => {
    const call = new Call();
    call.realTimers = true;
    wakeAndSpeak(call, 'Read me the news.', 'First, the weather.', 1);
    // An interjection between two lines of the answer, judged a new turn.
    call.sayAnswered(misha, 'u2', 'And the traffic?');
    call.feed({ kind: 'turn', key: 'w2', turnId: 't2' }, { kind: 'speech', speaker: misha, on: true, uttId: 'u3' });
    call.feed({ kind: 'speech', speaker: misha, on: false });
    const settled = call.feed({
      kind: 'utterance',
      speaker: misha,
      uttId: 'u3',
      text: 'that is interesting',
      final: true,
      contextOnly: true,
    });
    expect(only(settled, 'wait')).toEqual([{ kind: 'wait', key: 'hold:w2', ms: 3000 }]);
    call.feed({ kind: 'reply', replyId: 'r2', turnId: 't2', text: 'Traffic is light.' });
    expect(call.feed({ kind: 'play_ready', replyId: 'r2', requestId: 'q2' })).toEqual([]);
    // Three seconds after the final, before the boundary's fallback timer.
    expect(only(call.until(call.state.now + 2_800), 'recheck').map((c) => c.wakeKey)).toEqual(['w2']);
  });

  it('a late final with the words its timer already settled does not hold the released answer again', () => {
    const call = resumed();
    call.feed({ kind: 'utterance', speaker, uttId: 'b', text: 'the opening hours', final: false });
    const [wait] = only(call.feed({ kind: 'speech', speaker, on: false }), 'wait');
    call.feed(reply, ready());
    const [judge] = only(call.feed({ kind: 'timer', key: wait.key }), 'judge');
    call.verdict(judge.windowVersion, 'stay_silent');
    expect(only(call.feed({ kind: 'timer', key: 'hold:w1' }), 'recheck')).toHaveLength(1);
    expect(recheck(call, 'speak')).toEqual([allow()]);
    expect(call.feed(say('b', 'the opening hours'))).toEqual([]);
    expect(call.state.wakes.at(-1)?.continuation).toBeUndefined();
    // The grant was lost to speech: the worker asks again and is granted.
    expect(call.feed(ready('r1', 'q2'))).toEqual([allow('r1', 'q2')]);
  });

  it('a cough during the hold neither asks Jev again nor restarts the wait', () => {
    const { call } = heldAfter('stay_silent');
    const judges = (commands: Command[]) => only(commands, 'judge');
    call.feed({ kind: 'speech', speaker, on: true, uttId: 'c', at: 20_000 });
    expect(call.feed({ kind: 'timer', key: 'hold:w1', at: 21_000 })).toEqual([]);
    call.feed({ kind: 'speech', speaker, on: false, at: 21_500 });
    const settled = call.feed({ kind: 'utterance', speaker, uttId: 'c', text: '', final: true, at: 21_600 });
    expect(judges(settled)).toEqual([]);
    expect(only(settled, 'wait')).toEqual([{ kind: 'wait', key: 'hold:w1', ms: 0 }]);
    expect(only(call.feed({ kind: 'timer', key: 'hold:w1' }), 'recheck')).toHaveLength(1);
  });

  it('a cough while the merged turn is judged asks Jev again on it, and that verdict ends the hold', () => {
    const call = resumed();
    call.feed({ kind: 'speech', speaker, on: false }, reply, ready());
    const [judge] = only(call.feed(say('b', 'the opening hours')), 'judge');
    call.feed({ kind: 'speech', speaker, on: true, uttId: 'c' }, { kind: 'speech', speaker, on: false });
    const [again] = only(call.feed(say('c', '')), 'judge');
    expect(again.state.latest?.text).toBe('Can you check the opening hours');
    expect(call.verdict(judge.windowVersion, 'stay_silent')).toEqual([]);
    expect(only(call.verdict(again.windowVersion, 'stay_silent'), 'wait')).toEqual([
      { kind: 'wait', key: 'hold:w1', ms: 3000 },
    ]);
    expect(only(call.feed({ kind: 'timer', key: 'hold:w1' }), 'recheck')).toHaveLength(1);
  });

  it.each([
    ['starts and ends before the verdict', 'before'],
    ['is still on when the verdict lands', 'during'],
    ['has ended without its empty final when the verdict lands', 'unsettled'],
  ] as const)('a wordless sound that %s does not lose the answer to the merged turn', (_, when) => {
    const call = resumed();
    call.realTimers = true;
    call.feed({ kind: 'speech', speaker, on: false }, reply, ready());
    const [judge] = only(call.feed(say('b', 'the opening hours')), 'judge');
    const out: Command[] = [];
    const verdict = () => out.push(...call.verdict(judge.windowVersion, 'answer'));
    out.push(...call.feed({ kind: 'speech', speaker, on: true, uttId: 'c' }));
    if (when === 'during') verdict();
    out.push(...call.feed({ kind: 'speech', speaker, on: false }));
    if (when === 'unsettled') verdict();
    out.push(...call.feed(say('c', '')));
    if (when === 'before') verdict();
    // Jev answers whatever it is asked again.
    for (let i = 0; call.state.judging && i < 3; i++) out.push(...call.verdict(call.state.judging.version, 'answer'));
    out.push(...call.until(call.state.now + 10_000));
    expect(only(out, 'recheck')).toEqual([]);
    expect(only(out, 'allow_play')).toEqual([]);
    expect(only(out, 'revoke').map((c) => c.replyId)).toEqual(['r1']);
    expect(only(out, 'turn').map((c) => c.message)).toEqual(['Can you check the opening hours']);
  });

  it('a hold re-opened after its release waits its full quiet again', () => {
    const { call } = heldAfter('stay_silent');
    expect(only(call.feed({ kind: 'timer', key: 'hold:w1' }), 'recheck')).toHaveLength(1);
    call.feed(
      { kind: 'speech', speaker, on: true, uttId: 'c', at: 20_000 },
      { kind: 'speech', speaker, on: false, at: 20_500 },
    );
    expect(only(call.feed({ kind: 'utterance', speaker, uttId: 'c', text: '', final: true }), 'wait')).toEqual([
      { kind: 'wait', key: 'hold:w1', ms: 3000 },
    ]);
  });

  it('a further reply to a multi-message older turn, written after the newer turn was stored, is spoken for it', () => {
    // The trade of retagging (#72 R2): the queued regime looks like the coalesced one, so "Lisbon is sunny." is
    // spoken as turn 18's answer before the real one.
    const call = new Call();
    const session = 'call-session';
    const [first] = only(call.sayAnswered(misha, 'u1', 'What is the weather in Lisbon?'), 'turn');
    call.feed({ kind: 'turn', key: first.key, turnId: '17', stored: { sessionId: session, at: 1_000 }, at: 1_000 });
    const produced = (at: number) => ({ sessionId: session, at });
    expect(
      call.feed({
        kind: 'reply',
        replyId: 'r1',
        turnId: '17',
        text: 'Let me check.',
        produced: produced(1_500),
        at: 1_500,
      }),
    ).toEqual([{ kind: 'speak', replyId: 'r1', turnId: '17', text: 'Let me check.' }]);
    call.feed(
      { kind: 'playback', replyId: 'r1', state: 'started' },
      { kind: 'playback', replyId: 'r1', state: 'completed' },
    );
    const [second] = only(call.sayAnswered(misha, 'u2', 'Actually, in Porto?'), 'turn');
    const storedAt = call.state.now + 100;
    call.feed({
      kind: 'turn',
      key: second.key,
      turnId: '18',
      stored: { sessionId: session, at: storedAt },
      at: storedAt,
    });
    expect(
      call.feed({
        kind: 'reply',
        replyId: 'r2',
        turnId: '17',
        text: 'Lisbon is sunny.',
        produced: produced(storedAt + 500),
        at: storedAt + 500,
      }),
    ).toEqual([{ kind: 'speak', replyId: 'r2', turnId: '18', text: 'Lisbon is sunny.' }]);
    expect(
      call.feed({
        kind: 'reply',
        replyId: 'r3',
        turnId: '18',
        text: 'Porto is rainy.',
        produced: produced(storedAt + 900),
        at: storedAt + 900,
      }),
    ).toEqual([{ kind: 'speak', replyId: 'r3', turnId: '18', text: 'Porto is rainy.' }]);
  });

  it('a held line that failed during its answer-ready check is not spoken again by the verdict', () => {
    const { call } = heldAfter('stay_silent');
    expect(only(call.feed({ kind: 'timer', key: 'hold:w1' }), 'recheck')).toHaveLength(1);
    call.feed({ kind: 'playback', replyId: 'r1', state: 'failed' });
    expect(recheck(call, 'speak')).toEqual([]);
    expect(call.state.agentLines.filter((l) => l.replyId === 'r1').map((l) => l.state)).toEqual(['shown']);
  });

  it('a line granted before the hold reopened is not taken into the check, nor spoken twice', () => {
    const call = new Call();
    call.sayAnswered(speaker, 'a', 'When does the library open?');
    call.feed({ kind: 'turn', key: 'w1', turnId: 't1' });
    expect(call.feed(reply, ready())).toEqual([speakR1, allow()]);
    // Speech starts before the host hears the line start.
    call.feed({ kind: 'speech', speaker, on: true, uttId: 'b' }, { kind: 'speech', speaker, on: false });
    const [judge] = only(call.feed(say('b', 'and on Sunday')), 'judge');
    call.verdict(judge.windowVersion, 'stay_silent');
    expect(only(call.feed({ kind: 'timer', key: 'hold:w1' }), 'recheck')).toEqual([]);
    call.feed(
      { kind: 'playback', replyId: 'r1', state: 'started' },
      { kind: 'playback', replyId: 'r1', state: 'completed' },
    );
    expect(call.state.agentLines.filter((l) => l.replyId === 'r1').map((l) => l.state)).toEqual(['done']);
  });
});

describe('the answer-ready recheck', () => {
  /** Misha asks in a meeting, Olena speaks before the reply lands: returns the commands of the landed reply. */
  function answeredMeanwhile(call: Call, olenaSays = 'It is Lima.'): Command[] {
    const [turn] = only(call.sayAnswered(misha, 'u1', 'Dan, what is the capital of Peru?'), 'turn');
    call.feed({ kind: 'turn', key: turn.key, turnId: 't1' });
    const [judge] = only(call.say(olena, 'o1', olenaSays), 'judge');
    call.verdict(judge.windowVersion, 'stay_silent');
    return call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: 'Lima.' });
  }

  const recheckVerdict = (call: Call, action: 'speak' | 'show' | null, p = 0.9, confidence = 0.8) =>
    call.feed({
      kind: 'recheck_verdict',
      wakeKey: 'w1',
      verdict: action && {
        action,
        probabilities: { speak: action === 'speak' ? p : 1 - p, show: action === 'show' ? p : 1 - p },
        confidence,
      },
      ms: 300,
    });

  it('nobody spoke since the trigger: speaks at once, no Jev call', () => {
    const call = new Call('meet');
    const [turn] = only(call.sayAnswered(misha, 'u1', 'Dan, what is the capital of Peru?'), 'turn');
    call.feed({ kind: 'turn', key: turn.key, turnId: 't1' });
    expect(call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: 'Lima.' })).toEqual([
      { kind: 'speak', replyId: 'r1', turnId: 't1', text: 'Lima.' },
    ]);
  });

  it('someone answered meanwhile: holds the reply, asks with the trigger, reply and lines since, and shows it', () => {
    const call = new Call('meet');
    const [recheck] = answeredMeanwhile(call);
    expect(recheck).toMatchObject({ kind: 'recheck', wakeKey: 'w1' });
    if (recheck.kind !== 'recheck') throw new Error('no recheck');
    expect(recheck.state.trigger).toEqual({ speaker: 'Misha', text: 'Dan, what is the capital of Peru?' });
    expect(recheck.state.reply).toBe('Lima.');
    expect(recheck.state.since).toEqual([expect.objectContaining({ speaker: 'Olena', text: 'It is Lima.' })]);
    expect(recheck.state.window.map((l) => l.speaker)).toEqual(['Misha', 'Olena']);
    expect(toJevState(call.state).facts.pending_answer).toBe(true);
    expect(recheckVerdict(call, 'show')).toEqual([{ kind: 'show', replyId: 'r1', text: 'Lima.' }]);
    expect(call.lastLog('recheck')).toMatchObject({
      trigger: 'Dan, what is the capital of Peru?',
      replyIds: ['r1'],
      jev: { choice: 'show', probabilities: { show: 0.9 }, confidence: 0.8 },
      ms: 300,
      outcome: 'shown',
    });
    expect(toJevState(call.state).facts.pending_answer).toBe(false);
  });

  it('speaks unless the show is over its thresholds', () => {
    const call = new Call('meet');
    answeredMeanwhile(call, 'Hmm, good question.');
    expect(recheckVerdict(call, 'show', 0.74, 0.9)).toEqual([
      { kind: 'speak', replyId: 'r1', turnId: 't1', text: 'Lima.' },
    ]);
    expect(call.lastLog('recheck')).toMatchObject({ outcome: 'spoken' });
  });

  it('shows at 0.75 even with low confidence', () => {
    const call = new Call('meet');
    answeredMeanwhile(call);
    expect(recheckVerdict(call, 'show', 0.75, 0)).toEqual([{ kind: 'show', replyId: 'r1', text: 'Lima.' }]);
  });

  it('a failed Jev call speaks: the answer was wanted a moment ago', () => {
    const call = new Call('meet');
    answeredMeanwhile(call);
    expect(recheckVerdict(call, null)).toEqual([{ kind: 'speak', replyId: 'r1', turnId: 't1', text: 'Lima.' }]);
    expect(call.lastLog('recheck')).toMatchObject({ jev: null, outcome: 'spoken', reason: 'jev_failed' });
  });

  it('holds a still_wanted verdict that crossed the original speaker resuming', () => {
    const call = new Call('meet');
    answeredMeanwhile(call);
    call.feed({ kind: 'speech', speaker: misha, on: true, uttId: 'u2' });
    // Queued for synthesis, with no grant until the resumed turn's boundary.
    expect(recheckVerdict(call, 'speak')).toEqual([{ kind: 'speak', replyId: 'r1', turnId: 't1', text: 'Lima.' }]);
    expect(call.feed({ kind: 'play_ready', replyId: 'r1', requestId: 'q1' })).toEqual([]);
    call.feed({ kind: 'speech', speaker: misha, on: false });
    const [judge] = only(
      call.feed({ kind: 'utterance', speaker: misha, uttId: 'u2', text: 'and of Chile?', final: true }),
      'judge',
    );
    expect(judge.state.latest?.text).toBe('Dan, what is the capital of Peru? and of Chile?');
    const result = call.verdict(judge.windowVersion, 'answer');
    expect(only(result, 'revoke').map((c) => c.replyId)).toEqual(['r1']);
    expect(only(result, 'allow_play')).toEqual([]);
  });

  it('a stop during the check shows the held reply, and the late verdict is ignored', () => {
    const call = new Call('meet');
    answeredMeanwhile(call);
    const commands = call.say(misha, 'u2', 'Dan, stop.');
    expect(only(commands, 'show')).toEqual([{ kind: 'show', replyId: 'r1', text: 'Lima.' }]);
    expect(only(commands, 'stop_playback')).toHaveLength(1);
    expect(call.lastLog('recheck')).toMatchObject({ outcome: 'shown', reason: 'stopped' });
    expect(recheckVerdict(call, 'speak')).toEqual([]);
  });

  it('a newer wake during the check shows the held reply', () => {
    const call = new Call('meet');
    answeredMeanwhile(call);
    const commands = call.sayAnswered(misha, 'u2', 'Dan, and of Chile?');
    expect(only(commands, 'show')).toEqual([{ kind: 'show', replyId: 'r1', text: 'Lima.' }]);
    expect(only(commands, 'turn')).toHaveLength(1);
    expect(call.lastLog('recheck')).toMatchObject({ outcome: 'shown', reason: 'replaced' });
    expect(recheckVerdict(call, 'speak')).toEqual([]);
  });

  it('a second reply to the same turn waits with the first and follows its verdict; a later one reuses it', () => {
    const call = new Call('meet');
    answeredMeanwhile(call);
    expect(call.feed({ kind: 'reply', replyId: 'r2', turnId: 't1', text: 'In Peru.' })).toEqual([]);
    expect(recheckVerdict(call, 'speak')).toEqual([
      { kind: 'speak', replyId: 'r1', turnId: 't1', text: 'Lima.' },
      { kind: 'speak', replyId: 'r2', turnId: 't1', text: 'In Peru.' },
    ]);
    // Nobody spoke since the check: no second Jev call.
    expect(call.feed({ kind: 'reply', replyId: 'r3', turnId: 't1', text: 'On the coast.' })).toEqual([
      { kind: 'speak', replyId: 'r3', turnId: 't1', text: 'On the coast.' },
    ]);
  });
});

describe('room size and probability-only routing', () => {
  it('tracks silent participants, duplicate joins and leaves', () => {
    const call = new Call('meet');
    call.feed({ kind: 'presence', speaker: misha, joined: true });
    expect(toJevState(call.state)).toMatchObject({ participants: ['Misha'], facts: { humans_in_room: 1 } });
    expect(toJevState(call.state).policy).toContain('one person');
    const version = call.state.windowVersion;
    call.feed({ kind: 'presence', speaker: misha, joined: true });
    expect(call.state.windowVersion).toBe(version);
    call.feed({ kind: 'presence', speaker: olena, joined: true });
    expect(toJevState(call.state)).toMatchObject({ participants: ['Misha', 'Olena'], facts: { humans_in_room: 2 } });
    expect(toJevState(call.state).policy).toContain('several people');
    call.feed({ kind: 'presence', speaker: olena, joined: false });
    expect(toJevState(call.state).facts.humans_in_room).toBe(1);
  });

  it('uses recent speakers as a floor for incomplete rosters, expiring them with the window', () => {
    const call = new Call('meet');
    call.feed({ kind: 'presence', speaker: misha, joined: true });
    call.say(misha, 'u1', 'hello');
    call.say(olena, 'u2', 'hello');
    expect(toJevState(call.state).facts.humans_in_room).toBe(2);
    call.feed({ kind: 'timer', key: 'tick', at: 400_000 });
    expect(toJevState(call.state).facts.humans_in_room).toBe(1);
  });

  it.each(['voice', 'meet'] as const)('accepts a 0.5 answer for one human in %s', (kind) => {
    const call = new Call(kind);
    const [judge] = only(call.say(misha, 'u1', 'What time is it?'), 'judge');
    expect(only(call.verdict(judge.windowVersion, 'answer', 0.5, 0), 'turn')).toHaveLength(1);
  });

  it('keeps voice at one human regardless of presence events', () => {
    const call = new Call();
    call.feed({ kind: 'presence', speaker: misha, joined: true }, { kind: 'presence', speaker: olena, joined: true });
    expect(toJevState(call.state).facts.humans_in_room).toBe(1);
  });

  it.each([0.69, 0.7])('requires 0.7 for multiple humans: %s', (p) => {
    const call = new Call('meet');
    call.feed({ kind: 'presence', speaker: misha, joined: true }, { kind: 'presence', speaker: olena, joined: true });
    const [judge] = only(call.say(misha, 'u1', 'What time is it?'), 'judge');
    expect(only(call.verdict(judge.windowVersion, 'answer', p, 0), 'turn')).toHaveLength(p >= 0.7 ? 1 : 0);
  });

  it.each([0.49, 0.5])('accepts 0.5 for a named question in a group: %s', (p) => {
    const call = new Call('meet');
    call.feed({ kind: 'presence', speaker: misha, joined: true }, { kind: 'presence', speaker: olena, joined: true });
    const [judge] = only(call.say(misha, 'u1', 'Dan, what time is it?'), 'judge');
    expect(only(call.verdict(judge.windowVersion, 'answer', p, 0), 'turn')).toHaveLength(p >= 0.5 ? 1 : 0);
  });

  it('makes a verdict stale when a silent human joins', () => {
    const call = new Call('meet');
    const [judge] = only(call.say(misha, 'u1', 'What time is it?'), 'judge');
    call.feed({ kind: 'presence', speaker: misha, joined: true }, { kind: 'presence', speaker: olena, joined: true });
    const commands = call.verdict(judge.windowVersion, 'answer', 0.6, 0);
    expect(only(commands, 'turn')).toEqual([]);
    expect(only(commands, 'judge')).toHaveLength(1);
  });

  it.each([0.59, 0.6])('stops on probability alone at 0.6: %s', (p) => {
    const call = new Call();
    wakeAndSpeak(call, 'Dan, hello', 'Hello there.', 1);
    const [judge] = only(call.say(misha, 'u2', 'Enough of that'), 'judge');
    expect(only(call.verdict(judge.windowVersion, 'stop', p, 0), 'stop_playback')).toHaveLength(p >= 0.6 ? 1 : 0);
  });

  it.each([
    ['voice', 0.49, 0],
    ['voice', 0.5, 1],
    ['meet', 0.69, 0],
    ['meet', 0.7, 1],
  ] as const)('continues on probability alone, at 0.5 for one caller and 0.7 in a group: %s %s', (kind, p, turns) => {
    const call = new Call(kind);
    if (kind === 'meet')
      call.feed({ kind: 'presence', speaker: misha, joined: true }, { kind: 'presence', speaker: olena, joined: true });
    const replyId = wakeAndSpeak(call, 'Dan, hello', 'Hello there.', 1);
    call.feed({ kind: 'playback', replyId, state: 'cut_off', delivered: 'Hello' });
    const [judge] = only(call.say(misha, 'u2', 'Go on'), 'judge');
    expect(only(call.verdict(judge.windowVersion, 'continue', p, 0), 'turn')).toHaveLength(turns);
  });
});

describe('one caller', () => {
  it('says idle once the line of the latest turn played out, and thinking while a newer turn still waits', () => {
    const call = new Call();
    const replyId = wakeAndSpeak(call, 'what time is it?', 'Noon.', 1);
    // A short remark while the line plays wakes a second turn; the first line then ends.
    const [second] = only(call.sayAnswered(misha, 'u2', 'and in Kyiv?'), 'turn');
    call.feed({ kind: 'turn', key: second.key, turnId: 't2' });
    call.statuses = [];
    call.feed({ kind: 'playback', replyId, state: 'completed' });
    expect(call.statuses.map((s) => s.status)).toEqual(['thinking']);
    call.feed({ kind: 'reply', replyId: 'r2', turnId: 't2', text: 'Two in the afternoon.' });
    call.feed({ kind: 'playback', replyId: 'r2', state: 'started' });
    call.statuses = [];
    call.feed({ kind: 'playback', replyId: 'r2', state: 'completed' });
    expect(call.statuses.map((s) => s.status)).toEqual(['idle']);
  });

  const silentWith = (call: Call, windowVersion: number, answer: number) =>
    call.feed({
      kind: 'verdict',
      windowVersion,
      verdict: {
        action: 'stay_silent',
        probabilities: { answer, stay_silent: 1 - answer, stop: 0, continue: 0 },
        confidence: 0.3,
      },
      ms: 300,
    });

  it.each([0.29, 0.3])('answers on p(answer) alone from 0.3, whatever Jev chose: %s', (p) => {
    const call = new Call();
    const [judge] = only(call.say(misha, 'u1', 'I have to be there at 17:12.'), 'judge');
    expect(only(silentWith(call, judge.windowVersion, p), 'turn')).toHaveLength(p >= 0.3 ? 1 : 0);
  });

  it('keeps the group bar with several humans', () => {
    const call = new Call('meet');
    call.feed({ kind: 'presence', speaker: misha, joined: true }, { kind: 'presence', speaker: olena, joined: true });
    const [judge] = only(call.say(misha, 'u1', 'I have to be there at 17:12.'), 'judge');
    expect(silentWith(call, judge.windowVersion, 0.45)).toEqual([]);
  });

  it('does not start a second turn on a weak answer while one is on its way', () => {
    const call = new Call();
    call.sayAnswered(misha, 'u1', 'what time is it?');
    const [judge] = only(call.say(misha, 'u2', 'in Lisbon I mean'), 'judge');
    expect(only(silentWith(call, judge.windowVersion, 0.4), 'turn')).toEqual([]);
  });

  it('joins the pieces a pause split, the first with its final landing after the caller resumed', () => {
    const call = new Call();
    const on: Fed = { kind: 'speech', speaker: misha, on: true };
    const off: Fed = { kind: 'speech', speaker: misha, on: false };
    call.feed(on, { kind: 'utterance', speaker: misha, uttId: 'a', text: 'Dan, tell me', final: false }, off, on);
    expect(
      call.feed({ kind: 'utterance', speaker: misha, uttId: 'a', text: 'Dan, tell me please', final: true }),
    ).toEqual([]);
    call.feed({ kind: 'utterance', speaker: misha, uttId: 'b', text: 'which', final: false }, off);
    const [judge] = only(
      call.feed({ kind: 'utterance', speaker: misha, uttId: 'b', text: 'which films are on today', final: true }),
      'judge',
    );
    expect(judge.state.latest?.text).toBe('Dan, tell me please which films are on today');
    expect(judge.state.facts.addressed_by_name).toBe(true);
    const [turn] = only(call.verdict(judge.windowVersion, 'answer'), 'turn');
    expect(turn.message).toBe('Dan, tell me please which films are on today');
  });

  it('starts a new turn after an answer or a long gap', () => {
    const call = new Call();
    const replyId = wakeAndSpeak(call, 'what time is it?', 'Noon.', 1);
    call.feed({ kind: 'playback', replyId, state: 'completed' });
    const [next] = only(call.say(misha, 'u2', 'and the weather?'), 'judge');
    expect(next.state.latest?.text).toBe('and the weather?');
    call.verdict(next.windowVersion, 'stay_silent');
    call.feed({ kind: 'timer', key: 'idle', at: 60_000 });
    const [late] = only(call.say(misha, 'u3', 'never mind'), 'judge');
    expect(late.state.latest?.text).toBe('never mind');
  });

  it('does not join pieces with several humans in the room', () => {
    const call = new Call('meet');
    call.feed({ kind: 'presence', speaker: misha, joined: true }, { kind: 'presence', speaker: olena, joined: true });
    const [first] = only(call.say(misha, 'u1', 'Olena, did it deploy'), 'judge');
    call.verdict(first.windowVersion, 'stay_silent');
    const [second] = only(call.say(misha, 'u2', 'Dan, what time is it?'), 'judge');
    expect(second.state.latest?.text).toBe('Dan, what time is it?');
  });
});

describe('repeated stop commands', () => {
  it.each([
    'stop stop',
    '\u0441\u0442\u0456\u0439 \u0441\u0442\u0456\u0439',
    '\u043f\u043e\u0447\u0435\u043a\u0430\u0439, \u043f\u043e\u0447\u0435\u043a\u0430\u0439, \u0441\u0442\u0456\u0439',
    '\u0437\u0430\u0447\u0435\u043a\u0430\u0439',
    'wait',
    'hold on',
    'hold on, stop',
  ])('stops only while speaking or pending: %s', (text) => {
    for (const phase of ['idle', 'pending', 'speaking']) {
      const call = new Call();
      if (phase === 'pending') call.sayAnswered(misha, 'u1', 'Dan, hello');
      if (phase === 'speaking') wakeAndSpeak(call, 'Dan, hello', 'Hello there.', 1);
      expect(only(call.say(misha, 'u2', text), 'stop_playback')).toHaveLength(phase === 'idle' ? 0 : 1);
    }
  });

  it.each(['wait for Anna', 'hold on to that thought', 'stop the timer', 'please'])(
    'leaves other utterances to Jev: %s',
    (text) => {
      const call = new Call();
      wakeAndSpeak(call, 'Dan, hello', 'Hello there.', 1);
      expect(only(call.say(misha, 'u2', text), 'stop_playback')).toEqual([]);
    },
  );
});

describe('meeting tile cues', () => {
  it.each(['voice', 'meet'] as const)('emits final, wake and playback cues on %s calls', (kind) => {
    const call = new Call(kind);
    call.feed({ kind: 'utterance', speaker: olena, uttId: 'empty', text: '...', final: true });
    call.feed({ kind: 'utterance', speaker: misha, uttId: 'partial', text: 'Dan', final: false });
    expect(call.statuses).toEqual([]);
    const replyId = wakeAndSpeak(call, 'Dan, what time is it?', 'Noon.', 1);
    expect(call.statuses.map((c) => c.status)).toEqual(['heard', 'thinking', 'speaking']);
    call.feed({ kind: 'playback', replyId, state: 'completed' });
    expect(call.statuses.at(-1)?.status).toBe('idle');
  });

  it.each(['cut_off', 'failed'] as const)('returns to idle when playback is %s', (state) => {
    const call = new Call('meet');
    const replyId = wakeAndSpeak(call, 'Dan, tell a story.', 'Once upon a time.', 1);
    call.feed({ kind: 'playback', replyId, state });
    expect(call.statuses.at(-1)?.status).toBe('idle');
  });

  it('returns to idle on stop before the worker acknowledges it', () => {
    const call = new Call('meet');
    wakeAndSpeak(call, 'Dan, tell a story.', 'Once upon a time.', 1);
    call.say(misha, 'stop', 'Stop.');
    expect(call.statuses.slice(-2).map((c) => c.status)).toEqual(['heard', 'idle']);
  });
});

describe('latest language facts', () => {
  it.each([
    ['\u0427\u0438 \u0442\u0438 \u0433\u043e\u0442\u043e\u0432\u0438\u0439', true, true, 'uk'],
    [
      '\u00ab\u041f\u043e\u044f\u0441\u043d\u0438\u00bb, \u0431\u0443\u0434\u044c \u043b\u0430\u0441\u043a\u0430.',
      true,
      false,
      'uk',
    ],
    ['\u0426\u0435 \u0442\u0432\u043e\u0454.', false, true, 'uk'],
    ['\u041f\u0440\u0438\u0432\u0456\u0442 \u0443\u0441\u0456\u043c.', false, false, 'uk'],
    ['"COULD" YOU explain.', true, true, 'en'],
    ['That is yours!', false, true, 'en'],
    ['Yourself and young people.', false, false, 'en'],
    ['Really?  ', true, false, 'en'],
    ['Someone asks why it works.', false, false, 'en'],
    ['\u042f\u043a \u043f\u0440\u0430\u0446\u044e\u0454 your code', true, true, 'mixed'],
    ['Hello, \u0441\u0432\u0456\u0442.', false, false, 'mixed'],
    ['123 !!!', false, false, 'other'],
    ['\u4f60\u597d?', true, false, 'other'],
  ])('classifies %s', (text, question, toYou, language) => {
    const call = new Call();
    expect(toJevState(call.state, { speaker: misha.name, text }).facts).toMatchObject({
      latest_is_question: question,
      latest_to_you: toYou,
      latest_language: language,
    });
  });

  it('defaults to false and other without latest', () => {
    expect(toJevState(new Call().state).facts).toMatchObject({
      latest_is_question: false,
      latest_to_you: false,
      latest_language: 'other',
    });
  });

  it('fingerprints question punctuation but ignores punctuation that leaves facts unchanged', () => {
    const call = new Call();
    call.feed({ kind: 'utterance', speaker: misha, uttId: 'u1', text: 'Your answer', final: false });
    const version = call.state.windowVersion;
    call.feed({ kind: 'utterance', speaker: misha, uttId: 'u1', text: 'Your answer?', final: false });
    expect(call.state.windowVersion).toBeGreaterThan(version);
    const questionVersion = call.state.windowVersion;
    call.feed({ kind: 'utterance', speaker: misha, uttId: 'u1', text: 'Your answer???', final: true });
    expect(call.state.windowVersion).toBe(questionVersion);
  });
});
