import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { MeshPeerRecord } from '../../mailbox/model.js';
import { envValue } from '../../env.js';
import { AsyncMutex } from '../../db/drivers/shared.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { clientAddress } from '../../modules/device-auth/gate.js';
import { enforceRateLimit } from '../../modules/device-auth/verify.js';
import { parseAuthorization, verifyRequestSignature } from '../app/contract.js';
import type { ErrorBody, ErrorCode, Peer, SessionInfo, SessionRegisterRequest } from './types.js';

export const PEER_PROTOCOL = 1;
export const limits = {
  maxTextBytes: 32768,
  get hopLimit() {
    const value = Number(envValue('PEER_HOP_LIMIT'));
    return Number.isSafeInteger(value) && value > 0 ? value : 20;
  },
  queueTtlMs: 86400000,
  offlineQueueMax: 100,
  machineRate: { limit: 60, windowMs: 600000 },
  keepaliveMs: 15000,
  offlineAfterMs: 60000,
};

registerMigration({
  version: 1,
  name: 'module:peer:initial',
  async up(db) {
    await db.exec(`
      CREATE TABLE peer_machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
      CREATE UNIQUE INDEX peer_machine_names ON peer_machines(name) WHERE revoked_at IS NULL;
      CREATE TABLE mesh_members (agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        address TEXT NOT NULL UNIQUE);
      CREATE TABLE peer_sessions (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES peer_machines(id),
        key TEXT NOT NULL, name TEXT NOT NULL, project TEXT NOT NULL, address TEXT NOT NULL, status TEXT NOT NULL,
        registry_json TEXT NOT NULL, registered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(machine_id,key));
      CREATE UNIQUE INDEX peer_session_addresses ON peer_sessions(address) WHERE status <> 'ended';
      CREATE TABLE peer_conversations (id TEXT PRIMARY KEY, party_a TEXT NOT NULL, party_b TEXT NOT NULL,
        hops INTEGER NOT NULL DEFAULT 0, chain TEXT NOT NULL DEFAULT '[]', UNIQUE(party_a,party_b));
      CREATE TABLE peer_endpoints (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES peer_machines(id),
        actor TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(machine_id,actor));
      CREATE TABLE peer_parties (endpoint_id TEXT NOT NULL REFERENCES peer_endpoints(id),
        session_id TEXT NOT NULL REFERENCES peer_sessions(id), PRIMARY KEY(endpoint_id,session_id));
      CREATE TABLE peer_messages (row_id TEXT PRIMARY KEY, id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        sender_scope TEXT NOT NULL, source_id TEXT NOT NULL, request_hash TEXT NOT NULL, conversation_id TEXT NOT NULL,
        text TEXT NOT NULL, response TEXT NOT NULL, state TEXT NOT NULL, failure_notice INTEGER NOT NULL,
        notify_idle INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, sent_at INTEGER, idle_at INTEGER,
        UNIQUE(sender_scope,source_id));
      CREATE INDEX peer_messages_queue ON peer_messages(recipient,state,expires_at);
      CREATE TABLE peer_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL,
        message_row TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX peer_event_stream ON peer_events(machine_id,seq);
      CREATE TABLE peer_inbound (id TEXT PRIMARY KEY, hub_session TEXT NOT NULL, remote_id TEXT NOT NULL,
        content TEXT NOT NULL, created_at INTEGER NOT NULL, message_row TEXT);
    `);
  },
});

registerMigration({
  version: 2,
  name: 'module:peer:epoch-and-conversation-state',
  async up(db) {
    await db.exec(`
      CREATE TABLE peer_log (id TEXT PRIMARY KEY);
      ALTER TABLE peer_machines ADD COLUMN instance TEXT;
      ALTER TABLE peer_machines ADD COLUMN epoch_seen_at INTEGER;
      ALTER TABLE peer_sessions ADD COLUMN anchor TEXT;
      ALTER TABLE peer_sessions ADD COLUMN successor TEXT;
      ALTER TABLE peer_conversations ADD COLUMN limited INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE peer_conversations ADD COLUMN reset_chain INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE peer_messages ADD COLUMN origin TEXT;
      ALTER TABLE peer_messages ADD COLUMN from_mode TEXT;
      ALTER TABLE peer_inbound ADD COLUMN channel TEXT NOT NULL DEFAULT 'peer';
      CREATE TABLE peer_agent_sends (source TEXT NOT NULL, outbound TEXT NOT NULL, refused INTEGER NOT NULL,
        PRIMARY KEY(source,outbound));
    `);
    await db.run('INSERT INTO peer_log(id) VALUES (?)', 'lg_' + randomUUID());
  },
});

