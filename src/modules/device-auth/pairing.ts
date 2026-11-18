import './db.js';
import { createHash, createPublicKey, randomInt, randomUUID, verify } from 'node:crypto';
import type { AppHandler } from '../../channels/app/routes.js';
import { pairProofText, type PairRequest } from '../../channels/app/contract.js';
import { appConfig } from '../../channels/app/config.js';
import { getDb } from '../../db/connection.js';
import { getUser } from '../permissions/db/users.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import { administeredWirings, commandChat, messageText } from '../../channels/voice-mode-chat.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { registerMessageInterceptor } from '../../router.js';
import { log } from '../../log.js';
import type { PairingCodeRow } from './db.js';
import { authError, enforceRateLimit, reachableAgentIds, readBody, revokeDevice } from './verify.js';
import { clientAddress } from './gate.js';

export async function mintPairingLink(
  userId: string,
  agentIds: string[],
  addedAgentIds = agentIds,
  now = Date.now(),
): Promise<string> {
  const base = appConfig().publicBase;
  if (!base) throw new Error('App pairing is off here.');
  if (!(await getUser(userId))) throw new Error('Unknown user.');
  for (const id of new Set([...agentIds, ...addedAgentIds])) {
    if (!(await getDb().get('SELECT id FROM agent_groups WHERE id = ?', id)) || !(await hasAdminPrivilege(userId, id)))
      throw new Error('The user must administer each agent.');
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const code = Array.from({ length: 32 }, () => alphabet[randomInt(alphabet.length)]).join('');
  const db = getDb();
  await db.transaction(async () => {
    for (const id of addedAgentIds)
      await db.run(
        'INSERT INTO device_auth_user_agents (user_id, agent_group_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        userId,
        id,
        now,
      );
    await db.run(
      'INSERT INTO device_auth_pairing_codes (code_hash, user_id, agent_ids_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      createHash('sha256').update(code).digest('hex'),
      userId,
      JSON.stringify(agentIds),
      now,
      now + 600_000,
    );
  });
  return `${base.replace(/\/$/, '')}/app/pair#${code}`;
}
export const handlePair: AppHandler = async ({ req, res }) => {
  await enforceRateLimit(`pair:${clientAddress(req)}`, 10);
  let body: PairRequest;
  try {
    body = JSON.parse((await readBody(req, 4096)).toString('utf8')) as PairRequest;
  } catch (error) {
    if (error instanceof SyntaxError) throw authError(400, 'bad_request', 'The request is malformed.');
    throw error;
  }
  if (
    !body ||
    typeof body.code !== 'string' ||
    typeof body.publicKey !== 'string' ||
    typeof body.proof !== 'string' ||
    typeof body.deviceName !== 'string' ||
    !body.app ||
    ['version', 'build', 'os'].some((k) => typeof (body.app as unknown as Record<string, unknown>)[k] !== 'string')
  )
    throw authError(400, 'bad_request', 'The request is malformed.');
  let valid = false;
  try {
    const der = Buffer.from(body.publicKey, 'base64url');
    const signature = Buffer.from(body.proof, 'base64url');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    valid =
      der.toString('base64url') === body.publicKey &&
      signature.toString('base64url') === body.proof &&
      key.asymmetricKeyType === 'ec' &&
      key.asymmetricKeyDetails?.namedCurve === 'prime256v1' &&
      verify('sha256', Buffer.from(pairProofText(body.code, body.publicKey)), key, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw authError(400, 'bad_proof', 'The pairing proof is not valid.');
  const db = getDb(),
    now = Date.now(),
    deviceId = `dev_${randomUUID()}`;
  const userId = await db.transaction(async () => {
    const code = await db.get<PairingCodeRow>(
      'UPDATE device_auth_pairing_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING *',
      now,
      createHash('sha256').update(body.code).digest('hex'),
      now,
    );
    if (!code) throw authError(403, 'invalid_code', 'This pairing link is used or expired. Send /pair again.');
    await db.run(
      'INSERT INTO device_auth_devices (id, user_id, name, public_key, app_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      deviceId,
      code.user_id,
      body.deviceName,
      body.publicKey,
      JSON.stringify(body.app),
      now,
    );
    for (const id of JSON.parse(code.agent_ids_json) as string[])
      await db.run('INSERT INTO device_auth_device_agents (device_id, agent_group_id) VALUES (?, ?)', deviceId, id);
    return code.user_id;
  });
  log.info('Device paired', { deviceId, userId, address: clientAddress(req) });
  const agents: { id: string; name: string }[] = [];
  for (const id of await reachableAgentIds(deviceId)) {
    const agent = await db.get<{ id: string; name: string }>('SELECT id, name FROM agent_groups WHERE id = ?', id);
    if (agent) agents.push(agent);
  }
  const { json } = await import('../../channels/app/routes.js');
  json(res, 200, {
    deviceId,
    userName: (await getUser(userId))?.display_name ?? userId,
    agents,
    protocol: 1,
    serverTime: now,
  });
};
export const handleRevoke: AppHandler = async ({ identity, res }) => {
  await revokeDevice(identity!.deviceId);
  res.writeHead(204);
  res.end();
};
export async function handlePairCommand(event: InboundEvent): Promise<boolean> {
  if (event.channelType === 'app' || !/^\/pair(?:@\w+)?$/i.test(messageText(event.message.content))) return false;
  const chat = await commandChat(event, '/pair');
  if (!chat) return true;
  const mine = await administeredWirings(chat.mg, chat.userId);
  if (!mine) return true;
  const say = (text: string) =>
    chat.adapter.deliver(event.platformId, chat.threadId, { kind: 'chat', content: { text } });
  if (!mine.length) {
    await say('Only an owner or admin of this agent can use /pair.');
    return true;
  }
  if (!appConfig().publicBase) {
    await say('App pairing is off here.');
    return true;
  }
  try {
    let destination = { adapter: chat.adapter, platformId: event.platformId, threadId: chat.threadId };
    if (chat.mg.is_group !== 0) {
      const dm = await ensureUserDm(chat.userId, { privacySafeLogs: true, instance: chat.instance });
      const adapter = dm && getChannelAdapterExact(dm.instance ?? dm.channel_type);
      if (!dm || !adapter) {
        await say('Open our direct chat and send /pair there.');
        return true;
      }
      destination = { adapter, platformId: dm.platform_id, threadId: null };
    }
    const link = await mintPairingLink(
      chat.userId,
      [],
      mine.map((w) => w.agent_group_id),
    );
    await destination.adapter.deliver(destination.platformId, destination.threadId, {
      kind: 'chat',
      content: { text: link },
    });
    if (chat.mg.is_group !== 0) await say('Your pairing link is in our direct chat.');
  } catch (error) {
    log.warn('Pairing reply failed', { kind: error instanceof Error ? error.name : typeof error });
  }
  return true;
}
registerMessageInterceptor(handlePairCommand);
