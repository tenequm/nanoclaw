/**
 * The jev call loop's pure core, driven by text fixtures: event sequences in, commands out. No
 * LiveKit, Recall or Jev; a verdict is just another event.
 */
import { describe, expect, it } from 'vitest';

import { vocativeOf } from './core/decide.js';
import { callCore, type CallState } from './core/index.js';
import type { Action, CallEvent, CallKind, Command, Speaker } from './core/types.js';
import { toJevState } from './core/window.js';
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

  constructor(kind: CallKind = 'voice') {
    this.state = callCore.initial(policyFor(kind, 'Dan', ['Ден']), 0);
  }

  /** Feed events (each 100 ms after the last unless it says otherwise); returns the action commands. */
  feed(...events: Fed[]): Command[] {
    const out: Command[] = [];
    for (const partial of events) {
      this.at = partial.at ?? this.at + 100;
      const event = { ...partial, at: this.at } as CallEvent;
      this.state = callCore.reduce(this.state, event);
      for (const command of callCore.decide(this.state, event)) {
        if (command.kind === 'log') this.logs.push(command);
        else if (command.kind === 'status') this.statuses.push(command);
        else out.push(command);
      }
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
    const probabilities = { answer: 0, stay_silent: 0, stop: 0, continue: 0 };
    if (action) {
      for (const a of Object.keys(probabilities) as Action[]) probabilities[a] = a === action ? p : (1 - p) / 3;
    }
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
    { kind: 'speak', replyId, text: answer },
  ]);
  call.feed({ kind: 'playback', replyId, state: 'started' });
  return replyId;
}

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
    const call = new Call();
    const [named] = only(call.say(misha, 'u1', 'Dan?'), 'judge');
    expect(named.state.facts.addressed_by_name).toBe(false);
    call.verdict(named.windowVersion, 'stay_silent');
    const [mention] = only(call.say(misha, 'u2', 'I told Dan about it.'), 'judge');
    expect(mention.state.facts.addressed_by_name).toBe(false);
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
    expect(call.verdict(first.windowVersion, 'answer', 0.3, 0.4)).toEqual([]);
    expect(call.lastLog('decision')).toMatchObject({ action: 'stay_silent' });

    const [second] = only(call.say(misha, 'u2', 'whether it rains tomorrow'), 'judge');
    expect(second.state.window.map((l) => l.text)).toEqual(['So what I want to know is', 'whether it rains tomorrow']);
    const [turn] = only(call.verdict(second.windowVersion, 'answer'), 'turn');
    expect(turn.message).toBe('whether it rains tomorrow');
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
    call.feed({ kind: 'turn', key: first.key, turnId: 't1' }, { kind: 'turn', key: second.key, turnId: 't2' });
    expect(call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: 'Tuesday.' })).toEqual([
      { kind: 'show', replyId: 'r1', text: 'Tuesday.' },
    ]);
    expect(call.lastLog('reply')).toMatchObject({ reason: 'replaced' });
    expect(call.feed({ kind: 'reply', replyId: 'r2', turnId: 't2', text: 'Ten past four.' })).toEqual([
      { kind: 'speak', replyId: 'r2', text: 'Ten past four.' },
    ]);
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
    expect(call.verdict(judge.windowVersion, 'answer', 0.49, 0.9)).toEqual([]);
    const [again] = only(call.say(misha, 'u2', 'the capital of Peru, anyone?'), 'judge');
    const [turn] = only(call.verdict(again.windowVersion, 'answer', 0.5, 0.1), 'turn');
    expect(turn.message).toBe('the capital of Peru, anyone?');
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
    call.feed({ kind: 'utterance', speaker: misha, uttId: 'new', text: 'just now', final: true, at: 100_000 });
    expect(toJevState(call.state).window.map((l) => l.text)).toEqual(['just now']);

    const big = 'x'.repeat(5_000);
    for (const id of ['a', 'b', 'c']) call.feed({ kind: 'chat', speaker: olena, text: `${id}${big}` });
    const texts = toJevState(call.state).window.map((l) => l.text[0]);
    expect(texts).toEqual(['b', 'c']);
  });
});

describe('a replacement wake', () => {
  it('revokes an older answer queued but not started, and nothing of it enters the window', () => {
    const call = new Call();
    const [first] = only(call.sayAnswered(misha, 'u1', 'Dan, what day is it?'), 'turn');
    call.feed({ kind: 'turn', key: first.key, turnId: 't1' });
    expect(call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: 'Tuesday.' })).toEqual([
      { kind: 'speak', replyId: 'r1', text: 'Tuesday.' },
    ]);
    const commands = call.sayAnswered(misha, 'u2', 'Dan, actually, what time is it?');
    expect(commands.filter((c) => c.kind === 'revoke' || c.kind === 'turn').map((c) => c.kind)).toEqual([
      'revoke',
      'turn',
    ]);
    expect(only(commands, 'revoke')).toEqual([{ kind: 'revoke', replyId: 'r1' }]);
    expect(call.lastLog('reply')).toMatchObject({ replyId: 'r1', outcome: 'revoked' });
    // The worker drops it before its first audio and reports it cut off with nothing delivered.
    call.feed({ kind: 'playback', replyId: 'r1', state: 'cut_off', delivered: '' });
    const jev = toJevState(call.state);
    expect(jev.window.some((l) => l.agent)).toBe(false);
    expect(jev.facts).toMatchObject({ agent_speaking: false, pending_answer: true, cut_off_after: null });
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
    expect(rejudge.state.latest?.text).toBe('what time is it');
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
    expect(judge.state.latest?.text).toBe('Dan, what is the time?');
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
    expect(next.state.latest?.text).toBe('and of Spain?');
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
      { kind: 'speak', replyId: 'r1', text: 'Lima.' },
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
    expect(recheckVerdict(call, 'show', 0.74, 0.9)).toEqual([{ kind: 'speak', replyId: 'r1', text: 'Lima.' }]);
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
    expect(recheckVerdict(call, null)).toEqual([{ kind: 'speak', replyId: 'r1', text: 'Lima.' }]);
    expect(call.lastLog('recheck')).toMatchObject({ jev: null, outcome: 'spoken', reason: 'jev_failed' });
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
      { kind: 'speak', replyId: 'r1', text: 'Lima.' },
      { kind: 'speak', replyId: 'r2', text: 'In Peru.' },
    ]);
    // Nobody spoke since the check: no second Jev call.
    expect(call.feed({ kind: 'reply', replyId: 'r3', turnId: 't1', text: 'On the coast.' })).toEqual([
      { kind: 'speak', replyId: 'r3', text: 'On the coast.' },
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
    call.feed({ kind: 'timer', key: 'tick', at: 100_000 });
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

  it.each([0.69, 0.7])('continues on probability alone at 0.7: %s', (p) => {
    const call = new Call();
    const replyId = wakeAndSpeak(call, 'Dan, hello', 'Hello there.', 1);
    call.feed({ kind: 'playback', replyId, state: 'cut_off', delivered: 'Hello' });
    const [judge] = only(call.say(misha, 'u2', 'Go on'), 'judge');
    expect(only(call.verdict(judge.windowVersion, 'continue', p, 0), 'turn')).toHaveLength(p >= 0.7 ? 1 : 0);
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
