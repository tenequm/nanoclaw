/**
 * The jev runtime with a scripted core and recording ports: it runs what `decide` returns and feeds the
 * results back as events, in order, and stops cleanly. No conversation logic is under test here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallCore, CallEvent, CallPolicy, Command, JevState, RecheckState } from './core/types.js';
import { createCallRuntime, type JevTurnResult, type RuntimePorts } from './runtime.js';

const POLICY: CallPolicy = {
  kind: 'voice',
  agentName: 'Dan',
  agentAliases: [],
  paragraph: '',
  oneCaller: { paragraph: '', answer: { p: 0.5 } },
  boundaryFallbackMs: 700,
  windowMs: 90_000,
  windowBytes: 16_384,
  thresholds: {
    answer: { p: 0.7 },
    stop: { p: 0.7 },
    continue: { p: 0.7 },
  },
  recheckShow: { p: 0.7 },
};

const SPEAKER = { id: 'caller', name: 'Ethan' };
const utt = (text: string, at = 0): CallEvent => ({
  kind: 'utterance',
  speaker: SPEAKER,
  uttId: text,
  text,
  final: true,
  at,
});
const STATE = {} as JevState;

/** A core whose `decide` answers each event with what `script` returns; its state is the event list. */
function scriptedCore(script: (event: CallEvent, seen: CallEvent[]) => Command[]): CallCore<CallEvent[]> & {
  seen: CallEvent[];
} {
  const seen: CallEvent[] = [];
  return {
    seen,
    initial: () => [],
    reduce: (state, event) => {
      seen.push(event);
      return [...state, event];
    },
    decide: (state, event) => script(event, state),
  };
}

