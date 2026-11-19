import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { clientAddress } from '../../modules/device-auth/gate.js';
import { enforceRateLimit } from '../../modules/device-auth/verify.js';
import { parseAuthorization, verifyRequestSignature } from '../app/contract.js';
import type { ErrorBody, ErrorCode, Peer, SessionInfo, SessionRegisterRequest } from './types.js';

export const PEER_PROTOCOL = 1;
export const limits = {
  maxTextBytes: 32768,
  hopLimit: 20,
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

const changes = new EventEmitter();
export function onMeshChange(listener: () => void): () => void {
  changes.on('mesh', listener);
  return () => {
    changes.off('mesh', listener);
  };
}
export function meshChanged(): void {
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
    await db.run("UPDATE peer_sessions SET status='ended' WHERE machine_id=?", id);
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
      .replace(/^[^a-z0-9]+|-+$/g, '')
      .slice(0, 40) || 'session'
  );
}
export async function setMeshMembership(agentId: string, member: boolean) {
  const db = getDb();
  if (member) {
    const agent = await db.get<{ name: string }>('SELECT name FROM agent_groups WHERE id=?', agentId);
    if (!agent) fail(404, 'not_found', 'Agent is not registered.');
    await db.run(
      'INSERT INTO mesh_members(agent_group_id,address) VALUES (?,?) ON CONFLICT(agent_group_id) DO NOTHING',
      agentId,
      label(agent.name),
    );
  } else await db.run('DELETE FROM mesh_members WHERE agent_group_id=?', agentId);
  meshChanged();
}
export async function isMeshMember(agentId: string) {
  return Boolean(await getDb().get('SELECT 1 FROM mesh_members WHERE agent_group_id=?', agentId));
}
export interface RemoteSession {
  id: string;
  machine_id: string;
  machine: string;
  key: string;
  address: string;
  name: string;
  project: string;
  status: SessionInfo['status'];
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
  if (!epoch || machine.epoch !== epoch)
    fail(409, 'superseded', 'This connection no longer owns the machine.', { epoch: machine.epoch });
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
    const prior = await remoteSession(machineId, key);
    const base = label(request.name),
      project = label(request.project);
    const id = prior?.id ?? 'ps_' + randomUUID();
    let name =
      prior &&
      prior.project === project &&
      JSON.parse(
        (await db.get<{ registry_json: string }>('SELECT registry_json FROM peer_sessions WHERE id=?', id))!
          .registry_json,
      ).name === request.name
        ? prior.name
        : base;
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
      request.status,
      JSON.stringify({ name: request.name, sessionId: request.sessionId, startedAt: request.startedAt }),
      registeredAt,
      now,
    );
    return { key, address: address(), name, project, machine: machine.name, status: request.status, registeredAt };
  });
  meshChanged();
  return session;
}
export async function listPeers(): Promise<Peer[]> {
  const db = getDb();
  const agents = await db.all<Peer>(`SELECT m.address, 'agent' AS kind, a.name, NULL AS machine,NULL AS project,
    CASE WHEN EXISTS(SELECT 1 FROM sessions s WHERE s.agent_group_id=a.id AND s.container_status='running') THEN 'busy' ELSE 'idle' END AS status,
    NULL AS lastSeen FROM mesh_members m JOIN agent_groups a ON a.id=m.agent_group_id`);
  const sessions = await db.all<Peer>(`SELECT s.address,'session' AS kind,s.name,m.name AS machine,s.project,
    s.status,m.last_seen_at AS lastSeen FROM peer_sessions s JOIN peer_machines m ON m.id=s.machine_id
    WHERE s.status<>'ended' AND m.revoked_at IS NULL`);
  return [...agents, ...sessions].sort((a, b) => a.address.localeCompare(b.address));
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
) {
  return JSON.stringify({
    text: checkedText(message.text),
    sender: remote.address + ' (Claude Code session)',
    senderId: 'peer:' + remote.machine,
    ...(replyTo ? { replyTo } : {}),
  });
}
