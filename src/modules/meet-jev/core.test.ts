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
  private at = 1_000;

  constructor(kind: CallKind = 'voice') {
    this.state = callCore.initial(policyFor(kind, 'Dan', ['Ден']), 0);
  }

  /** Feed events (each 100 ms after the last unless it says otherwise); returns the non-log commands. */
  feed(...events: Fed[]): Command[] {
    const out: Command[] = [];
    for (const partial of events) {
      this.at = partial.at ?? this.at + 100;
      const event = { ...partial, at: this.at } as CallEvent;
      this.state = callCore.reduce(this.state, event);
      for (const command of callCore.decide(this.state, event)) {
        if (command.kind === 'log') this.logs.push(command);
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

  lastLog(event: string) {
    return [...this.logs].reverse().find((l) => l.event === event)?.fields;
  }
}

const only = <K extends Command['kind']>(commands: Command[], kind: K) =>
  commands.filter((c): c is Extract<Command, { kind: K }> => c.kind === kind);

/** Wake by the vocative rule, deliver the turn, land the reply and play it: returns the reply id. */
function wakeAndSpeak(call: Call, text: string, answer: string, n: number): string {
  const [turn] = only(call.say(misha, `u${n}`, text), 'turn');
  call.feed({ kind: 'turn', key: turn.key, turnId: `t${n}` });
  const replyId = `r${n}`;
  expect(call.feed({ kind: 'reply', replyId, turnId: `t${n}`, text: answer })).toEqual([
    { kind: 'speak', replyId, text: answer },
  ]);
  call.feed({ kind: 'playback', replyId, state: 'started' });
  return replyId;
}

describe('a named question', () => {
  it('wakes by the vocative rule without Jev, with the window in the note', () => {
    const call = new Call();
    const commands = call.say(misha, 'u1', "Dan, what's the weather in Kyiv?");
    expect(only(commands, 'judge')).toEqual([]);
    const [turn] = only(commands, 'turn');
    expect(turn.message).toBe("Dan, what's the weather in Kyiv?");
    expect(turn.supersedes).toBeUndefined();
    expect(turn.note).toContain("Misha: Dan, what's the weather in Kyiv?");
    expect(turn.note).toContain('reply exactly [silent]');
    expect(call.lastLog('decision')).toMatchObject({ rule: 'vocative', action: 'answer', speaker: 'Misha' });
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
    expect(vocativeOf('I told Dan to stop', ['Dan']).vocative).toBe(false);
    expect(vocativeOf('Danny, hi', ['Dan']).vocative).toBe(false);
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
    expect(judge.state.participants).toEqual(['Olena', 'Misha']);
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
  it('arms the fallback on every partial, and a meet timer is a boundary without speech_off', () => {
    const call = new Call('meet');
    const armed = call.feed({ kind: 'utterance', speaker: misha, uttId: 'u1', text: 'Any news', final: false });
    expect(armed).toEqual([{ kind: 'wait', key: 'boundary:p1', ms: 700 }]);
    call.feed({ kind: 'speech', speaker: misha, on: true });
    expect(only(call.feed({ kind: 'timer', key: 'boundary:p1' }), 'judge')).toHaveLength(1);
  });

  it('on a voice call, a timer is no boundary while the VAD says the caller still speaks', () => {
    const call = new Call('voice');
    call.feed(
      { kind: 'speech', speaker: misha, on: true },
      { kind: 'utterance', speaker: misha, uttId: 'u1', text: 'So the thing', final: false },
    );
    expect(call.feed({ kind: 'timer', key: 'boundary:p1' })).toEqual([]);
  });

  it('in a meeting, keeps the verdict on a partial when the final differs only in case and punctuation', () => {
    const call = new Call('meet');
    const [judge] = only(
      call.feed(
        { kind: 'speech', speaker: misha, on: true },
        { kind: 'utterance', speaker: misha, uttId: 'u1', text: 'what is two plus two', final: false },
        { kind: 'speech', speaker: misha, on: false },
      ),
      'judge',
    );
    call.feed({ kind: 'utterance', speaker: misha, uttId: 'u1', text: 'What is two plus two?', final: true });
    expect(call.feed({ kind: 'timer', key: 'boundary:p1' })).toEqual([]);
    expect(only(call.verdict(judge.windowVersion, 'answer'), 'turn')).toHaveLength(1);
  });

  it('on a voice call, waits past speech off for the final: a vocative in worker order is one turn', () => {
    const call = new Call();
    const commands = call.say(misha, 'u1', 'Dan, what is the weather', { final: 'Dan, what is the weather in Kyiv?' });
    const turns = only(commands, 'turn');
    expect(turns).toHaveLength(1);
    expect(turns[0].message).toBe('Dan, what is the weather in Kyiv?');
    expect(only(commands, 'judge')).toEqual([]);
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
    const [turn] = only(call.say(misha, 'u1', 'Dan, summarise the meeting.'), 'turn');
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
    const [turn] = only(call.say(misha, 'u1', 'Dan, read me the news.'), 'turn');
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
    const [turn] = only(call.say(misha, 'u1', 'Dan, any thoughts?'), 'turn');
    call.feed({ kind: 'turn', key: turn.key, turnId: 't1' });
    expect(call.feed({ kind: 'reply', replyId: 'r1', turnId: 't1', text: '  [SILENT]\n' })).toEqual([
      { kind: 'drop', replyId: 'r1' },
    ]);
    expect(toJevState(call.state).facts.pending_answer).toBe(false);
  });

  it('a newer wake supersedes an undelivered turn; a reply to the replaced turn is shown', () => {
    const call = new Call();
    const [first] = only(call.say(misha, 'u1', 'Dan, what day is it?'), 'turn');
    const [second] = only(call.say(misha, 'u2', 'Dan, actually, what time is it?'), 'turn');
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
    const [first] = only(call.say(misha, 'u1', 'Dan, what day is it?'), 'turn');
    call.feed({ kind: 'turn', key: first.key, turnId: 't1' });
    const [second] = only(call.say(misha, 'u2', 'Dan, and the time?'), 'turn');
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

  it('answers only over both thresholds', () => {
    const call = new Call();
    const [judge] = only(call.say(misha, 'u1', 'what is the capital of Peru'), 'judge');
    expect(call.verdict(judge.windowVersion, 'answer', 0.9, 0.3)).toEqual([]);
    const [again] = only(call.say(misha, 'u2', 'the capital of Peru, anyone?'), 'judge');
    const [turn] = only(call.verdict(again.windowVersion, 'answer', 0.75, 0.6), 'turn');
    expect(turn.message).toBe('the capital of Peru, anyone?');
    expect(call.lastLog('decision')).toMatchObject({
      jev: { choice: 'answer', confidence: 0.6 },
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
