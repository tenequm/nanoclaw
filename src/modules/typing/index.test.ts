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

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

import fsMod from 'fs';
import pathMod from 'path';

import { pauseTypingRefreshAfterDelivery, setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';
import { heartbeatPath } from '../../session-manager.js';

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

    // Two 4s ticks — well inside the 15s grace window, so they fire
    // unconditionally (no heartbeat file needed) from the stored entry.
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

/**
 * The two renderings of the "agent is working" signal, and the teardown
 * that takes each of them down.
 *
 * Slack's assistant status is thread-scoped and persistent: it paints only
 * inside a thread and clears only when the app next posts. So a turn that
 * ends without a user-facing reply — mention-sticky wakes the agent on
 * plenty of messages it reasonably won't answer — leaves a stale indicator
 * until the platform's own two-minute timeout, and a threadless (shared-
 * session) chat can never show one at all. Hence the explicit clear on
 * every teardown path, and the reaction-ack fallback.
 */
type Reaction = { op: 'add' | 'remove'; platformId: string; messageId: string; emoji: string; instance?: string };

function signalAdapter(opts: { requiresThread?: boolean } = {}) {
  const statuses: Array<string | undefined> = [];
  const clears: Array<{ platformId: string; threadId: string | null }> = [];
  const reactions: Reaction[] = [];
  setTypingAdapter({
    async setTyping(_channelType, _platformId, _threadId, _instance, status) {
      statuses.push(status);
    },
    async clearTyping(_channelType, platformId, threadId) {
      clears.push({ platformId, threadId });
    },
    async addReaction(_channelType, platformId, messageId, emoji, instance) {
      reactions.push({ op: 'add', platformId, messageId, emoji, instance });
    },
    async removeReaction(_channelType, platformId, messageId, emoji, instance) {
      reactions.push({ op: 'remove', platformId, messageId, emoji, instance });
    },
    typingRequiresThread: () => opts.requiresThread === true,
  });
  return { statuses, clears, reactions };
}

describe('status rendering', () => {
  it('paints a status string rather than the adapter default', async () => {
    const { statuses } = signalAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:1', 'slack-tester', 'msg-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['is thinking...']);
  });

  it('clears the status when the turn ends with no reply', async () => {
    const { clears } = signalAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:1', 'slack-tester', 'msg-1');

    // No heartbeat file exists, so once the 15s grace expires the agent
    // reads as idle. Nothing was ever delivered, so the platform's own
    // post-clears-status rule never fires: this teardown is the only
    // thing that can take the indicator down.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(clears).toEqual([{ platformId: 'slack:C1', threadId: 'slack:C1:1' }]);
  });

  it('clears the status when the refresher is stopped externally', async () => {
    const { clears } = signalAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:1', 'slack-tester', 'msg-1');
    await vi.advanceTimersByTimeAsync(0);

    stopTypingRefresh('sess-1');
    expect(clears).toEqual([{ platformId: 'slack:C1', threadId: 'slack:C1:1' }]);
  });

  it('does not repaint from the grace window after a delivery (#3400 leg 1)', async () => {
    const { statuses } = signalAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:1', 'slack-tester', 'msg-1');
    await vi.advanceTimersByTimeAsync(5_000);

    // A follow-up resets grace just before the first reply lands.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:1', 'slack-tester', 'msg-2');
    await vi.advanceTimersByTimeAsync(0);
    pauseTypingRefreshAfterDelivery('sess-1');
    statuses.length = 0;

    // Past the 10s pause but still inside the reset 15s grace. With no
    // heartbeat, the agent is idle and nothing should repaint.
    await vi.advanceTimersByTimeAsync(11_500);
    expect(statuses).toEqual([]);
  });
});

describe('reaction-ack rendering (threadless chat on a thread-only platform)', () => {
  it('acks the triggering message instead of painting a status', async () => {
    const { statuses, reactions } = signalAdapter({ requiresThread: true });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'slack-emma', 'msg-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(statuses).toEqual([]);
    expect(reactions).toEqual([
      { op: 'add', platformId: 'slack:D1', messageId: 'msg-1', emoji: 'eyes', instance: 'slack-emma' },
    ]);
  });

  it('acks once, not on every refresh tick', async () => {
    const { reactions } = signalAdapter({ requiresThread: true });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'slack-emma', 'msg-1');

    // Several ticks inside the grace window: a reaction does not expire,
    // so re-adding it every 4s would be pure API noise.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(reactions.filter((r) => r.op === 'add')).toHaveLength(1);
  });

  it('removes the ack when the reply is delivered', async () => {
    const { reactions } = signalAdapter({ requiresThread: true });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'slack-emma', 'msg-1');
    await vi.advanceTimersByTimeAsync(0);

    pauseTypingRefreshAfterDelivery('sess-1');
    expect(reactions[reactions.length - 1]).toEqual({
      op: 'remove',
      platformId: 'slack:D1',
      messageId: 'msg-1',
      emoji: 'eyes',
      instance: 'slack-emma',
    });
    // Already removed — going idle later must not fire a second remove.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reactions.filter((r) => r.op === 'remove')).toHaveLength(1);
  });

  it('removes the ack when the turn ends with no reply', async () => {
    const { reactions } = signalAdapter({ requiresThread: true });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'slack-emma', 'msg-1');

    await vi.advanceTimersByTimeAsync(20_000);
    expect(reactions.map((r) => r.op)).toEqual(['add', 'remove']);
  });

  it('moves the ack to the message that re-triggered the session', async () => {
    const { reactions } = signalAdapter({ requiresThread: true });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'slack-emma', 'msg-1');
    await vi.advanceTimersByTimeAsync(0);

    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'slack-emma', 'msg-2');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toEqual([
      { op: 'add', platformId: 'slack:D1', messageId: 'msg-1', emoji: 'eyes', instance: 'slack-emma' },
      { op: 'remove', platformId: 'slack:D1', messageId: 'msg-1', emoji: 'eyes', instance: 'slack-emma' },
      { op: 'add', platformId: 'slack:D1', messageId: 'msg-2', emoji: 'eyes', instance: 'slack-emma' },
    ]);
  });

  it('falls back to the status rendering once the chat has a thread', async () => {
    const { statuses, reactions } = signalAdapter({ requiresThread: true });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:1', 'slack-tester', 'msg-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(reactions).toEqual([]);
    expect(statuses).toEqual(['is thinking...']);
  });
});

