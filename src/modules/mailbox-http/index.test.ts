import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));
vi.mock('../../delivery.js', () => ({ deliverSessionMessages: vi.fn() }));

import { getSession } from '../../db/sessions.js';
import { deliverSessionMessages } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { registerTypingObserver, startTypingRefresh, stopTypingRefresh, type TypingTick } from '../typing/index.js';
import { onRunnerCommit } from './index.js';

const KEY = { agentGroupId: 'ag-1', sessionId: 'sess-1' };
const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;
const write = { op: 'writeMessageOut', args: [{ id: 'out-1' }] };
const turn = (state: string) => ({ op: 'markContainerTurn', args: [state] });

afterEach(() => {
  stopTypingRefresh(KEY.sessionId);
  vi.clearAllMocks();
});

describe('onRunnerCommit', () => {
  it('drains the session as soon as a runner write commits', async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION);
    vi.mocked(deliverSessionMessages).mockResolvedValue(undefined);
    onRunnerCommit(KEY, [turn('working'), write]);
    await vi.waitFor(() => expect(deliverSessionMessages).toHaveBeenCalledWith(SESSION));
    expect(getSession).toHaveBeenCalledWith('sess-1');
  });

  it('drains nothing for a batch without a write, or a session that is gone', async () => {
    onRunnerCommit(KEY, [turn('idle')]);
    expect(getSession).not.toHaveBeenCalled();
    vi.mocked(getSession).mockResolvedValue(undefined);
    onRunnerCommit(KEY, [write]);
    await vi.waitFor(() => expect(getSession).toHaveBeenCalled());
    expect(deliverSessionMessages).not.toHaveBeenCalled();
  });

  it('logs a failed push delivery instead of rejecting', async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION);
    vi.mocked(deliverSessionMessages).mockRejectedValue(new Error('adapter down'));
    onRunnerCommit(KEY, [write]);
    await vi.waitFor(() =>
      expect(log.error).toHaveBeenCalledWith('Push delivery failed', expect.objectContaining({ sessionId: 'sess-1' })),
    );
  });

  it('hands the batch’s last turn to the typing module at once', () => {
    const ticks: TypingTick[] = [];
    registerTypingObserver((tick) => ticks.push(tick));
    startTypingRefresh(KEY.sessionId, KEY.agentGroupId, 'telegram', 'telegram:1', null);
    expect(ticks.map((tick) => tick.working)).toEqual([false]);

    // The runner picked the inbound up: the observer hears it without waiting on a poll or refresh tick.
    onRunnerCommit(KEY, [turn('idle'), turn('working')]);
    expect(ticks.map((tick) => tick.working)).toEqual([false, true]);
  });
});
