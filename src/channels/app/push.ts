import { onEventAppended } from './log.js';
import { badgeFor, plainPreview } from './conversations.js';
import { log } from '../../log.js';
import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import type { DbDriver } from '../../db/driver.js';
import { readSignedBody, liveDevices, reachableAgentIds, onDeviceRevoked } from '../../modules/device-auth/verify.js';
import { json, type AppHandler } from './routes.js';
import { parseAuthorization, type Badge, type Message, type Question, type PushPayload } from './contract.js';
import type { EventRow, PushTokenRow } from './db.js';
import { allowedPushTopic, appConfig, type AppConfig } from './config.js';
import { sendPush } from './apns.js';

export function pushTokenHandler(db: () => DbDriver = getDb, readBody = readSignedBody): AppHandler {
  return async ({ req, res, identity }) => {
    const auth = parseAuthorization(req.headers.authorization);
    if (!identity || !auth) {
      json(res, 401, { error: 'bad_signature', message: 'A signed request is required.' });
      return;
    }
    const bytes = await readBody(req, auth.bodyHash, 4096);
    let input: unknown;
    try {
      input = JSON.parse(bytes.toString('utf8'));
    } catch {
      input = null;
    }
    const value = input as { token?: unknown; environment?: unknown; topic?: unknown } | null;
    if (
      !value ||
      typeof value.token !== 'string' ||
      !/^(?:[0-9a-f]{2}){16,512}$/.test(value.token) ||
      (value.environment !== 'sandbox' && value.environment !== 'production')
    ) {
      json(res, 400, { error: 'bad_request', message: 'Provide a hexadecimal token and its environment.' });
      return;
    }
    const topic = allowedPushTopic(value.topic, appConfig().apns);
    const database = db();
    await database.transaction(async () => {
      await database.run(
        'DELETE FROM app_push_tokens WHERE token = ? AND device_id <> ?',
        value.token,
        identity.deviceId,
      );
      await database.run(
        `INSERT INTO app_push_tokens (device_id, token, environment, topic, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (device_id) DO UPDATE SET token = excluded.token, environment = excluded.environment, topic = excluded.topic, updated_at = excluded.updated_at`,
        identity.deviceId,
        value.token,
        value.environment,
        topic,
        Date.now(),
      );
    });
    res.writeHead(204);
    res.end();
  };
}
export const registerPushToken = pushTokenHandler();

export interface PushDependencies {
  onEventAppended(listener: (event: EventRow) => void): () => void;
  badgeFor(userId: string, agentIds: string[]): Promise<Badge>;
  plainPreview(text: string): string;
}

export function subscribePush(
  deps: PushDependencies,
  options: {
    db?: () => DbDriver;
    config?: () => AppConfig;
    send?: typeof sendPush;
    agent?: typeof getAgentGroup;
    warn?: (reason: string, fields?: Record<string, unknown>) => void;
    concurrency?: number;
    capacity?: number;
  } = {},
) {
  const db = options.db ?? getDb;
  const config = options.config ?? appConfig;
  const send = options.send ?? sendPush;
  const agent = options.agent ?? getAgentGroup;
  const warn = options.warn ?? ((reason, fields) => log.warn(reason, fields));
  const queue: Array<() => Promise<void>> = [];
  const capacity = Math.max(1, options.capacity ?? 256);
  const concurrency = Math.max(1, options.concurrency ?? 4);
  let active = 0;
  let stopped = false;
  let warnedBase = false;
  let warnedFull = false;
  function enqueue(job: () => Promise<void>) {
    if (stopped) return;
    if (queue.length >= capacity) {
      if (!warnedFull) {
        warnedFull = true;
        warn('QueueFull');
      }
      return;
    }
    queue.push(job);
    drain();
  }
  function drain() {
    while (!stopped && active < concurrency && queue.length) {
      const job = queue.shift()!;
      active++;
      void job()
        .catch(() => warn('PushFailed'))
        .finally(() => {
          active--;
          drain();
        });
    }
  }
  const unsubscribe = deps.onEventAppended((event) => {
    if (!['message', 'question'].includes(event.kind)) return;
    enqueue(async () => {
      const entity = JSON.parse(event.entity_json) as Message | Question;
      if (entity.seq !== entity.order || (entity.kind !== 'message' && entity.kind !== 'question')) return;
      if (entity.kind === 'message' && (!('role' in entity) || entity.role !== 'agent' || entity.voice !== null))
        return;
      const publicBase = config().publicBase;
      if (!publicBase) {
        if (!warnedBase) {
          warnedBase = true;
          warn('PublicBaseMissing');
        }
        return;
      }
      for (const device of await liveDevices(event.user_id)) {
        if (device.revoked_at !== null || device.user_id !== event.user_id) continue;
        enqueue(async () => {
          const agentIds = await reachableAgentIds(device.id);
          if (!agentIds.includes(event.agent_group_id)) return;
          const row = await db().get<PushTokenRow>('SELECT * FROM app_push_tokens WHERE device_id = ?', device.id);
          if (!row || (row.environment !== 'sandbox' && row.environment !== 'production')) return;
          const sender = await agent(event.agent_group_id);
          if (!sender) return;
          const badge = await deps.badgeFor(event.user_id, agentIds);
          const payload: PushPayload = {
            aps: {
              alert: { title: sender.name, body: Array.from(deps.plainPreview(entity.text)).slice(0, 160).join('') },
              'thread-id': entity.conversationId,
              'mutable-content': 1,
              badge: badge.unreadTotal,
              sound: 'default',
              category: 'message',
            },
            hd: {
              v: 1,
              h: publicBase,
              c: entity.conversationId,
              m: entity.id,
              k: entity.kind,
              a: { id: sender.id, name: sender.name },
            },
          };
          if (stopped || !(await reachableAgentIds(device.id)).includes(event.agent_group_id)) return;
          const apns = config().apns;
          const topic = apns.topic && (allowedPushTopic(row.topic, apns) ?? apns.topic);
          const result = await send({ token: row.token, environment: row.environment, topic }, entity.id, payload);
          const fields = {
            deviceId: device.id,
            entityId: entity.id,
            environment: row.environment,
            status: result.status,
            reason: result.reason,
          };
          if (result.status !== 200) warn('PushRejected', fields);
          if (result.clearToken) {
            // A delayed rejection must not erase a replacement registration.
            const deleted = await db().run(
              'DELETE FROM app_push_tokens WHERE device_id = ? AND token = ? AND environment = ? AND topic IS NOT DISTINCT FROM ? AND updated_at = ?',
              device.id,
              row.token,
              row.environment,
              row.topic,
              row.updated_at,
            );
            if (deleted.changes) warn('PushTokenCleared', fields);
          }
        });
      }
    });
  });
  return () => {
    stopped = true;
    queue.length = 0;
    unsubscribe();
  };
}

onDeviceRevoked((deviceId) => {
  void getDb()
    .run('DELETE FROM app_push_tokens WHERE device_id = ?', deviceId)
    .then(({ changes }) => {
      if (changes) log.warn('PushTokenCleared', { deviceId, reason: 'DeviceRevoked' });
    })
    .catch(() => log.warn('TokenCleanupFailed', { deviceId }));
});

subscribePush({ onEventAppended, badgeFor, plainPreview });
