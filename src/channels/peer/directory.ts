import { AsyncResource } from 'node:async_hooks';
import { getDb } from '../../db/connection.js';
import { getActiveSessions } from '../../db/sessions.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { withExistingMailboxSession, withMailboxSession } from '../../session-manager.js';
import { listPeers, onMeshChange } from './store.js';

async function directory() {
  return getDb().transaction(async () => {
    const members = await getDb().all<{ address: string; agent_group_id: string }>(
      'SELECT address, agent_group_id FROM mesh_members',
    );
    const ids = new Map(members.map((m) => [m.address, m.agent_group_id]));
    const peers = members.length ? await listPeers() : [];
    const memberIds = new Set(ids.values());
    const rows = peers.map(({ address, kind, machine, project, status }) => ({
      address,
      kind,
      machine,
      project,
      status,
      agentGroupId: ids.get(address) ?? null,
    }));
    const version = JSON.stringify(rows);
    return {
      versionFor: (agentId: string) => (memberIds.has(agentId) ? version : ''),
      write(agentId: string, sessionId: string, open: typeof withExistingMailboxSession) {
        return open(agentId, sessionId, (mailbox) => {
          mailbox.replaceMeshPeers(memberIds.has(agentId) ? rows : []);
          return true;
        });
      },
    };
  });
}

let tail = Promise.resolve();
function serialize(action: () => Promise<void>) {
  const work = tail.then(action);
  tail = work.catch((err) => log.error('Mesh directory projection failed', { err }));
  return work;
}

export function writeMeshDirectory(agentGroupId: string, sessionId: string) {
  return serialize(async () => {
    const snapshot = await directory();
    await snapshot.write(agentGroupId, sessionId, withMailboxSession);
  });
}

export async function startMeshProjection(signal: AbortSignal) {
  const projected = new Map<string, string>();
  let scheduled: Promise<void> | undefined;
  function refresh() {
    scheduled ??= serialize(async () => {
      const snapshot = await directory();
      const sessions = await getActiveSessions();
      const active = new Set(sessions.map((s) => s.id));
      for (const id of projected.keys()) if (!active.has(id)) projected.delete(id);
      for (const { id, agent_group_id } of sessions) {
        const next = snapshot.versionFor(agent_group_id);
        if (projected.get(id) === next) continue;
        try {
          const written = await snapshot.write(agent_group_id, id, withExistingMailboxSession);
          if (written) projected.set(id, next);
        } catch (err) {
          log.warn('Could not project mesh directory into session', { sessionId: id, err });
        }
      }
    }).finally(() => {
      scheduled = undefined;
    });
    return scheduled;
  }
  // Reconcile missed changes and retry mailboxes that were unavailable during an event.
  const update = () => {
    void refresh().catch(() => {});
  };
  // A template stamp can change membership inside a transaction. Read after its commit.
  const unsubscribe = onMeshChange(AsyncResource.bind(update));
  const timer = setInterval(update, 5_000);
  timer.unref();
  signal.addEventListener(
    'abort',
    () => {
      unsubscribe();
      clearInterval(timer);
    },
    { once: true },
  );
  await refresh();
}

onHostStart(({ signal }) => startMeshProjection(signal));
onHostShutdown(() => tail);
