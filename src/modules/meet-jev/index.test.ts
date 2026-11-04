/** A `/voice jev` call's wiring around the real core: the per-call Jev cap and what it logs. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { log } from '../../log.js';
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
  it('asks Jev at most MAX_JUDGES_PER_MINUTE times a minute; past it a boundary is judged silent', async () => {
    const { call, clock, judge, say } = jevCall();
    for (let i = 0; i <= MAX_JUDGES_PER_MINUTE; i++) {
      say(`thought number ${i}`);
      await flush();
    }
    expect(judge).toHaveBeenCalledTimes(MAX_JUDGES_PER_MINUTE);
    expect(log.warn).toHaveBeenCalledWith('meet-jev: Jev rate cap reached, judged silent', {
      callId: 'c1',
      perMinute: MAX_JUDGES_PER_MINUTE,
    });
    clock.now += 60_000;
    say('a minute later');
    await flush();
    expect(judge).toHaveBeenCalledTimes(MAX_JUDGES_PER_MINUTE + 1);
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
