import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { TASKS_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import type { InboundMailbox } from '../../mailbox/index.js';
import { withExistingMailboxSession } from '../../session-manager.js';

registerMigration({
  version: 1,
  name: 'module:app:task-series-count',
  async up(db) {
    await db.exec('ALTER TABLE sessions ADD COLUMN live_task_series INTEGER');
  },
});

export async function recordTaskSeriesCount(sessionId: string, count: number): Promise<void> {
  await getDb().run(
    'UPDATE sessions SET live_task_series = ? WHERE id = ? AND (live_task_series IS NULL OR live_task_series <> ?)',
    count,
    sessionId,
    count,
  );
}

export function withTaskChange<T>(
  groupId: string,
  sessionId: string,
  change: (mailbox: InboundMailbox) => T | Promise<T>,
): Promise<T | undefined> {
  return withExistingMailboxSession(groupId, sessionId, async (mailbox) => {
    const result = await change(mailbox);
    if (result) await recordTaskSeriesCount(sessionId, mailbox.countLiveTasks());
    return result;
  });
}

export async function backfillTaskSeriesCounts(): Promise<void> {
  const sessions = await getDb().all<{ id: string; agent_group_id: string }>(
    `SELECT id, agent_group_id FROM sessions WHERE status = 'active' AND messaging_group_id IS NULL
      AND (thread_id = ? OR thread_id LIKE ?) AND live_task_series IS NULL`,
    TASKS_SYSTEM_THREAD_ID,
    `${TASKS_SYSTEM_THREAD_ID}:%`,
  );
  for (const session of sessions) {
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      recordTaskSeriesCount(session.id, mailbox.countLiveTasks()),
    );
  }
}

export async function activeSessionCounts(agentGroupId: string) {
  const counts = await getDb().get<{ sessions: number; tasks: number }>(
    `SELECT COUNT(*) AS sessions, COALESCE(SUM(CASE WHEN messaging_group_id IS NULL
      AND (thread_id = ? OR thread_id LIKE ?) THEN live_task_series ELSE 0 END), 0) AS tasks
      FROM sessions WHERE agent_group_id = ? AND status = 'active'`,
    TASKS_SYSTEM_THREAD_ID,
    `${TASKS_SYSTEM_THREAD_ID}:%`,
    agentGroupId,
  );
  return counts!;
}
