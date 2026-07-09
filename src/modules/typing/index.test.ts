/**
 * Typing-refresh instance forwarding tests.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the 4s interval tick, and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

// Controllable gate: the refresher reads container liveness + processing
// claims each tick once past the grace window. `gate.claims` swaps between
// inflight and empty to simulate turn progress and transient misreads.
const gate = vi.hoisted(() => ({
  claims: [] as Array<{ message_id: string; status_changed: string }>,
}));
vi.mock('../../container-runner.js', () => ({
  isContainerRunning: () => true,
}));
vi.mock('../../session-manager.js', () => ({
  openOutboundDb: () => ({}),
}));
vi.mock('../../db/session-db.js', () => ({
  getProcessingClaims: () => gate.claims,
}));

import { setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';

type Call = { channelType: string; platformId: string; threadId: string | null; instance?: string };

function captureAdapter() {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
  });
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
  gate.claims = [];
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  vi.useRealTimers();
});

describe('startTypingRefresh — instance forwarding', () => {
  it('immediate tick passes the instance to the adapter', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
      instance: 'slack-tester',
    });
  });

  it('interval ticks inside the grace window pass the stored entry instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Two 4s ticks — well inside the grace window, so they fire
    // unconditionally (no gate check needed) from the stored entry.
    await vi.advanceTimersByTimeAsync(8_500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.instance).toBe('slack-tester');
      expect(c.threadId).toBe('T1');
    }
  });

  it('re-trigger on an active session passes (and stores) the new instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Second call for the same session: immediate tick with the new value.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-worker');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].instance).toBe('slack-worker');

    // And the stored entry was updated — subsequent interval ticks carry it.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].instance).toBe('slack-worker');
  });

  it('re-trigger with a changed address updates the whole entry — interval ticks stay self-consistent', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Same session re-triggered from a different platform and chat
    // (agent-shared sessions span messaging groups). The stored entry must
    // not tear: keeping the old address with the new instance would hand a
    // telegram platformId to the slack-tester adapter on the next tick.
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:99', null, 'telegram');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'telegram',
      platformId: 'tg:99',
      threadId: null,
      instance: 'telegram',
    });

    // Interval ticks fire from the stored entry — all four fields must
    // have moved together.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c).toEqual({
        channelType: 'telegram',
        platformId: 'tg:99',
        threadId: null,
        instance: 'telegram',
      });
    }
  });
});

describe('gate debounce past the grace window', () => {
  const INFLIGHT = [{ message_id: 'm1', status_changed: '2026-01-01 00:00:00' }];

  it('one transient miss skips the tick but keeps the refresher alive', async () => {
    const calls = captureAdapter();
    gate.claims = INFLIGHT;
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:1', null);
    // Get past the 30s grace window; gate reads true throughout.
    await vi.advanceTimersByTimeAsync(32_000);
    calls.length = 0;

    // Transient misread: exactly one tick sees no claims — no setTyping,
    // but the refresher must survive.
    gate.claims = [];
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toHaveLength(0);

    // Gate recovers → typing resumes on the next tick.
    gate.claims = INFLIGHT;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('two consecutive misses stop the refresher for good', async () => {
    const calls = captureAdapter();
    gate.claims = INFLIGHT;
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:1', null);
    await vi.advanceTimersByTimeAsync(32_000);
    calls.length = 0;

    gate.claims = [];
    await vi.advanceTimersByTimeAsync(8_500); // miss #1 + miss #2 → stopped
    expect(calls).toHaveLength(0);

    // Claims reappearing later must not resurrect a stopped refresher.
    gate.claims = INFLIGHT;
    await vi.advanceTimersByTimeAsync(8_500);
    expect(calls).toHaveLength(0);
  });
});