function fakePorts(overrides: Partial<RuntimePorts> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const turns: Array<{ message: string; note: string; signal: AbortSignal; resolve: (r: JevTurnResult) => void }> = [];
  const judges: Array<{ signal: AbortSignal; resolve: (v: { verdict: null; ms: number }) => void }> = [];
  const ports: RuntimePorts = {
    now: () => Date.now(),
    judge: (_state, signal) => new Promise((resolve) => judges.push({ signal, resolve })),
    recheck: async () => ({ verdict: null, ms: 0 }),
    turn: ({ message, note }, signal) => new Promise((resolve) => turns.push({ message, note, signal, resolve })),
    speak: (replyId, text) => void calls.push(['speak', replyId, text]),
    show: (replyId, text) => void calls.push(['show', replyId, text]),
    drop: (replyId) => void calls.push(['drop', replyId]),
    revoke: (replyId) => void calls.push(['revoke', replyId]),
    stopPlayback: () => void calls.push(['stop']),
    status: (status) => void calls.push(['status', status]),
    log: (event, fields) => void calls.push(['log', event, fields]),
    record: (seq, event) => void calls.push(['record', seq, event.kind]),
    ...overrides,
  };
  return { ports, calls, turns, judges };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('createCallRuntime', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('processes events one at a time in arrival order, a feed from inside a port after the current one', async () => {
    const order: string[] = [];
    const core = scriptedCore((event) => {
      order.push(`decide:${event.kind === 'utterance' ? event.text : event.kind}`);
      return event.kind === 'utterance' && event.text === 'a' ? [{ kind: 'speak', replyId: 'r1', text: 'x' }] : [];
    });
    const runtime = createCallRuntime(core, POLICY, {
      ...fakePorts().ports,
      // A port that feeds synchronously: its event must wait for the current one's commands.
      speak: () => {
        order.push('speak');
        runtime.feed(utt('c'));
        order.push('speak-returned');
      },
    });
    runtime.feed(utt('a'));
    runtime.feed(utt('b'));
    expect(order).toEqual(['decide:a', 'speak', 'speak-returned', 'decide:c', 'decide:b']);
    expect(core.seen.map((e) => (e.kind === 'utterance' ? e.text : e.kind))).toEqual(['a', 'c', 'b']);
  });

  it('runs speak, show, drop, stop and log commands through their ports and records every event', () => {
    const { ports, calls } = fakePorts();
    const core = scriptedCore(() => [
      { kind: 'speak', replyId: 'r1', text: 'hi' },
      { kind: 'show', replyId: 'r2', text: 'later' },
      { kind: 'drop', replyId: 'r3' },
      { kind: 'stop_playback' },
      { kind: 'log', event: 'decision', fields: { verdict: 'answer' } },
    ]);
    createCallRuntime(core, POLICY, ports).feed(utt('a'));
    expect(calls).toEqual([
      ['record', 1, 'utterance'],
      ['speak', 'r1', 'hi'],
      ['show', 'r2', 'later'],
      ['drop', 'r3'],
      ['stop'],
      ['log', 'decision', { verdict: 'answer' }],
    ]);
  });

  it('posts a recheck verdict back for its wake, and a new judge does not abort the check', async () => {
    const { ports, judges } = fakePorts();
    const rechecks: Array<{ signal: AbortSignal; resolve: (v: { verdict: null; ms: number }) => void }> = [];
    const core = scriptedCore((event) =>
      event.kind === 'utterance' && event.text === 'a'
        ? [{ kind: 'recheck', windowVersion: 1, wakeKey: 'w1', state: {} as RecheckState }]
        : event.kind === 'utterance'
          ? [{ kind: 'judge', windowVersion: 2, state: STATE }]
          : [],
    );
    const runtime = createCallRuntime(core, POLICY, {
      ...ports,
      recheck: (_state, signal) => new Promise((resolve) => rechecks.push({ signal, resolve })),
    });
    runtime.feed(utt('a'));
    runtime.feed(utt('b'));
    await flush();
    expect(judges).toHaveLength(1);
    expect(rechecks).toHaveLength(1);
    expect(rechecks[0].signal.aborted).toBe(false);
    rechecks[0].resolve({ verdict: null, ms: 250 });
    await vi.waitFor(() =>
      expect(core.seen.at(-1)).toMatchObject({ kind: 'recheck_verdict', wakeKey: 'w1', verdict: null, ms: 250 }),
    );
    runtime.end('test');
  });

  it('posts a verdict back with the window version it was asked on', async () => {
    const { ports, judges } = fakePorts();
    const core = scriptedCore((event) =>
      event.kind === 'utterance' ? [{ kind: 'judge', windowVersion: 7, state: STATE }] : [],
    );
    createCallRuntime(core, POLICY, ports).feed(utt('a'));
    await flush();
    expect(judges).toHaveLength(1);
    judges[0].resolve({ verdict: null, ms: 412 });
    await vi.waitFor(() => expect(core.seen.at(-1)).toMatchObject({ kind: 'verdict', windowVersion: 7, ms: 412 }));
  });

  it('aborts the judges in flight when a newer one starts', async () => {
    const { ports, judges } = fakePorts();
    let version = 0;
    const core = scriptedCore((event) =>
      event.kind === 'utterance' ? [{ kind: 'judge', windowVersion: ++version, state: STATE }] : [],
    );
    const runtime = createCallRuntime(core, POLICY, ports);
    runtime.feed(utt('a'));
    await flush();
    runtime.feed(utt('b'));
    await flush();
    expect(judges.map((j) => j.signal.aborted)).toEqual([true, false]);
  });

  it('takes a rejected judge as a null verdict', async () => {
    const { ports } = fakePorts({ judge: async () => Promise.reject(new Error('boom')) });
    const core = scriptedCore((event) =>
      event.kind === 'utterance' ? [{ kind: 'judge', windowVersion: 1, state: STATE }] : [],
    );
    createCallRuntime(core, POLICY, ports).feed(utt('a'));
    await vi.waitFor(() => expect(core.seen.at(-1)).toMatchObject({ kind: 'verdict', verdict: null }));
  });

  it('fires a wait once as a timer event; a replaced or cancelled wait never fires', async () => {
    const { ports } = fakePorts();
    const core = scriptedCore((event) => {
      if (event.kind !== 'utterance') return [];
      if (event.text === 'start') return [{ kind: 'wait', key: 'b', ms: 100 }];
      if (event.text === 'again') return [{ kind: 'wait', key: 'b', ms: 300 }];
      if (event.text === 'other') return [{ kind: 'wait', key: 'x', ms: 50 }];
      if (event.text === 'cancel') return [{ kind: 'cancel_wait', key: 'x' }];
      return [];
    });
    const runtime = createCallRuntime(core, POLICY, ports);
    runtime.feed(utt('start'));
    runtime.feed(utt('other'));
    runtime.feed(utt('cancel'));
    await vi.advanceTimersByTimeAsync(50);
    runtime.feed(utt('again'));
    await vi.advanceTimersByTimeAsync(200);
    expect(core.seen.filter((e) => e.kind === 'timer')).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(core.seen.filter((e) => e.kind === 'timer')).toEqual([{ kind: 'timer', key: 'b', at: expect.any(Number) }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(core.seen.filter((e) => e.kind === 'timer')).toHaveLength(1);
  });

  it('submits turns one at a time and reports each as turn or turn_failed', async () => {
    const { ports, turns } = fakePorts();
    const core = scriptedCore((event) =>
      event.kind === 'utterance'
        ? [{ kind: 'turn', key: `k-${event.text}`, message: event.text, note: `window ${event.text}` }]
        : [],
    );
    const runtime = createCallRuntime(core, POLICY, ports);
    runtime.feed(utt('one'));
    runtime.feed(utt('two'));
    await flush();
    expect(turns.map((t) => t.message)).toEqual(['one']);
    expect(turns[0].note).toBe('window one');
    turns[0].resolve({ ok: true, turnId: '5' });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    turns[1].resolve({ ok: false, reason: 'Too many utterances this minute' });
    await vi.waitFor(() =>
      expect(core.seen.filter((e) => e.kind === 'turn' || e.kind === 'turn_failed')).toEqual([
        { kind: 'turn', key: 'k-one', turnId: '5', at: expect.any(Number) },
        { kind: 'turn_failed', key: 'k-two', reason: 'Too many utterances this minute', at: expect.any(Number) },
      ]),
    );
  });

  it('drops a superseded turn still queued, and aborts one being submitted', async () => {
    const { ports, turns } = fakePorts();
    const core = scriptedCore((event) => {
      if (event.kind !== 'utterance') return [];
      const supersedes = { two: 'k-one', three: 'k-two' }[event.text];
      return [
        { kind: 'turn', key: `k-${event.text}`, message: event.text, note: '', ...(supersedes && { supersedes }) },
      ];
    });
    const runtime = createCallRuntime(core, POLICY, ports);
    runtime.feed(utt('one'));
    await flush();
    // `one` is being submitted: `two` aborts it; `three` replaces `two` while it waits in the queue.
    runtime.feed(utt('two'));
    expect(turns[0].signal.aborted).toBe(true);
    runtime.feed(utt('three'));
    expect(core.seen.at(-1)).toEqual({
      kind: 'turn_failed',
      key: 'k-two',
      reason: 'superseded',
      at: expect.any(Number),
    });
    turns[0].resolve({ ok: false, reason: '409: The turn was superseded' });
    await vi.waitFor(() => expect(turns.map((t) => t.message)).toEqual(['one', 'three']));
  });

  it('keeps running after the core or a port throws', () => {
    const { ports, calls } = fakePorts({
      speak: () => {
        throw new Error('stream gone');
      },
    });
    const core = scriptedCore((event) => {
      if (event.kind === 'utterance' && event.text === 'bad') throw new Error('bug');
      return [{ kind: 'speak', replyId: 'r', text: 't' }, { kind: 'stop_playback' }];
    });
    const runtime = createCallRuntime(core, POLICY, ports);
    runtime.feed(utt('bad'));
    runtime.feed(utt('good'));
    expect(calls.filter((c) => c[0] !== 'record')).toEqual([
      ['log', 'core_error', { seq: 1, event: 'utterance', err: 'bug' }],
      ['log', 'port_error', { command: 'speak', err: 'stream gone' }],
      ['stop'],
    ]);
  });

  it('shuts down cleanly: no timer fires, late results and feeds are ignored, in-flight work is aborted', async () => {
    const { ports, calls, turns, judges } = fakePorts();
    const core = scriptedCore((event) =>
      event.kind === 'utterance'
        ? [
            { kind: 'wait', key: 'b', ms: 100 },
            { kind: 'judge', windowVersion: 1, state: STATE },
            { kind: 'turn', key: 'k1', message: 'q', note: '' },
            { kind: 'turn', key: 'k2', message: 'q2', note: '' },
          ]
        : [],
    );
    const runtime = createCallRuntime(core, POLICY, ports);
    runtime.feed(utt('a'));
    await flush();
    runtime.end('hangup');
    runtime.end('again');
    expect(runtime.ended).toBe(true);
    expect(judges[0].signal.aborted).toBe(true);
    expect(turns[0].signal.aborted).toBe(true);
    judges[0].resolve({ verdict: null, ms: 1 });
    turns[0].resolve({ ok: true, turnId: '1' });
    runtime.feed(utt('late'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(core.seen.map((e) => e.kind)).toEqual(['utterance']);
    // The queued second turn was never submitted.
    expect(turns).toHaveLength(1);
    expect(calls.filter((c) => c[1] === 'call_end')).toEqual([['log', 'call_end', { reason: 'hangup', events: 1 }]]);
  });
});
