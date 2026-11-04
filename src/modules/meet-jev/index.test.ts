/**
 * A jev call's wiring around the real core: the per-call Jev cap and what it logs; a meeting's policy,
 * its Recall transcript as the only source of words and speech, and the reflex's `words` push.
 */
import { describe, expect, it, vi } from 'vitest';

const { sendData } = vi.hoisted(() => ({ sendData: vi.fn() }));
vi.mock('livekit-server-sdk', () => ({
  DataPacket_Kind: { RELIABLE: 0 },
  RoomServiceClient: class {
    sendData = sendData;
  },
}));

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { LiveKitHostEvent } from '../../channels/voice-mode-protocol.js';
import { log } from '../../log.js';
import type { CallCore, CallEvent, CallPolicy, RecheckState } from './core/types.js';
import { createJevCall, MAX_JUDGES_PER_MINUTE } from './index.js';

function jevCall() {
  const clock = { now: 1_000_000 };
  const judge = vi.fn(async () => ({ verdict: null, ms: 1 }));
  const call = createJevCall(
    {
      callId: 'c1',
      callerName: 'Ethan',
      agentName: 'Andy',
      agentAliases: [],
      maxTextBytes: 4096,
      submitTurn: async () => ({ ok: false, reason: 'test' }),
      push: () => undefined,
      now: () => clock.now,
    },
    { judge },
  );
  let n = 0;
  const say = (text: string) =>
    call.workerEvents([{ type: 'utterance', uttId: `u${++n}`, text, final: true, at: clock.now }]);
  return { call, clock, judge, say };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createJevCall', () => {
  it('logs both question texts once per call', async () => {
    vi.mocked(log.info).mockClear();
    const { call, say } = jevCall();
    say('first thought');
    await flush();
    say('second thought');
    await flush();
    const questions = vi.mocked(log.info).mock.calls.filter(([message]) => message === 'meet-jev: questions');
    expect(questions).toHaveLength(1);
    expect(questions[0][1]).toMatchObject({
      callId: 'c1',
      questions: {
        action: { instructions: expect.stringContaining('Andy') },
        still_wanted: { instructions: expect.stringContaining('Andy') },
      },
    });
    call.end('test');
  });

  it('asks Jev at most MAX_JUDGES_PER_MINUTE times a minute; past it a boundary is judged silent', async () => {
    const { call, clock, judge, say } = jevCall();
    for (let i = 0; i <= MAX_JUDGES_PER_MINUTE; i++) {
      say(`thought number ${i}`);
      await flush();
    }
    expect(judge).toHaveBeenCalledTimes(MAX_JUDGES_PER_MINUTE);
    expect(log.warn).toHaveBeenCalledWith('meet-jev: Jev rate cap reached, judged without Jev', {
      callId: 'c1',
      perMinute: MAX_JUDGES_PER_MINUTE,
    });
    clock.now += 60_000;
    say('a minute later');
    await flush();
    expect(judge).toHaveBeenCalledTimes(MAX_JUDGES_PER_MINUTE + 1);
    call.end('test');
  });

  it('counts answer-ready rechecks toward the same cap; past it an answer is spoken unchecked', async () => {
    const recheck = vi.fn(async () => ({ verdict: null, ms: 1 }));
    const call = createJevCall(
      {
        callId: 'c2',
        callerName: 'Ethan',
        agentName: 'Andy',
        agentAliases: [],
        maxTextBytes: 4096,
        submitTurn: async () => ({ ok: false, reason: 'test' }),
        push: () => undefined,
        now: () => 1_000_000,
      },
      {
        core: {
          initial: () => null,
          reduce: (state) => state,
          decide: (_state, event) =>
            event.kind === 'reply'
              ? [{ kind: 'recheck', windowVersion: 1, wakeKey: 'w1', state: {} as RecheckState }]
              : [],
        },
        judge: async () => ({ verdict: null, ms: 0 }),
        recheck,
      },
    );
    for (let i = 0; i <= MAX_JUDGES_PER_MINUTE; i++) {
      call.reply(`answer ${i}`, 't1');
      await flush();
    }
    expect(recheck).toHaveBeenCalledTimes(MAX_JUDGES_PER_MINUTE);
    expect(log.warn).toHaveBeenCalledWith('meet-jev: Jev rate cap reached, answer spoken unchecked', {
      callId: 'c2',
      perMinute: MAX_JUDGES_PER_MINUTE,
    });
    call.end('test');
  });

  it('logs a partial without its words, at debug; a final with them', () => {
    const { call, clock } = jevCall();
    vi.mocked(log.debug).mockClear();
    vi.mocked(log.info).mockClear();
    call.workerEvents([
      { type: 'utterance', uttId: 'u1', text: 'my secret plan', final: false, at: clock.now },
      { type: 'utterance', uttId: 'u1', text: 'my secret plan is done', final: true, at: clock.now },
    ]);
    const events = (fn: typeof log.info) => vi.mocked(fn).mock.calls.filter(([msg]) => msg === 'meet-jev: event');
    expect(events(log.debug)).toEqual([
      [
        'meet-jev: event',
        { callId: 'c1', seq: 1, kind: 'utterance', uttId: 'u1', chars: 14, final: false, at: expect.any(Number) },
      ],
    ]);
    expect(JSON.stringify(events(log.debug))).not.toContain('secret');
    expect(events(log.info)).toEqual([
      ['meet-jev: event', expect.objectContaining({ seq: 2, text: 'my secret plan is done', final: true })],
    ]);
    call.end('test');
  });
});

