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

import fs from 'fs';
import path from 'path';

import { heartbeatPath } from '../../session-manager.js';
import {
  notePresence,
  pauseTypingRefreshAfterDelivery,
  setTypingAdapter,
  startTypingRefresh,
  stopTypingRefresh,
} from './index.js';

type Call = {
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance?: string;
  status?: string;
  statusKind?: 'auto' | 'agent';
};

function captureAdapter() {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
  });
  return calls;
}

/** Adapter that records both set and clear calls. */
function captureSetAndClear() {
  const sets: Call[] = [];
  const clears: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance, status, statusKind) {
      sets.push({ channelType, platformId, threadId, instance, status, statusKind });
    },
    async clearTyping(channelType, platformId, threadId, instance) {
      clears.push({ channelType, platformId, threadId, instance });
    },
  });
  return { sets, clears };
}

/** Write a heartbeat file with an mtime at the current (fake) clock. */
function touchHeartbeat(agentGroupId: string, sessionId: string): void {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  fs.mkdirSync(path.dirname(hbPath), { recursive: true });
  fs.writeFileSync(hbPath, '');
  const seconds = Date.now() / 1000;
  fs.utimesSync(hbPath, seconds, seconds);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  stopTypingRefresh('sess-turn');
  if (fs.existsSync('/tmp/nanoclaw-test-typing'))
    fs.rmSync('/tmp/nanoclaw-test-typing', { recursive: true, force: true });
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

describe('typing follows the runner turn state', () => {
  const SESS = 'sess-turn';
  const AG = 'ag-turn';

  /** Advance past the 15s grace, keeping a working report live throughout. */
  async function advancePastGraceWorking(): Promise<void> {
    for (let elapsed = 0; elapsed < 20_000; elapsed += 4_000) {
      notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
      await vi.advanceTimersByTimeAsync(4_000);
    }
  }

  it('quiet turn: an idle report with no delivery stops the refresh and clears exactly once', async () => {
    const { sets, clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);

    await advancePastGraceWorking();
    const setsWhileWorking = sets.length;
    expect(setsWhileWorking).toBeGreaterThan(1); // still refreshing past grace

    // Turn ends without delivering anything.
    notePresence(SESS, { turn: 'idle', updatedAtMs: Date.now(), status: null });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(clears).toHaveLength(1);
    expect(clears[0]).toEqual({ channelType: 'slack', platformId: 'C1', threadId: 'T1', instance: 'slack-inst' });

    // No more refreshes and no second clear once the refresher has ended.
    const setsAfterEnd = sets.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sets.length).toBe(setsAfterEnd);
    expect(clears).toHaveLength(1);
  });

  it('multi-message turn: two deliveries pause and resume, then a single clear at idle', async () => {
    const { sets, clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    await advancePastGraceWorking();

    // First delivery pauses the refresh; ticks inside the pause skip setTyping.
    pauseTypingRefreshAfterDelivery(SESS);
    let before = sets.length;
    notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
    await vi.advanceTimersByTimeAsync(8_000); // inside the 10s pause
    expect(sets.length).toBe(before); // no refresh while paused

    // Pause expires; a live working report resumes refreshing.
    notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sets.length).toBeGreaterThan(before);

    // Second delivery pauses again.
    pauseTypingRefreshAfterDelivery(SESS);
    before = sets.length;
    notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sets.length).toBe(before);
    notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sets.length).toBeGreaterThan(before);

    // Turn ends: exactly one clear across the whole turn.
    notePresence(SESS, { turn: 'idle', updatedAtMs: Date.now(), status: null });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(clears).toHaveLength(1);
  });

  it('dead runner: a working report that stops advancing clears after it goes stale', async () => {
    const { sets, clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    await advancePastGraceWorking();

    // The runner dies: the last working report stops advancing. It stays live
    // for TURN_STALE_MS, then the next tick ends the refresh.
    const setsBeforeDeath = sets.length;
    notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
    // Under the stale window: still refreshing.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sets.length).toBeGreaterThan(setsBeforeDeath);
    expect(clears).toHaveLength(0);

    // Past the 15s stale window with no new report: clear once.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(clears).toHaveLength(1);
    const setsAtClear = sets.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sets.length).toBe(setsAtClear);
    expect(clears).toHaveLength(1);
  });

  it('old runner: with no turn ever reported, the heartbeat file still gates the refresh', async () => {
    const { sets, clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);

    // Never call notePresence. Past grace, a fresh heartbeat keeps typing on.
    for (let elapsed = 0; elapsed < 20_000; elapsed += 4_000) {
      touchHeartbeat(AG, SESS);
      await vi.advanceTimersByTimeAsync(4_000);
    }
    const setsWhileFresh = sets.length;
    expect(setsWhileFresh).toBeGreaterThan(1);
    expect(clears).toHaveLength(0);

    // Heartbeat goes stale (no more touches): the refresh ends.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(clears).toHaveLength(1);
    const setsAtEnd = sets.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sets.length).toBe(setsAtEnd);
  });

  it('stopTypingRefresh clears the indicator once', async () => {
    const { clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);

    stopTypingRefresh(SESS);
    expect(clears).toHaveLength(1);
    // A second stop finds no refresher — no double clear.
    stopTypingRefresh(SESS);
    expect(clears).toHaveLength(1);
  });

  it('notePresence with no active refresher creates none', async () => {
    const { sets } = captureSetAndClear();
    notePresence('sess-never', { turn: 'working', updatedAtMs: Date.now(), status: null });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sets).toHaveLength(0);
  });
});