describe('failure reporting', () => {
  it('logs a failed ack instead of swallowing it, and never throws', async () => {
    const { log } = (await import('../../log.js')) as unknown as { log: { warn: ReturnType<typeof vi.fn> } };
    log.warn.mockClear();
    setTypingAdapter({
      addReaction: async () => {
        throw new Error('message_not_found');
      },
      typingRequiresThread: () => true,
    });

    // The signal is decoration: a broken reaction must not reach routing.
    expect(() => startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:D1', null, 'slack-emma', 'msg-1')).not.toThrow();

    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledWith(
      'activity signal failed',
      expect.objectContaining({ op: 'addReaction', messageId: 'msg-1', err: 'Error: message_not_found' }),
    );
  });
});

/**
 * The post-delivery idle clear. pauseTypingRefreshAfterDelivery zeroes
 * startedAt so later ticks must prove work via the heartbeat (#3400 leg 1)
 * — but the skip that protects a multi-message turn used to skip the CLEAR
 * too. When the delivered "reply" was a reaction or an edit (not a post),
 * Slack's persistent status was never cleared by the platform, and the
 * orphaned indicator sat painted until Slack's own 2-minute timeout.
 */
describe('post-delivery idle clear (reaction-only turn leaves status painted)', () => {
  afterEach(() => {
    // Don't leave a heartbeat file behind: a rerun within HEARTBEAT_FRESH_MS
    // real seconds would read it as fresh and flake the idle-path tests.
    fsMod.rmSync(pathMod.dirname(heartbeatPath('ag-1', 'sess-1')), { recursive: true, force: true });
  });

  function freshHeartbeatGone() {
    // A prior test run may have left a heartbeat file whose mtime still
    // reads as fresh (or in the future) against this run's fake clock.
    fsMod.rmSync(pathMod.dirname(heartbeatPath('ag-1', 'sess-1')), { recursive: true, force: true });
  }

  it('clears the status exactly once when the turn goes idle after a delivery', async () => {
    freshHeartbeatGone();
    const { clears } = signalAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:1', 'slack-tester', 'msg-1');
    await vi.advanceTimersByTimeAsync(0);

    // The turn's only user-facing output was a reaction — the platform
    // cleared nothing. The pause zeroes startedAt.
    pauseTypingRefreshAfterDelivery('sess-1');

    // Past the 10s pause; no heartbeat, so the agent reads as idle. The
    // startedAt === 0 branch must clear the orphaned status — once.
    await vi.advanceTimersByTimeAsync(13_000);
    expect(clears).toEqual([{ platformId: 'slack:C1', threadId: 'slack:C1:1' }]);
  });

  it('stays cleared over a long idle — one clear total, not one per tick', async () => {
    freshHeartbeatGone();
    const { clears } = signalAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:1', 'slack-tester', 'msg-1');
    await vi.advanceTimersByTimeAsync(0);
    pauseTypingRefreshAfterDelivery('sess-1');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(clears).toHaveLength(1);
  });

  it('repaints when work resumes and clears again on the next idle', async () => {
    freshHeartbeatGone();
    const { statuses, clears } = signalAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'slack:C1:1', 'slack-tester', 'msg-1');
    await vi.advanceTimersByTimeAsync(0);
    pauseTypingRefreshAfterDelivery('sess-1');

    // Idle clear fires after the pause.
    await vi.advanceTimersByTimeAsync(13_000);
    expect(clears).toHaveLength(1);
    statuses.length = 0;

    // Work resumes: the heartbeat goes fresh, so the tick repaints.
    const hb = heartbeatPath('ag-1', 'sess-1');
    fsMod.mkdirSync(pathMod.dirname(hb), { recursive: true });
    fsMod.writeFileSync(hb, '');
    const now = new Date(Date.now());
    fsMod.utimesSync(hb, now, now);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(statuses.length).toBeGreaterThanOrEqual(1);

    // Heartbeat goes stale again — the refresher (still alive) clears again.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clears).toHaveLength(2);
  });
});