describe('createJevCall on a meeting', () => {
  const ALEX = { id: '100', name: 'Alex' };

  function meetCall() {
    const fed: CallEvent[] = [];
    const policies: CallPolicy[] = [];
    const pushed: LiveKitHostEvent[] = [];
    const core: CallCore<null> = {
      initial: (policy) => (policies.push(policy), null),
      reduce: (state, event) => (fed.push(event), state),
      decide: () => [],
    };
    const call = createJevCall(
      {
        callId: 'm1',
        kind: 'meet',
        callerName: 'Meeting',
        agentName: 'Andy',
        agentAliases: ['Енді'],
        maxTextBytes: 4096,
        submitTurn: async () => ({ ok: false, reason: 'test' }),
        push: (event) => void pushed.push(event),
        now: () => 1_000,
      },
      { core, judge: async () => ({ verdict: null, ms: 0 }) },
    );
    return { call, fed, policies, pushed };
  }

  it("runs on the meeting policy, not the voice call's", () => {
    const { call, policies } = meetCall();
    expect(policies).toEqual([expect.objectContaining({ kind: 'meet', agentName: 'Andy', agentAliases: ['Енді'] })]);
    expect(policies[0].paragraph).toContain('live meeting with several people');
    call.end('test');
  });

  it("takes words and speech from Recall only: the worker's utterances and VAD marks never reach the core", () => {
    const { call, fed } = meetCall();
    vi.mocked(log.info).mockClear();
    const accepted = call.workerEvents([
      { type: 'speech', on: true, at: 900 },
      { type: 'utterance', uttId: 'w1', text: 'heard by the worker', final: true, at: 900 },
      { type: 'playback', replyId: 'r1', state: 'started', at: 950 },
    ]);
    expect(accepted).toEqual({ accepted: 3, dropped: 0 });
    call.transcript({ kind: 'speech', speaker: ALEX, on: true, at: 990 });
    call.transcript({ kind: 'utterance', speaker: ALEX, uttId: '100-0', text: 'Andy, hi', final: true, at: 995 });
    expect(fed.map((e) => e.kind)).toEqual(['playback', 'speech', 'utterance']);
    expect(fed.filter((e) => 'speaker' in e).every((e) => 'speaker' in e && e.speaker.id === '100')).toBe(true);
    expect(log.info).toHaveBeenCalledWith('meet-jev: worker vad', { callId: 'm1', on: true, at: expect.any(Number) });
    call.end('test');
  });

  it('pushes words to the worker only while a line it reported started still plays', () => {
    const { call, pushed } = meetCall();
    const words = () => pushed.filter((e) => e.type === 'words').length;
    call.words();
    expect(words()).toBe(0);
    call.workerEvents([{ type: 'playback', replyId: 'r1', state: 'started', at: 900 }]);
    call.words();
    call.words();
    expect(words()).toBe(2);
    call.workerEvents([{ type: 'playback', replyId: 'r1', state: 'cut_off', delivered: 'Hel', at: 950 }]);
    call.words();
    expect(words()).toBe(2);
    call.workerEvents([{ type: 'playback', replyId: 'r2', state: 'started', at: 960 }]);
    call.end('test');
    call.words();
    expect(words()).toBe(2);
  });

  it("pushes a revoke for the core's revoke: the worker drops that queued line", () => {
    const pushed: LiveKitHostEvent[] = [];
    const call = createJevCall(
      {
        callId: 'v2',
        callerName: 'Ethan',
        agentName: 'Andy',
        agentAliases: [],
        maxTextBytes: 4096,
        submitTurn: async () => ({ ok: false, reason: 'test' }),
        push: (event) => void pushed.push(event),
        now: () => 1_000,
      },
      {
        core: {
          initial: () => null,
          reduce: (state) => state,
          decide: (_state, event) => (event.kind === 'reply' ? [{ kind: 'revoke', replyId: 'r0' }] : []),
        },
        judge: async () => ({ verdict: null, ms: 0 }),
      },
    );
    call.reply('Tuesday.', 't1');
    expect(pushed).toEqual([{ type: 'revoke', replyId: 'r0' }]);
    call.end('test');
  });

  it("ignores a transcript on a voice call: its words are the worker's", () => {
    const fed: CallEvent[] = [];
    const call = createJevCall(
      {
        callId: 'v1',
        callerName: 'Ethan',
        agentName: 'Andy',
        agentAliases: [],
        maxTextBytes: 4096,
        submitTurn: async () => ({ ok: false, reason: 'test' }),
        push: () => undefined,
        now: () => 1_000,
      },
      {
        core: { initial: () => null, reduce: (state, event) => (fed.push(event), state), decide: () => [] },
        judge: async () => ({ verdict: null, ms: 0 }),
      },
    );
    call.transcript({ kind: 'speech', speaker: ALEX, on: true, at: 990 });
    call.workerEvents([{ type: 'speech', on: true, at: 900 }]);
    expect(fed).toEqual([
      { kind: 'speech', speaker: { id: 'caller', name: 'Ethan' }, on: true, at: expect.any(Number) },
    ]);
    call.end('test');
  });
});