registerMigration({
  version: 3,
  name: 'module:peer:agent-inbox-accepted',
  async up(db) {
    const agentDeliveries = `SELECT row_id FROM peer_messages WHERE state='delivered'
      AND json_extract(response,'$.message.to.kind')='agent'`;
    await db.exec(`
      UPDATE peer_events SET payload=json_set(payload,'$.state','accepted',
        '$.message',json_extract(payload,'$.to.address') || ' delivery: accepted.')
      WHERE kind='delivery' AND json_extract(payload,'$.state')='delivered'
        AND message_row IN (${agentDeliveries});
      UPDATE peer_messages SET state='accepted' WHERE row_id IN (${agentDeliveries});
    `);
  },
});

registerMigration({
  version: 4,
  name: 'module:peer:pending-native-limit',
  async up(db) {
    await db.exec('ALTER TABLE peer_conversations ADD COLUMN pending_native_limit TEXT');
  },
});

registerMigration({
  version: 5,
  name: 'module:peer:lookup-indexes',
  async up(db) {
    await db.exec(`
      CREATE INDEX peer_parties_session ON peer_parties(session_id);
      CREATE INDEX peer_endpoints_actor ON peer_endpoints(actor);
      CREATE INDEX peer_conversations_party_b ON peer_conversations(party_b);
      CREATE INDEX peer_messages_recipient_id ON peer_messages(recipient,id);
    `);
  },
});

export class PeerError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody,
  ) {
    super(body.message);
  }
}
export function fail(status: number, error: ErrorCode, message: string, extra: Partial<ErrorBody> = {}): never {
  throw new PeerError(status, { error, message, ...extra });
}

export const streamRevision = { directory: 0, events: 0 };
const changes = new EventEmitter();
export function onMeshChange(listener: () => void): () => void {
  changes.on('mesh', listener);
  return () => {
    changes.off('mesh', listener);
  };
}
export function meshChanged(): void {
  streamRevision.directory++;
  changes.emit('mesh');
}
export function onMachineRevoked(listener: (id: string) => void): () => void {
  changes.on('revoked', listener);
  return () => {
    changes.off('revoked', listener);
  };
}

