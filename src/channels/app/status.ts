import { log } from '../../log.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { getConversation } from './conversations.js';
import { openQuestionConversationIds } from './questions.js';
import { onEventAppended, setAppHooks } from './log.js';
import type { ChannelAdapter } from '../adapter.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { findSessionForAgent } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { ContainerRecord } from '../../mailbox/model.js';
import type { Status } from './contract.js';
import type { ConversationRow, EventRow, StatusRow } from './db.js';

export interface StatusDeps {
  getConversationByPlatformId(id: string): Promise<ConversationRow | undefined>;
  openQuestionConversationIds(): Promise<string[]>;
  onEventAppended(listener: (event: EventRow) => void): () => void;
  setAppHooks(hooks: { statuses(ids: string[]): Promise<Status[]> }): void;
  db?: () => DbDriver;
  containerStates?: (conversation: ConversationRow) => Promise<ContainerRecord[]>;
}
export function toolLabel(tool: string | null): string {
  if (tool === 'Bash') return 'Running a command';
  if (['Read', 'Grep', 'Glob'].includes(tool ?? '')) return 'Reading files';
  if (['Edit', 'Write', 'MultiEdit'].includes(tool ?? '')) return 'Editing files';
  if (['WebFetch', 'WebSearch'].includes(tool ?? '')) return 'Searching the web';
  if (tool?.startsWith('mcp__')) return 'Using a tool';
  return 'Working';
}
async function containerStates(c: ConversationRow): Promise<ContainerRecord[]> {
  const wirings = await getDb().all<{ agent_group_id: string }>(
    'SELECT agent_group_id FROM messaging_group_agents WHERE messaging_group_id = ?',
    c.messaging_group_id,
  );
  const states: ContainerRecord[] = [];
  for (const wiring of wirings) {
    try {
      const session = await findSessionForAgent(wiring.agent_group_id, c.messaging_group_id, null);
      if (!session) continue;
      const state = await withExistingMailboxSession(wiring.agent_group_id, session.id, (m) => m.getContainerState());
      if (state) states.push(state);
    } catch {
      /* A missing mailbox must not prevent a typing tick. */
    }
  }
  return states;
}
export function createStatusService(deps: StatusDeps) {
  const db = deps.db ?? getDb;
  const readStates = deps.containerStates ?? containerStates;
  const listeners = new Set<(status: Status) => void>();
  const ticks = new Map<string, { at: number; label: string }>();
  const labels = new Map<string, { readAt: number; label: string }>();
  let tail: Promise<unknown> = Promise.resolve();
  let stopped = false;
  function failed(error: unknown): void {
    log.error('App status failed', { kind: error instanceof Error ? error.name : typeof error });
  }
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  }
  function entity(row: StatusRow): Status {
    return {
      kind: 'status',
      conversationId: row.conversation_id,
      rev: row.rev,
      state: row.state,
      label: row.label,
      at: row.at,
    };
  }
  async function save(id: string, state: string, label: string | null, force = false): Promise<void> {
    const value = await db().transaction(async () => {
      const old = await db().get<StatusRow>('SELECT * FROM app_statuses WHERE conversation_id = ?', id);
      if (!force && old?.state === state && old.label === label) return;
      const row = { conversation_id: id, rev: (old?.rev ?? 0) + 1, state, label, at: Date.now() };
      await db().run(
        'INSERT INTO app_statuses (conversation_id, rev, state, label, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET rev = excluded.rev, state = excluded.state, label = excluded.label, at = excluded.at',
        id,
        row.rev,
        state,
        label,
        row.at,
      );
      return entity(row);
    });
    if (value && !stopped) for (const listener of listeners) listener(value);
  }
  async function refresh(id: string, force = false): Promise<void> {
    const waiting = (await deps.openQuestionConversationIds()).includes(id);
    const tick = ticks.get(id);
    const working = tick && Date.now() - tick.at < 30_000;
    await save(
      id,
      waiting ? 'waiting' : working ? 'working' : 'idle',
      waiting ? 'Waiting for your answer' : working ? tick.label : null,
      force,
    );
  }
  async function statuses(ids: string[]): Promise<Status[]> {
    await ready;
    await tail;
    const result: Status[] = [];
    for (const id of ids) {
      const row = await db().get<StatusRow>('SELECT * FROM app_statuses WHERE conversation_id = ?', id);
      if (row) result.push(entity(row));
      else result.push({ kind: 'status', conversationId: id, rev: 0, state: 'idle', label: null, at: 0 });
    }
    return result;
  }
  const ready = serial(async () => {
    const conversations = await db().all<ConversationRow>('SELECT * FROM app_conversations');
    for (const c of conversations) {
      try {
        const states = await readStates(c).catch(() => []);
        const fresh = states.find((s) => s.turn === 'working' && Date.now() - Date.parse(s.updatedAt) < 30_000);
        if (fresh) ticks.set(c.id, { at: Date.parse(fresh.updatedAt), label: toolLabel(fresh.currentTool) });
        await refresh(c.id, true);
      } catch (error) {
        failed(error);
      }
    }
  }).catch(failed);
  const unsubscribe = deps.onEventAppended((event) => {
    if (stopped) return;
    void serial(async () => {
      const data = JSON.parse(event.entity_json);
      if (event.kind === 'message' && data.role === 'agent' && data.seq === data.order) {
        ticks.delete(event.conversation_id);
        await refresh(event.conversation_id);
      } else if (event.kind === 'question') await refresh(event.conversation_id);
    }).catch(failed);
  });
  const timer = setInterval(() => {
    void serial(async () => {
      for (const [id, tick] of ticks)
        if (Date.now() - tick.at >= 30_000) {
          ticks.delete(id);
          await refresh(id);
        }
    }).catch(failed);
  }, 1_000);
  timer.unref();
  deps.setAppHooks({ statuses });
  return {
    ready,
    statuses,
    onStatusChanged(listener: (status: Status) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setTyping(platformId: string) {
      return serial(async () => {
        const c = await deps.getConversationByPlatformId(platformId);
        if (!c || stopped) return;
        const previous = labels.get(c.id);
        let label = previous?.label ?? 'Working';
        let readAt = previous?.readAt ?? -Infinity;
        if (Date.now() - readAt >= 4_000) {
          const states = await readStates(c).catch(() => []);
          label = toolLabel(states[0]?.currentTool ?? null);
          readAt = Date.now();
        }
        labels.set(c.id, { readAt, label });
        ticks.set(c.id, { at: Date.now(), label });
        await refresh(c.id);
      });
    },
    clearTyping(platformId: string) {
      return serial(async () => {
        const c = await deps.getConversationByPlatformId(platformId);
        if (!c || stopped) return;
        ticks.delete(c.id);
        await refresh(c.id);
      });
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      listeners.clear();
      await tail;
    },
  };
}
let service: ReturnType<typeof createStatusService> | undefined;
export function startStatus() {
  service ??= createStatusService({
    getConversationByPlatformId: getConversation,
    openQuestionConversationIds,
    onEventAppended,
    setAppHooks,
  });
  return service;
}
export async function stopStatus(): Promise<void> {
  await service?.stop();
  service = undefined;
  setAppHooks({ statuses });
}
export const statuses = (ids: string[]) => startStatus().statuses(ids);
export const onStatusChanged = (listener: (status: Status) => void) => startStatus().onStatusChanged(listener);
setAppHooks({ statuses });
export const setTyping: NonNullable<ChannelAdapter['setTyping']> = async (platformId) => {
  await startStatus().setTyping(platformId);
};
export const clearTyping: NonNullable<ChannelAdapter['clearTyping']> = async (platformId) => {
  await startStatus().clearTyping(platformId);
};

onHostStart(async () => {
  await startStatus().ready;
});
onHostShutdown(stopStatus);