it('sends ordered, text-free reliable room cues and tolerates a failed send', async () => {
  sendData.mockReset().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined);
  const call = createJevCall({
    callId: 'status-call',
    kind: 'meet',
    statusRoom: { name: 'meeting-room', url: 'https://livekit.test', apiKey: 'test', apiSecret: 'test' },
    callerName: 'Ethan',
    agentName: 'Dan',
    agentAliases: [],
    maxTextBytes: 4096,
    submitTurn: async () => ({ ok: false, reason: 'test' }),
    push: () => undefined,
    now: () => 1000,
  });
  for (const uttId of ['one', 'two']) {
    call.transcript({ kind: 'speech', speaker: { id: 'p1', name: 'Ethan' }, on: true, at: 1000 });
    call.transcript({
      kind: 'utterance',
      speaker: { id: 'p1', name: 'Ethan' },
      uttId,
      text: 'private meeting words',
      final: true,
      at: 1100,
    });
  }
  await flush();
  expect(sendData).toHaveBeenCalledTimes(2);
  expect(sendData).toHaveBeenLastCalledWith('meeting-room', Buffer.from(JSON.stringify({ status: 'heard' })), 0, {
    topic: 'nanoclaw.jev.status',
  });
  expect(log.debug).toHaveBeenCalledWith('meet-jev: status send failed', { callId: 'status-call' });
  call.end('test');
});