describe('typing guards', () => {
  const SESS = 'sess-turn';
  const AG = 'ag-turn';

  it('ceiling: a working report that never changes stops typing after five minutes', async () => {
    const { sets, clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);

    // The runner keeps re-marking `working` with fresh stamps — a stuck turn
    // looks exactly like a long one. Hold it for 5 minutes.
    for (let elapsed = 0; elapsed < 300_000; elapsed += 4_000) {
      notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(clears).toHaveLength(1);

    // Still working, still fresh: no more painting.
    const setsAtCap = sets.length;
    for (let elapsed = 0; elapsed < 40_000; elapsed += 4_000) {
      notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(sets.length).toBe(setsAtCap);
    expect(clears).toHaveLength(1);

    // A new inbound is a new wake: typing resumes.
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    expect(sets.length).toBe(setsAtCap + 1);
  });

  it("stale idle: a previous run's idle report does not end the first turn's typing", async () => {
    const { sets, clears } = captureSetAndClear();
    // The last run left `idle` in its container record a minute ago.
    const leftoverIdle = { turn: 'idle' as const, updatedAtMs: Date.now() - 60_000, status: null };
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);

    // Slow cold start: past grace the runner has not reported this wake, and
    // the heartbeat file was removed at spawn. The leftover must read as
    // "not yet reported", not end the refresh.
    for (let elapsed = 0; elapsed < 24_000; elapsed += 4_000) {
      notePresence(SESS, leftoverIdle);
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(clears).toHaveLength(0);
    const setsBeforeTurn = sets.length;

    // The runner's first report of this wake takes over.
    notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sets.length).toBeGreaterThan(setsBeforeTurn);
    notePresence(SESS, { turn: 'idle', updatedAtMs: Date.now(), status: null });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(clears).toHaveLength(1);
  });

  it('stale idle: a runner that never reports this wake stops typing after the leftover budget', async () => {
    const { clears } = captureSetAndClear();
    const leftoverIdle = { turn: 'idle' as const, updatedAtMs: Date.now() - 60_000, status: null };
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);

    for (let elapsed = 0; elapsed < 56_000; elapsed += 4_000) {
      notePresence(SESS, leftoverIdle);
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(clears).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(clears).toHaveLength(1);
  });

  it('ceiling: a delivered reply restarts the ceiling clock', async () => {
    const { clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    const holdWorking = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 4_000) {
        notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
        await vi.advanceTimersByTimeAsync(4_000);
      }
    };
    await holdWorking(240_000);
    pauseTypingRefreshAfterDelivery(SESS);
    await holdWorking(240_000);
    expect(clears).toHaveLength(0);
    await holdWorking(64_000);
    expect(clears).toHaveLength(1);
  });

  it('ceiling: a new turn after the cap repaints a status but never re-adds the ack', async () => {
    const { statuses, reactions } = signalAdapter({ requiresThread: true });
    startTypingRefresh(SESS, AG, 'slack', 'slack:D1', null, 'slack-emma', 'msg-1');
    for (let elapsed = 0; elapsed < 300_000; elapsed += 4_000) {
      notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(reactions.map((r) => r.op)).toEqual(['add', 'remove']);

    // The turn ends and another starts before a tick sees the idle.
    notePresence(SESS, { turn: 'idle', updatedAtMs: Date.now(), status: null });
    notePresence(SESS, { turn: 'working', updatedAtMs: Date.now(), status: null });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reactions.map((r) => r.op)).toEqual(['add', 'remove']);
    expect(statuses).toEqual([]);
  });
});