export interface Machine {
  id: string;
  name: string;
  public_key: string;
  epoch: number;
  instance: string | null;
  epoch_seen_at: number | null;
  last_seen_at: number | null;
  revoked_at: number | null;
}
export function getMachine(id: string) {
  return getDb().get<Machine>('SELECT * FROM peer_machines WHERE id=?', id);
}
export function listMachines() {
  return getDb().all<Pick<Machine, 'id' | 'name' | 'last_seen_at' | 'revoked_at'>>(
    'SELECT id,name,last_seen_at,revoked_at FROM peer_machines ORDER BY name,created_at',
  );
}
export async function enrollMachine(name: string, publicKey: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(name)) fail(400, 'bad_request', 'Invalid machine name.');
  const der = Buffer.from(publicKey, 'base64url');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
    key.export({ format: 'der', type: 'spki' }).toString('base64url') !== publicKey
  )
    fail(400, 'bad_request', 'Expected a P-256 public key.');
  const id = 'pm_' + createHash('sha256').update(der).digest().subarray(0, 16).toString('base64url');
  const db = getDb();
  await db.transaction(async () => {
    const user = 'peer:' + name;
    if (await db.get('SELECT 1 FROM user_roles WHERE user_id=?', user))
      fail(403, 'not_member', 'A machine cannot have a privileged identity.');
    await db.run(
      'INSERT INTO users(id,kind,display_name,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',
      user,
      'peer',
      name,
      new Date().toISOString(),
    );
    await db.run(
      'INSERT INTO peer_machines(id,name,public_key,created_at) VALUES (?,?,?,?)',
      id,
      name,
      publicKey,
      Date.now(),
    );
  });
  return id;
}
export async function revokeMachine(id: string) {
  const db = getDb();
  const changed = await db.transaction(async () => {
    const result = await db.run(
      'UPDATE peer_machines SET revoked_at=? WHERE id=? AND revoked_at IS NULL',
      Date.now(),
      id,
    );
    const { endRemote } = await import('./lifecycle.js');
    const sessions = await db.all<{ key: string }>(
      "SELECT key FROM peer_sessions WHERE machine_id=? AND status<>'ended'",
      id,
    );
    for (const session of sessions) await endRemote(id, session.key);
    return result.changes;
  });
  if (changed) {
    changes.emit('revoked', id);
    meshChanged();
  }
  return Boolean(changed);
}
export async function verifyPeerRequest(req: IncomingMessage, now = Date.now()) {
  try {
    const fields = parseAuthorization(req.headers.authorization);
    if (!fields || !req.url?.startsWith('/peer/') || !fields.deviceId.startsWith('pm_'))
      fail(401, 'bad_signature', 'Invalid peer signature.');
    const machine = await getMachine(fields.deviceId);
    if (!machine) fail(401, 'unknown_machine', 'Machine is not enrolled.');
    if (machine.revoked_at !== null) fail(403, 'machine_revoked', 'Machine enrollment was revoked.');
    const seconds = Math.floor(now / 1000);
    if (Math.abs(seconds - fields.ts) > 120)
      fail(401, 'stale_timestamp', 'Signing timestamp is outside the allowed window.', { serverTime: now });
    if (fields.protocol !== PEER_PROTOCOL)
      fail(426, 'protocol', 'Unsupported peer protocol.', { protocol: PEER_PROTOCOL, minProtocol: PEER_PROTOCOL });
    if (
      !verifyRequestSignature(
        { ...fields, method: req.method ?? '', target: req.url },
        fields.signature,
        machine.public_key,
      )
    )
      fail(401, 'bad_signature', 'Invalid peer signature.');
    const db = getDb();
    await db.run('DELETE FROM device_auth_nonces WHERE expires_at < ?', seconds);
    const result = await db.run(
      'INSERT INTO device_auth_nonces(device_id,nonce,signed_at,expires_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
      machine.id,
      fields.nonce,
      fields.ts,
      fields.ts + 120,
    );
    if (!result.changes) fail(401, 'replayed', 'Request nonce has already been used.');
    return { machine, bodyHash: fields.bodyHash };
  } catch (error) {
    if (error instanceof PeerError) await enforceRateLimit('peer-auth:' + clientAddress(req), 60, now);
    throw error;
  }
}

function label(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[._-]+/, '')
      .slice(0, 40)
      .replace(/[._-]+$/, '') || 'session'
  );
}
// Removal must not drop a queued job between its final membership check and mailbox acknowledgement.
const inboundDelivery = new AsyncMutex();
export async function withInboundDelivery<T>(action: () => Promise<T>): Promise<T> {
  const release = await inboundDelivery.acquire();
  try {
    return await action();
  } finally {
    release();
  }
}
export function setMeshMembership(agentId: string, member: boolean, address?: string) {
  if (member) return updateMembership(agentId, 'add', address);
  return withInboundDelivery(() => updateMembership(agentId, 'remove'));
}
export function updateMeshAddress(agentId: string, address: string) {
  return updateMembership(agentId, 'update', address);
}

