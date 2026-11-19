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
    return {
      members: new Set(ids.values()),
      peers: peers.map(({ address, kind, machine, project, status }) => ({
        address,
        kind,
        machine,
        project,
        status,
        agentGroupId: ids.get(address) ?? null,
      })),
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
    const { members, peers } = await directory();
    await withMailboxSession(agentGroupId, sessionId, (mailbox) =>
      mailbox.replaceMeshPeers(members.has(agentGroupId) ? peers : []),
    );
  });
}

onHostStart(async ({ signal }) => {
  const projected = new Map<string, string>();
  let scheduled: Promise<void> | undefined;
  function refresh() {
    scheduled ??= serialize(async () => {
      const { members, peers } = await directory();
      const version = JSON.stringify(peers);
      const sessions = await getActiveSessions();
      const active = new Set(sessions.map((s) => s.id));
      for (const id of projected.keys()) if (!active.has(id)) projected.delete(id);
      for (const { id, agent_group_id } of sessions) {
        const member = members.has(agent_group_id);
        const next = member ? version : '';
        if (projected.get(id) === next) continue;
        try {
          const written = await withExistingMailboxSession(agent_group_id, id, (mailbox) => {
            mailbox.replaceMeshPeers(member ? peers : []);
            return true;
          });
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
  // Container busy/idle changes also affect the directory, independently of store events.
  const update = () => {
    void refresh().catch(() => {});
  };
  const unsubscribe = onMeshChange(update);
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
});
onHostShutdown(() => tail);