describe('presence: runner status text rides on the typing indicator', () => {
  const SESS = 'sess-turn';
  const AG = 'ag-turn';
  const working = (text: string | null) => {
    notePresence(SESS, {
      turn: 'working',
      updatedAtMs: Date.now(),
      status: text === null ? null : { text, atMs: Date.now() },
    });
  };
  /** Ticks from a fresh refresher until the grace window is behind us. */
  async function runPastGrace(text: string | null): Promise<void> {
    for (let elapsed = 0; elapsed < 20_000; elapsed += 4_000) {
      working(text);
      await vi.advanceTimersByTimeAsync(4_000);
    }
  }
  const withText = (sets: Call[]) => sets.filter((c) => c.status !== undefined);
  const plain = (sets: Call[]) => sets.filter((c) => c.status === undefined);

  it('sends the status text (statusKind agent) while working, instead of plain typing', async () => {
    const { sets } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    const plainAtStart = plain(sets).length; // the immediate inbound tick is plain

    await runPastGrace('Reading the thread');
    const texted = withText(sets);
    expect(texted.length).toBeGreaterThanOrEqual(1);
    expect(texted[0]).toEqual({
      channelType: 'slack',
      platformId: 'C1',
      threadId: 'T1',
      instance: 'slack-inst',
      status: 'Reading the thread',
      statusKind: 'agent',
    });
    // Once text is showing, no plain typing calls are interleaved.
    expect(plain(sets).length).toBe(plainAtStart);
  });

  it("re-sends unchanged text on every tick — the cadence is plain typing's", async () => {
    const { sets } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    await runPastGrace('Reading the thread');
    const before = withText(sets).length;

    working('Reading the thread');
    await vi.advanceTimersByTimeAsync(8_000); // two 4s ticks
    const after = withText(sets);
    expect(after.length).toBe(before + 2);
    for (const c of after) expect(c.status).toBe('Reading the thread');
  });

  it('changed text shows on the next tick', async () => {
    const { sets } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    await runPastGrace('Reading the thread');
    const before = withText(sets).length;

    working('Drafting a reply');
    await vi.advanceTimersByTimeAsync(4_000);
    const texted = withText(sets);
    expect(texted).toHaveLength(before + 1);
    expect(texted[texted.length - 1].status).toBe('Drafting a reply');
  });

  it('pauses after a delivery and sends the text again once the pause ends', async () => {
    const { sets } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    await runPastGrace('Reading the thread');
    const before = withText(sets).length;

    // A reply goes out: the platform drops the status; ticks pause for 10s.
    pauseTypingRefreshAfterDelivery(SESS);
    working('Reading the thread');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(withText(sets)).toHaveLength(before); // paused: nothing sent

    // Pause over: the next tick shows the text again.
    working('Reading the thread');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(withText(sets)).toHaveLength(before + 1);
  });

  it('with no text, plain typing fires every tick as before', async () => {
    const { sets } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    await runPastGrace(null);
    expect(withText(sets)).toHaveLength(0);
    const before = plain(sets).length;
    working(null);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(plain(sets).length).toBe(before + 2);
    for (const c of sets) expect(c.statusKind).toBeUndefined();
  });

  it('idle ends the refresh with one clear even while text is showing', async () => {
    const { sets, clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    await runPastGrace('Reading the thread');
    expect(withText(sets).length).toBeGreaterThanOrEqual(1);

    notePresence(SESS, {
      turn: 'idle',
      updatedAtMs: Date.now(),
      status: { text: 'Reading the thread', atMs: 0 },
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(clears).toHaveLength(1);
    const setsAtEnd = sets.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sets.length).toBe(setsAtEnd);
    expect(clears).toHaveLength(1);
  });

  it('text is not shown before the runner is provably in the turn (grace with no working report)', async () => {
    const { sets } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    // A stale status row from an earlier turn arrives before any turn report.
    notePresence(SESS, { turn: null, updatedAtMs: null, status: { text: 'Old line', atMs: 0 } });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(withText(sets)).toHaveLength(0);
    expect(plain(sets).length).toBeGreaterThanOrEqual(2);
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
    expect(statuses).toEqual([undefined]);
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