async function writeMemberAddress(agentId: string, operation: 'add' | 'update', requested?: string) {
  const db = getDb();
  const agent = await db.get<{ name: string; address: string | null }>(
    'SELECT a.name,m.address FROM agent_groups a LEFT JOIN mesh_members m ON m.agent_group_id=a.id WHERE a.id=?',
    agentId,
  );
  if (!agent) fail(404, 'not_found', 'Agent is not registered.');
  if (operation === 'update' && agent.address === null) fail(404, 'not_member', 'Agent is not a mesh member.');
  if (operation === 'add' && agent.address !== null && requested === undefined) return;

  const input = requested ?? label(agent.name);
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(input))
    fail(400, 'bad_address', 'Invalid mesh address. Use a peer label of up to 40 characters.');
  const address = label(input);
  if (await db.get('SELECT 1 FROM mesh_members WHERE address=? AND agent_group_id<>?', address, agentId))
    fail(409, 'ambiguous', 'Mesh address is already in use.');
  if (agent.address === address) return;
  if (agent.address === null) {
    await db.run('INSERT INTO mesh_members(agent_group_id,address) VALUES (?,?)', agentId, address);
  } else {
    if (operation === 'add') fail(409, 'ambiguous', 'Group already has a mesh address. Use mesh update to change it.');
    await db.run('UPDATE mesh_members SET address=? WHERE agent_group_id=?', address, agentId);
  }
}
async function updateMembership(agentId: string, operation: 'add' | 'update' | 'remove', address?: string) {
  const db = getDb();
  await db.transaction(async () => {
    if (operation === 'remove') {
      await db.run('DELETE FROM mesh_members WHERE agent_group_id=?', agentId);
      const { dropAgentQueue } = await import('./lifecycle.js');
      await dropAgentQueue(agentId);
    } else {
      await writeMemberAddress(agentId, operation, address);
    }
    const endpoints = await db.all<{ id: string }>(
      'SELECT e.id FROM peer_endpoints e JOIN sessions s ON s.id=e.actor WHERE s.agent_group_id=?',
      agentId,
    );
    if (endpoints.length) {
      const { announceEndpoint } = await import('./routing.js');
      for (const e of endpoints) await announceEndpoint(e.id);
    }
  });
  meshChanged();
}
export async function isMeshMember(agentId: string) {
  return Boolean(await getDb().get('SELECT 1 FROM mesh_members WHERE agent_group_id=?', agentId));
}
export interface RemoteSession {
  anchor: string | null;
  successor: string | null;
  id: string;
  machine_id: string;
  machine: string;
  key: string;
  address: string;
  name: string;
  project: string;
  status: SessionInfo['status'];
  registry_json: string;
  registered_at: number;
  updated_at: number;
}
const remoteQuery = 'SELECT s.*,m.name AS machine FROM peer_sessions s JOIN peer_machines m ON m.id=s.machine_id';
export function remoteSession(machineId: string, key: string) {
  return getDb().get<RemoteSession>(remoteQuery + ' WHERE s.machine_id=? AND s.key=?', machineId, key);
}
export function remoteById(id: string) {
  return getDb().get<RemoteSession>(remoteQuery + ' WHERE s.id=?', id);
}

