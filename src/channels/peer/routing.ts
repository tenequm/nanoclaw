import { randomUUID, createHash } from 'node:crypto';
import { getContainerConfig } from '../../db/container-configs.js';
import { resolveProviderName } from '../../providers/provider-name.js';
import { getDb } from '../../db/connection.js';
import { getSession, findSessionForAgent, createSession } from '../../db/sessions.js';
import { createMessagingGroupIfAbsent, getMessagingGroup } from '../../db/messaging-groups.js';
import { isUniqueViolation } from '../../db/errors.js';
import { writeSessionMessage } from '../../session-manager.js';
import { transition, queueNotice } from './lifecycle.js';
import { log } from '../../log.js';
import { basename } from 'node:path';
import { requestWake } from '../../request-wake.js';
import { consumeRateLimit } from '../../modules/device-auth/rate-limit.js';
import type { Session } from '../../types.js';
import {
  PeerError,
  agentStatus,
  checkedText,
  checkEpoch,
  fail,
  inboundContent,
  limits,
  listPeers,
  remoteById,
  remoteSession,
  type RemoteSession,
} from './store.js';
import type { Peer, EndpointRef, EndpointEvent, DeliveryState, SendRequest, SendResponse, PeerEvent } from './types.js';

interface Actor {
  id: string;
  address: string;
  status: Peer['status'];
  context: string | null;
  remote?: RemoteSession;
}
async function actor(id: string): Promise<Actor> {
  if (id.startsWith('ps_')) {
    const remote = await remoteById(id);
    if (!remote || remote.status === 'ended') fail(404, 'not_running', 'This peer is no longer running.');
    return { id, address: remote.address, status: remote.status, context: null, remote };
  }
  const session = await getSession(id);
  const member =
    session &&
    (await getDb().get<{ address: string }>(
      'SELECT address FROM mesh_members WHERE agent_group_id=?',
      session.agent_group_id,
    ));
  if (!session || !member || session.status !== 'active')
    fail(403, 'not_member', 'This agent session is not a mesh member.');
  const group = session.messaging_group_id && (await getMessagingGroup(session.messaging_group_id));
  return {
    id,
    address: member.address,
    status: agentStatus(session.agent_group_id),
    context: group ? group.channel_type : 'peer',
  };
}
async function pairSession(remote: RemoteSession, agentId: string) {
  const groupId =
    'pc_' +
    createHash('sha256')
      .update((remote.anchor ?? remote.id) + '\n' + agentId)
      .digest('base64url');
  await createMessagingGroupIfAbsent({
    id: groupId,
    platform_id: groupId,
    channel_type: 'peer',
    name: remote.address,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
  const prior = await findSessionForAgent(agentId, groupId, null);
  if (prior) return prior.id;
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,engage_mode,engage_pattern,sender_scope,session_mode,threads,created_at)
    VALUES (?,?,?,'pattern','.','known','shared',0,?) ON CONFLICT DO NOTHING`,
    groupId,
    groupId,
    agentId,
    now,
  );
  const id = 'sess-' + randomUUID();
  await createSession({
    id,
    agent_group_id: agentId,
    messaging_group_id: groupId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now,
  });
  return id;
}
async function addressTarget(address: string, sender: Actor): Promise<Actor> {
  if (!/^[a-z0-9][a-z0-9._-]{0,39}(@[a-z0-9][a-z0-9._-]{0,39}(:[a-z0-9][a-z0-9-]{0,15})?)?$/.test(address))
    fail(400, 'bad_address', 'Invalid target address.');
  const peers = await listPeers();
  const matches = peers.filter(
    (p) => p.address === address || (address.includes('@') && p.address.split(':')[0] === address),
  );
  const local = matches.find((p) => p.machine && p.machine === sender.remote?.machine);
  if (!local && matches.length > 1)
    fail(409, 'ambiguous', 'Include a machine name.', { candidates: matches.map((p) => p.address) });
  const target = local ?? matches[0];
  if (!target) {
    if (
      address.includes(':') &&
      (await getDb().get("SELECT 1 FROM peer_sessions WHERE address=? AND status='ended'", address))
    )
      fail(404, 'not_running', 'This session is no longer running.');
    fail(404, 'not_found', 'No mesh member has this address.', { candidates: peers.map((p) => p.address) });
  }
  if (target.address === sender.address) fail(400, 'bad_address', 'Choose a different member.');
  if (target.kind === 'agent') {
    if (!sender.remote) fail(400, 'bad_address', 'Use agent delivery for another agent.');
    const member = await getDb().get<{ agent_group_id: string }>(
      'SELECT agent_group_id FROM mesh_members WHERE address=?',
      target.address,
    );
    return actor(await pairSession(sender.remote, member!.agent_group_id));
  }
  const row = await getDb().get<{ id: string }>(
    "SELECT id FROM peer_sessions WHERE address=? AND status<>'ended'",
    target.address,
  );
  return actor(row!.id);
}

type LogEvent = Extract<PeerEvent, { seq: number }> extends infer E ? Exclude<E, { kind: 'synchronized' }> : never;
type WithoutSeq<E> = E extends unknown ? Omit<E, 'seq'> : never;
export async function appendEvent(machineId: string, event: WithoutSeq<LogEvent>, messageRow: string | null = null) {
  await getDb().run(
    'INSERT INTO peer_events(machine_id,message_row,kind,payload) VALUES (?,?,?,?)',
    machineId,
    messageRow,
    event.kind,
    JSON.stringify(event),
  );
}
export async function announceEndpoint(id: string) {
  const db = getDb();
  const row = await db.get<{ machine_id: string; actor: string; created_at: number }>(
    'SELECT * FROM peer_endpoints WHERE id=?',
    id,
  );
  if (!row) return;
  const sessions = await db.all<{ key: string }>(
    `SELECT s.key FROM peer_parties p JOIN peer_sessions s ON s.id=p.session_id
    WHERE p.endpoint_id=? AND s.status<>'ended' ORDER BY s.key`,
    id,
  );
  const last = await db.get<{ payload: string }>(
    "SELECT payload FROM peer_events WHERE machine_id=? AND kind='endpoint' AND json_extract(payload,'$.id')=? ORDER BY seq DESC LIMIT 1",
    row.machine_id,
    id,
  );
  const prior = last && (JSON.parse(last.payload) as EndpointEvent);
  let source: Actor | undefined;
  try {
    source = await actor(row.actor);
  } catch (error) {
    if (!(error instanceof Error && 'body' in error)) throw error;
  }
  if (!source && !prior) return;
  const open = Boolean(source && sessions.length);
  const peer = source
    ? { address: source.address, kind: source.remote ? ('session' as const) : ('agent' as const) }
    : prior!.peer;
  const context = source?.context ?? prior?.context ?? null;
  const name = context && context !== 'peer' ? peer.address + '-' + context : peer.address;
  const event: Omit<EndpointEvent, 'seq'> = {
    kind: 'endpoint',
    id,
    name,
    peer,
    context,
    sessions: sessions.map((s) => s.key),
    state: open ? 'open' : 'closed',
    createdAt: row.created_at,
    closedAt: open ? null : (prior?.closedAt ?? Date.now()),
  };
  if (JSON.stringify(event) !== last?.payload) await appendEvent(row.machine_id, event);
}
async function endpoint(source: Actor, receiver: RemoteSession): Promise<EndpointRef> {
  const db = getDb();
  const row = await db.get<{ id: string }>(
    `INSERT INTO peer_endpoints(id,machine_id,actor,created_at) VALUES (?,?,?,?)
    ON CONFLICT(machine_id,actor) DO UPDATE SET actor=excluded.actor RETURNING id`,
    'pe_' + randomUUID(),
    receiver.machine_id,
    source.id,
    Date.now(),
  );
  const id = row!.id;
  await db.run('INSERT INTO peer_parties(endpoint_id,session_id) VALUES (?,?) ON CONFLICT DO NOTHING', id, receiver.id);
  await announceEndpoint(id);
  return {
    id,
    peer: source.address,
    name: source.context && source.context !== 'peer' ? source.address + '-' + source.context : source.address,
  };
}
async function endpointTarget(id: string, sender: RemoteSession) {
  const row = await getDb().get<{ actor: string }>(
    'SELECT actor FROM peer_endpoints WHERE machine_id=? AND id=?',
    sender.machine_id,
    id,
  );
  if (!row) fail(404, 'unknown_endpoint', 'This endpoint is unknown.');
  if (!(await getDb().get('SELECT 1 FROM peer_parties WHERE endpoint_id=? AND session_id=?', id, sender.id)))
    fail(403, 'not_a_party', 'This session is not a party to the conversation.');
  return actor(row.actor);
}

export interface MessageRow {
  row_id: string;
  id: string;
  sender: string;
  recipient: string;
  sender_scope: string;
  source_id: string;
  request_hash: string;
  conversation_id: string;
  text: string;
  response: string;
  state: DeliveryState;
  created_at: number;
  expires_at: number;
  failure_notice: number;
  notify_idle: number;
  idle_at: number | null;
  sent_at: number | null;
}
interface Send {
  id: string;
  sourceId: string;
  hash: string;
  text: string;
  origin: SendRequest['origin'];
  chain?: string[];
  mode: SendRequest['fromMode'] | null;
  notify: boolean;
  failure: boolean;
  reply?: boolean;
}
async function previous(scope: string, sourceId: string, hash: string) {
  const row = await getDb().get<MessageRow>(
    'SELECT * FROM peer_messages WHERE sender_scope=? AND source_id=?',
    scope,
    sourceId,
  );
  if (!row) return;
  if (row.request_hash !== hash) fail(409, 'id_conflict', 'Message id already used for different content.');
  const result: SendResponse = JSON.parse(row.response);
  result.message.state = row.state;
  return result;
}
async function conversationFor(source: string, target: string) {
  const db = getDb();
  const [a, b] = [source, target].sort();
  const conversation = await db.get<{
    id: string;
    hops: number;
    chain: string;
    limited: number;
    pending_native_limit: string | null;
    reset_chain: number;
  }>(
    `INSERT INTO peer_conversations(id,party_a,party_b) VALUES (?,?,?)
    ON CONFLICT(party_a,party_b) DO UPDATE SET party_a=excluded.party_a RETURNING id,hops,chain,limited,pending_native_limit,reset_chain`,
    randomUUID(),
    a,
    b,
  );
  return conversation!;
}
export async function reserveAgentHop(source: Session, target: Session, outbound: string) {
  const db = getDb();
  return db.transaction(async () => {
    const member = await db.get(
      'SELECT 1 FROM mesh_members a JOIN mesh_members b ON b.agent_group_id=? WHERE a.agent_group_id=?',
      target.agent_group_id,
      source.agent_group_id,
    );
    if (!member) return 'unlimited';
    const prior = await db.get<{ refused: number }>(
      'SELECT refused FROM peer_agent_sends WHERE source=? AND outbound=?',
      source.id,
      outbound,
    );
    if (prior) return prior.refused ? 'refused' : 'allowed';
    const c = await conversationFor(source.id, target.id);
    const refused = c.hops >= limits.hopLimit;
    await db.run('INSERT INTO peer_agent_sends(source,outbound,refused) VALUES (?,?,?)', source.id, outbound, +refused);
    if (refused) {
      const text = 'Conversation paused after ' + c.hops + ' messages. An owner turn resets the limit.';
      if (!c.limited) {
        await queueNotice(source.id, target.agent_group_id, text, 'agent');
        await queueNotice(target.id, source.agent_group_id, text, 'agent');
        await db.run('UPDATE peer_conversations SET limited=1 WHERE id=?', c.id);
      } else log.info('Peer hop limit', { conversation: c.id, outbound });
      return 'refused';
    }
    await db.run('UPDATE peer_conversations SET hops=hops+1,reset_chain=0 WHERE id=?', c.id);
    return 'allowed';
  });
}
async function queue(sender: Actor, target: Actor, scope: string, input: Send): Promise<SendResponse> {
  const db = getDb(),
    now = Date.now();
  checkedText(input.text);
  const conversation = await conversationFor(sender.id, target.id);
  const stopped = conversation.hops >= limits.hopLimit;
  const count = Math.min(conversation.hops + 1, limits.hopLimit);
  if (!stopped && target.status === 'offline') {
    const queued = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM peer_messages WHERE recipient=? AND state='queued' AND expires_at>?",
      target.id,
      now,
    );
    if (queued!.n >= limits.offlineQueueMax) fail(409, 'queue_full', 'Offline queue is full.');
  }
  const chain = conversation.reset_chain ? [] : (input.chain ?? JSON.parse(conversation.chain));
  // Receipts name only the recipient session and the wire id.
  if (target.remote && (await db.get('SELECT 1 FROM peer_messages WHERE recipient=? AND id=?', target.id, input.id)))
    fail(409, 'id_conflict', 'Message id already used for this recipient.');
  const row = randomUUID();
  const from = target.remote && (await endpoint(sender, target.remote));
  const to = sender.remote && (await endpoint(target, sender.remote));
  const result: SendResponse = {
    message: {
      id: input.id,
      state: stopped ? 'refused' : 'queued',
      to: { address: target.address, kind: target.remote ? 'session' : 'agent', status: target.status },
      endpoint: (to ?? from)!,
      hop: { count, limit: limits.hopLimit },
      createdAt: now,
      expiresAt: now + limits.queueTtlMs,
    },
  };
  if (!stopped)
    await db.run(
      'UPDATE peer_conversations SET hops=?,chain=?,reset_chain=0 WHERE id=?',
      count,
      JSON.stringify(chain),
      conversation.id,
    );
  await db.run(
    `INSERT INTO peer_messages(row_id,id,sender,recipient,sender_scope,source_id,request_hash,conversation_id,text,
    response,state,failure_notice,notify_idle,created_at,expires_at,origin,from_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row,
    input.id,
    sender.id,
    target.id,
    scope,
    input.sourceId,
    input.hash,
    conversation.id,
    input.text,
    JSON.stringify(result),
    result.message.state,
    +input.failure,
    +input.notify,
    now,
    result.message.expiresAt,
    input.origin,
    input.mode,
  );
  if (stopped) {
    const nativeSender = sender.remote?.anchor ?? sender.id;
    const owesReplyNotice = input.reply && conversation.pending_native_limit === nativeSender;
    if (conversation.limited && !owesReplyNotice) {
      log.info('Peer hop limit', { conversation: conversation.id, id: input.id });
      return result;
    }
    // An address send receives the HTTP refusal directly. Its first later native reply has no tool result.
    await db.run(
      'UPDATE peer_conversations SET limited=1,pending_native_limit=? WHERE id=?',
      sender.remote && !input.reply ? nativeSender : null,
      conversation.id,
    );
    const message = 'Conversation paused after ' + count + ' messages. A human turn resets the limit.';
    for (const [recipient, other, ref] of [
      [target, sender, from],
      [sender, target, to],
    ] as const) {
      if (recipient === target && conversation.limited) continue;
      if (recipient === sender && recipient.remote && !input.reply) continue;
      if (recipient.remote)
        await appendEvent(
          recipient.remote.machine_id,
          {
            kind: 'limit',
            session: recipient.remote.key,
            endpoint: ref!,
            hop: result.message.hop,
            stopped: { id: input.id, direction: recipient === target ? 'in' : 'out' },
            message,
            at: now,
          },
          row,
        );
      else if (!input.failure) await queueNotice(recipient.id, other.id, message);
    }
    return result;
  }
  if (target.remote) {
    await appendEvent(
      target.remote.machine_id,
      {
        kind: 'message',
        id: input.id,
        session: target.remote.key,
        endpoint: from!,
        text: input.text,
        hopChain: chain,
        fromMode: input.mode,
        hop: result.message.hop,
        notifyWhenIdle: input.notify,
        failureNotice: input.failure,
        createdAt: now,
        expiresAt: result.message.expiresAt,
      },
      row,
    );
  } else {
    const prior = input.reply
      ? await db.get<{ id: string; text: string }>(
          "SELECT id,text FROM peer_messages WHERE conversation_id=? AND sender=? AND state IN ('sent','accepted','delivered','held') AND recipient IN (SELECT id FROM peer_sessions WHERE coalesce(anchor,id)=?) ORDER BY rowid DESC LIMIT 1",
          conversation.id,
          target.id,
          sender.remote!.anchor ?? sender.id,
        )
      : undefined;
    const content = inboundContent(sender.remote!, input, prior && { ...prior, sender: target.address }, input.failure);
    await db.run(
      'INSERT INTO peer_inbound(id,hub_session,remote_id,content,created_at,message_row) VALUES (?,?,?,?,?,?)',
      row,
      target.id,
      sender.id,
      content,
      now,
      row,
    );
  }
  return result;
}

let draining: Promise<void> | undefined;
export function drainInbound(): Promise<void> {
  if (draining) return draining;
  draining = deliverInbound().finally(() => {
    draining = undefined;
  });
  return draining;
}
async function deliverInbound() {
  const db = getDb();
  const jobs = await db.all<{ id: string }>('SELECT id FROM peer_inbound ORDER BY rowid LIMIT 100');
  for (const { id } of jobs) {
    // Membership removal and a mailbox write must agree on which side won the race.
    const delivered = await db.transaction(async () => {
      const job = await db.get<{
        id: string;
        hub_session: string;
        remote_id: string;
        content: string;
        created_at: number;
        message_row: string | null;
        channel: string;
      }>('SELECT * FROM peer_inbound WHERE id=?', id);
      if (!job) return;
      const session = await getSession(job.hub_session);
      let failure: string | null = null;
      if (!session || session.status !== 'active') failure = 'route_failed';
      else if (!(await db.get('SELECT 1 FROM mesh_members WHERE agent_group_id=?', session.agent_group_id)))
        failure = 'not_member';
      else {
        try {
          await writeSessionMessage(session.agent_group_id, session.id, {
            id: 'peer-' + job.id,
            kind: 'chat',
            timestamp: new Date(job.created_at).toISOString(),
            platformId: job.remote_id,
            channelType: job.channel,
            content: job.content,
          });
        } catch (error) {
          if (!isUniqueViolation(error)) failure = 'route_failed';
        }
      }
      if (job.message_row) {
        const row = await db.get<MessageRow>('SELECT * FROM peer_messages WHERE row_id=?', job.message_row);
        if (row) await transition(row, failure ? 'dropped' : 'accepted', failure, Date.now());
      }
      await db.run('DELETE FROM peer_inbound WHERE id=?', job.id);
      return failure ? undefined : session;
    });
    if (delivered)
      await requestWake(delivered, 'inbound-message').catch(() => log.warn('Peer inbox wake deferred to host sweep'));
  }
}
function hopLimitError(result: SendResponse) {
  return new PeerError(409, {
    error: 'hop_limit',
    message: 'Conversation is paused until a human takes part.',
    hop: result.message.hop,
  });
}
export async function sendRemote(machineId: string, request: SendRequest) {
  const to = 'endpoint' in request.to ? ['endpoint', request.to.endpoint] : ['address', request.to.address];
  const hash = createHash('sha256')
    .update(JSON.stringify([request.from.session, to, request.text]))
    .digest('hex');
  const db = getDb();
  const result = await db.transaction(async () => {
    await checkEpoch(machineId, request.epoch);
    const duplicate = await previous(machineId, request.id, hash);
    if (duplicate) return duplicate;
    const rate = await consumeRateLimit(
      'peer-send:' + machineId,
      limits.machineRate.limit,
      limits.machineRate.windowMs,
    );
    if (!rate.allowed)
      return new PeerError(429, {
        error: 'rate_limited',
        message: 'Machine send limit reached.',
        retryAfter: rate.retryAfter,
      });
    try {
      return await db.transaction(async () => {
        checkedText(request.text);
        const remote = await remoteSession(machineId, request.from.session);
        if (!remote || remote.status === 'ended') fail(404, 'unknown_session', 'Register the sending session.');
        const sender = await actor(remote.id);
        const reply = 'endpoint' in request.to;
        const target =
          'endpoint' in request.to
            ? await endpointTarget(request.to.endpoint, remote)
            : await addressTarget(request.to.address, sender);
        const sent = await queue(sender, target, machineId, {
          id: request.id,
          sourceId: request.id,
          hash,
          text: request.text,
          origin: request.origin,
          chain: request.hopChain,
          mode: request.fromMode,
          notify: false,
          failure: request.failureNotice,
          reply,
        });
        return sent.message.state === 'refused' ? hopLimitError(sent) : sent;
      });
    } catch (error) {
      if (error instanceof PeerError) return error;
      throw error;
    }
  });
  if (result instanceof PeerError) throw result;
  return result;
}

export function peerText(content: Record<string, unknown>) {
  const string = (value: unknown) => (typeof value === 'string' ? value : '');
  const parts: string[] = [];
  if (content.type === 'ask_question') {
    parts.push(string(content.title), string(content.question));
    if (Array.isArray(content.options))
      for (const option of content.options) parts.push(string(option?.label ?? option));
  } else {
    const card = content.card as { title?: string; description?: string; children?: unknown[] } | undefined;
    parts.push(
      string(content.fallbackText) ||
        string(content.text) ||
        [card?.title, card?.description].filter(Boolean).join('\n'),
    );
    if (content.type === 'card' && !parts.some(Boolean)) parts.push('Card');
    if (content.operation === 'edit') parts.unshift('Edit');
    if (content.operation === 'reaction') parts.push('Reaction ' + string(content.emoji));
  }
  if (Array.isArray(content.files))
    for (const file of content.files) {
      if (typeof file === 'string') parts.push('[file not sent: ' + basename(file) + ']');
    }
  return parts.filter(Boolean).join('\n');
}
export async function routeAgentPeer(
  session: Session,
  msg: { id: string; platformId: string | null; content: string },
) {
  const data = JSON.parse(msg.content);
  const hash = createHash('sha256')
    .update(JSON.stringify([msg.platformId, msg.content]))
    .digest('hex');
  const result = await getDb()
    .transaction(async () => {
      const sender = await actor(session.id);
      const old = await previous(session.id, msg.id, hash);
      if (old) return old;
      const address = msg.platformId ?? '';
      let target: Actor;
      if (address.startsWith('ps_') && !address.includes('@')) {
        const remote = await remoteById(address);
        const current =
          remote?.successor &&
          (await getDb().get<{ id: string }>(
            "SELECT id FROM peer_sessions WHERE coalesce(anchor,id)=? AND status<>'ended'",
            remote.anchor ?? remote.id,
          ));
        target = await actor(current ? current.id : address);
      } else if (address.startsWith('pc_') && session.messaging_group_id === address) {
        const row = await getDb().get<{ remote_id: string }>(
          'SELECT CASE WHEN party_a=? THEN party_b ELSE party_a END AS remote_id FROM peer_conversations WHERE party_a=? OR party_b=? ORDER BY rowid LIMIT 1',
          session.id,
          session.id,
          session.id,
        );
        if (!row) fail(404, 'unknown_session', 'No peer for this chat.');
        target = await actor(row.remote_id);
      } else target = await addressTarget(address, sender);
      const config = await getContainerConfig(session.agent_group_id);
      const provider = resolveProviderName(session.agent_provider, config?.provider);
      return queue(sender, target, session.id, {
        id: randomUUID(),
        sourceId: msg.id,
        hash,
        text: peerText(data),
        origin: 'unknown',
        mode: provider === 'claude' ? 'bypass' : null,
        notify: false,
        failure: data.failureNotice === true,
      });
    })
    .catch(async (error: unknown) => {
      if (error instanceof PeerError && error.status < 500 && error.status !== 429 && data.failureNotice !== true) {
        try {
          await writeSessionMessage(session.agent_group_id, session.id, {
            id: 'peer-refusal-' + msg.id,
            kind: 'chat',
            timestamp: new Date().toISOString(),
            platformId: msg.platformId,
            channelType: 'peer',
            content: JSON.stringify({ sender: 'Peer delivery', failureNotice: true, text: error.body.message }),
          });
          await requestWake(session, 'inbound-message');
        } catch (writeError) {
          if (!isUniqueViolation(writeError)) throw writeError;
        }
      }
      throw error;
    });
  if (data.type === 'ask_question' && typeof data.questionId === 'string' && data.questionId === msg.id) {
    try {
      await writeSessionMessage(session.agent_group_id, session.id, {
        id: 'peer-question-' + msg.id,
        kind: 'system',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({
          type: 'question_response',
          questionId: msg.id,
          selectedOption: 'Sent as plain text. The peer can reply in the conversation.',
        }),
        trigger: false,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return result;
}