export async function checkEpoch(id: string, epoch: number) {
  const machine = await getMachine(id);
  if (!machine || machine.revoked_at !== null) fail(403, 'machine_revoked', 'Machine enrollment was revoked.');
  const { liveEpoch } = await import('./stream.js');
  const live = liveEpoch(machine);
  if (live !== epoch) fail(409, 'superseded', 'This connection no longer owns the machine.', { epoch: live });
  await getDb().run('UPDATE peer_machines SET epoch_seen_at=? WHERE id=? AND epoch=?', Date.now(), id, epoch);
  return machine;
}
export async function registerSession(
  machineId: string,
  key: string,
  request: SessionRegisterRequest,
): Promise<SessionInfo> {
  const db = getDb();
  const session = await db.transaction(async () => {
    const machine = await checkEpoch(machineId, request.epoch);
    let prior = await remoteSession(machineId, key);
    if (prior?.successor) {
      // Preserve outstanding receipt attribution when a retired process key is reused.
      await db.run('UPDATE peer_sessions SET key=id WHERE id=?', prior.id);
      prior = undefined;
    }
    const predecessor =
      !prior &&
      (await db.get<RemoteSession>(
        `SELECT * FROM peer_sessions WHERE machine_id=? AND successor IS NULL AND status='ended'
      AND json_extract(registry_json,'$.sessionId')=?
      ORDER BY updated_at DESC,rowid DESC LIMIT 1`,
        machineId,
        request.sessionId,
      ));

    const base = label(request.name),
      project = label(request.project);
    const id = prior?.id ?? 'ps_' + randomUUID();
    let name =
      prior && prior.project === project && JSON.parse(prior.registry_json).name === request.name ? prior.name : base;
    const address = () => name + '@' + project + ':' + machine.name;
    for (
      let suffix = 2;
      await db.get("SELECT 1 FROM peer_sessions WHERE address=? AND id<>? AND status<>'ended'", address(), id);
      suffix++
    ) {
      const tail = '-' + suffix;
      name = base.slice(0, 40 - tail.length) + tail;
    }
    const now = Date.now();
    const registeredAt = prior?.registered_at ?? now;
    const status =
      request.status === 'idle' || request.status === 'busy'
        ? request.status
        : prior?.status === 'idle'
          ? 'idle'
          : 'busy';
    await db.run(
      `INSERT INTO peer_sessions (id,machine_id,key,name,project,address,status,registry_json,registered_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(machine_id,key) DO UPDATE SET name=excluded.name,project=excluded.project,
      address=excluded.address,status=excluded.status,registry_json=excluded.registry_json,updated_at=excluded.updated_at`,
      id,
      machineId,
      key,
      name,
      project,
      address(),
      status,
      JSON.stringify({ name: request.name, sessionId: request.sessionId, startedAt: request.startedAt }),
      registeredAt,
      now,
    );
    if (predecessor) {
      await db.run('UPDATE peer_sessions SET anchor=? WHERE id=?', predecessor.anchor ?? predecessor.id, id);
      await db.run('UPDATE peer_sessions SET successor=? WHERE id=?', id, predecessor.id);
      await db.run('UPDATE peer_endpoints SET actor=? WHERE actor=?', id, predecessor.id);
      await db.run('UPDATE peer_parties SET session_id=? WHERE session_id=?', id, predecessor.id);
      await db.run(
        `UPDATE peer_conversations SET
        party_a=min(?,CASE WHEN party_a=? THEN party_b ELSE party_a END),
        party_b=max(?,CASE WHEN party_a=? THEN party_b ELSE party_a END)
        WHERE party_a=? OR party_b=?`,
        id,
        predecessor.id,
        id,
        predecessor.id,
        predecessor.id,
        predecessor.id,
      );
    }
    const { refreshEndpoints } = await import('./lifecycle.js');
    await refreshEndpoints(id);
    return { key, address: address(), name, project, machine: machine.name, status, registeredAt };
  });
  meshChanged();
  return session;
}
const activeAgents = new WeakMap<ReturnType<typeof getDb>, Set<string>>();
export function agentStatus(agentId: string): 'busy' | 'idle' {
  return activeAgents.get(getDb())?.has(agentId) ? 'busy' : 'idle';
}
export async function refreshAgentStatus() {
  const db = getDb();
  const running = await db.all<{ id: string; agent_group_id: string }>(
    `SELECT s.id,s.agent_group_id FROM sessions s JOIN mesh_members m ON m.agent_group_id=s.agent_group_id WHERE s.container_status IN ('running','idle')`,
  );
  const busy = new Set<string>();
  if (running.length) {
    const { withExistingMailboxSession } = await import('../../session-manager.js');
    for (const s of running) {
      if (busy.has(s.agent_group_id)) continue;
      const record = await withExistingMailboxSession(s.agent_group_id, s.id, (m) => m.getContainerState());
      if (record?.turn === 'working' && Date.now() - Date.parse(record.updatedAt) < 15000) busy.add(s.agent_group_id);
    }
  }
  const previous = activeAgents.get(db) ?? new Set();
  activeAgents.set(db, busy);
  if (previous.size !== busy.size || [...busy].some((id) => !previous.has(id))) meshChanged();
}
type ListedPeer = Peer & Pick<MeshPeerRecord, 'kind' | 'status'>;
export async function listPeers(): Promise<ListedPeer[]> {
  const db = getDb();
  const agents = await db.all<
    ListedPeer & { agentId: string }
  >(`SELECT m.agent_group_id AS agentId,m.address, 'agent' AS kind, a.name, NULL AS machine,NULL AS project,
    'idle' AS status,
    NULL AS lastSeen FROM mesh_members m JOIN agent_groups a ON a.id=m.agent_group_id`);
  const sessions = await db.all<ListedPeer>(`SELECT s.address,'session' AS kind,s.name,m.name AS machine,s.project,
    s.status,m.last_seen_at AS lastSeen FROM peer_sessions s JOIN peer_machines m ON m.id=s.machine_id
    WHERE s.status<>'ended' AND m.revoked_at IS NULL`);
  return [...agents.map(({ agentId, ...peer }) => ({ ...peer, status: agentStatus(agentId) })), ...sessions].sort(
    (a, b) => a.address.localeCompare(b.address),
  );
}
export function checkedText(text: string) {
  if (!text.trim()) fail(400, 'empty_text', 'Write a non-empty message.');
  if (text.trimStart().startsWith('/')) fail(400, 'slash_command', 'Peer messages cannot run slash commands.');
  if (Buffer.byteLength(text) > limits.maxTextBytes)
    fail(413, 'too_large', 'Peer message exceeds the byte limit.', { maxBytes: limits.maxTextBytes });
  return text;
}
export function inboundContent(
  remote: RemoteSession,
  message: { text: string },
  replyTo?: { id: string; sender: string; text: string },
  failureNotice = false,
) {
  return JSON.stringify({
    text: checkedText(message.text),
    sender: remote.address,
    senderKind: 'session',
    senderId: 'peer:' + remote.machine,
    ...(replyTo ? { replyTo } : {}),
    ...(failureNotice ? { failureNotice: true } : {}),
  });
}
