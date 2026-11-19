import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Ajv2020 } from 'ajv/dist/2020.js';
import requests from './requests.json' with { type: 'json' };
import type { ChannelAdapter, ChannelDefaults } from '../adapter.js';
import { registerChannelAdapter } from '../channel-registry.js';
import { registerRootHandler } from '../../webhook-server.js';
import { envValue } from '../../env.js';
import { getDb } from '../../db/connection.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { AuthError, readBody } from '../../modules/device-auth/verify.js';
import { admitsVoiceModePeer, parseCidrs, type VoiceModeProxyPolicy } from '../../modules/device-auth/gate.js';
import { log } from '../../log.js';
import { json } from '../app/http.js';
import {
  checkEpoch,
  fail,
  getMachine,
  limits,
  listPeers,
  meshChanged,
  PeerError,
  PEER_PROTOCOL,
  registerSession,
  refreshAgentStatus,
  remoteSession,
  verifyPeerRequest,
} from './store.js';
import { drainInbound, routeAgentPeer, sendRemote } from './routing.js';
import { endRemote, heartbeat, refreshEndpoints, reports, resetHops, sweepPeers } from './lifecycle.js';
import { closeStream, closeStreams, openStream, streamIsOpen } from './stream.js';
import type { HelloRequest, PeerSchemas } from './types.js';
import './agent-docs.js';

const ajv = new Ajv2020({ strict: false, validateFormats: false }).addSchema(requests, 'peer');
function decode<K extends keyof typeof requests.components.schemas & keyof PeerSchemas>(
  schema: K,
  body: unknown,
): PeerSchemas[K] {
  if (!ajv.validate('peer#/components/schemas/' + schema, body))
    fail(400, 'bad_request', 'Invalid ' + schema + ' body.');
  return body as PeerSchemas[K];
}
const settings = {
  heartbeatMs: 20000,
  streamSilenceMs: 45000,
  backoffInitialMs: 500,
  backoffMaxMs: 10000,
  backoffResetAfterMs: 5000,
  acceptWindowMs: 5000,
  requestTimeoutMs: 10000,
  sendWaitMs: 5000,
};
function helloInfo() {
  return {
    protocol: PEER_PROTOCOL,
    minProtocol: PEER_PROTOCOL,
    features: ['agents', 'sessions', 'hop-limit', 'idle'],
    serverTime: Date.now(),
  };
}
async function hello(machineId: string, body: HelloRequest) {
  const db = getDb();
  const result = await db.transaction(async () => {
    const minAmesh = envValue('PEER_MIN_AMESH');
    if (minAmesh && body.amesh.version.localeCompare(minAmesh, 'en', { numeric: true }) < 0)
      fail(426, 'upgrade_required', 'Update the daemon to ' + minAmesh + ' or later.', { minAmesh });
    const machine = await getMachine(machineId);
    if (!machine || machine.revoked_at !== null) fail(403, 'machine_revoked', 'Enrollment revoked.');
    if (
      (streamIsOpen(machineId) || (machine.last_seen_at ?? 0) > Date.now() - limits.offlineAfterMs) &&
      body.resumeEpoch !== machine.epoch &&
      !body.takeover
    )
      fail(409, 'machine_in_use', 'Machine already has an active daemon.', { epoch: machine.epoch });
    const epoch = machine.epoch + 1;
    await db.run('UPDATE peer_machines SET epoch=?,last_seen_at=? WHERE id=?', epoch, Date.now(), machine.id);
    return { ...helloInfo(), machine: { id: machine.id, name: machine.name }, epoch, settings, limits };
  });
  closeStream(machineId, result.epoch, body.takeover && body.resumeEpoch !== result.epoch - 1);
  return result;
}
function networkPolicy(): VoiceModeProxyPolicy {
  return {
    trustedProxies: parseCidrs(envValue('VOICE_MODE_TRUSTED_PROXY_CIDRS'), 'VOICE_MODE_TRUSTED_PROXY_CIDRS'),
    allowedClients: parseCidrs(
      envValue('VOICE_MODE_ALLOWED_CLIENT_CIDRS') || '100.64.0.0/10,fd7a:115c:a1e0::/48',
      'VOICE_MODE_ALLOWED_CLIENT_CIDRS',
    ),
  };
}
export async function dispatchPeer(req: IncomingMessage, res: ServerResponse, policy: VoiceModeProxyPolicy) {
  try {
    if (!admitsVoiceModePeer(policy, req.socket.remoteAddress, req.headers['x-forwarded-for']))
      fail(403, 'not_member', 'Network path is not allowed.');
    const path = req.url?.split('?')[0],
      method = req.method;
    if (path === '/peer/hello' && method === 'GET') {
      await readBody(req, 0);
      return json(res, 200, helloInfo());
    }
    const { machine, bodyHash } = await verifyPeerRequest(req);
    const raw = await readBody(req, 256 * 1024, bodyHash);
    if (method === 'GET') {
      if (raw.length) fail(400, 'bad_body', 'GET body must be empty.');
      const url = new URL(req.url!, 'http://localhost');
      if (path === '/peer/peers') {
        const project = url.searchParams.get('project'),
          name = url.searchParams.get('machine');
        if (
          (name !== null && (!project || !/^[a-z0-9][a-z0-9-]{0,15}$/.test(name))) ||
          (project !== null && !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(project))
        )
          fail(400, 'bad_request', 'Invalid directory filter.');
        return json(res, 200, {
          peers: (await listPeers()).filter(
            (p) => (!project || p.project === project) && (!name || p.machine === name),
          ),
          serverTime: Date.now(),
        });
      }
      if (path === '/peer/events') {
        const match = /^\?after=(0|[1-9][0-9]*)&epoch=([1-9][0-9]*)$/.exec(url.search);
        if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])))
          fail(400, 'bad_request', 'Expected after and epoch.');
        return await openStream(res, machine.id, Number(match[2]), Number(match[1]));
      }
    }
    let body: unknown;
    try {
      body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
    } catch {
      fail(400, 'bad_body', 'Expected a JSON object.');
    }
    if (path === '/peer/hello' && method === 'POST')
      return json(res, 200, await hello(machine.id, decode('HelloRequest', body)));
    if (path === '/peer/heartbeat' && method === 'POST')
      return json(res, 200, await heartbeat(machine.id, decode('HeartbeatRequest', body)));
    if (path === '/peer/reports' && method === 'POST')
      return json(res, 200, await reports(machine.id, decode('ReportsRequest', body)));
    if (path === '/peer/messages' && method === 'POST') {
      if (body && typeof body === 'object' && 'text' in body && body.text === '')
        fail(400, 'empty_text', 'Write a non-empty message.');
      return json(res, 200, await sendRemote(machine.id, decode('SendRequest', body), bodyHash));
    }
    const session = /^\/peer\/sessions\/([1-9][0-9]{0,9}-[0-9a-f]{8})(?:\/(end|human))?$/.exec(path ?? '');
    if (session) {
      const [, key, action] = session;
      if (!action && method === 'PUT') {
        const value = await registerSession(machine.id, key, decode('SessionRegisterRequest', body));
        const remote = await remoteSession(machine.id, key);
        await refreshEndpoints(remote!.id);
        return json(res, 200, { session: value });
      }
      if (method === 'POST' && action) {
        const input = action === 'end' ? decode('SessionEndRequest', body) : decode('HumanTurnRequest', body);
        const response = await getDb().transaction(async () => {
          await checkEpoch(machine.id, input.epoch);
          if (action === 'end') return endRemote(machine.id, key);
          const remote = await remoteSession(machine.id, key);
          if (!remote || remote.status === 'ended') fail(404, 'unknown_session', 'Session is not registered.');
          return { reset: await resetHops(remote.id) };
        });
        if (action === 'end') meshChanged();
        return json(res, 200, response);
      }
    }
    fail(404, 'not_found', 'Unknown peer route.');
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof PeerError || error instanceof AuthError) {
      if (error.status === 429) res.setHeader('Retry-After', String(error.body.retryAfter ?? 1));
      return json(res, error.status, error.body);
    }
    log.error('Peer request failed', { kind: error instanceof Error ? error.name : 'unknown' });
    return json(res, 500, { error: 'internal', message: 'Peer request failed.' });
  }
}

const defaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'never',
};
export function createPeerAdapter(): ChannelAdapter {
  let active = false,
    timer: NodeJS.Timeout | undefined,
    running: Promise<void> | undefined;

  async function maintain() {
    await sweepPeers();
    await drainInbound();
    await refreshAgentStatus();
  }
  return {
    name: 'peer',
    channelType: 'peer',
    supportsThreads: false,
    defaults,
    async setup() {
      const policy = networkPolicy();
      registerRootHandler('peer', (req, res) => dispatchPeer(req, res, policy));
      active = true;
      timer = setInterval(() => {
        if (!running)
          running = maintain()
            .catch((error) =>
              log.warn('Peer maintenance failed', { kind: error instanceof Error ? error.name : 'unknown' }),
            )
            .finally(() => {
              running = undefined;
            });
      }, 2000).unref();
    },
    async teardown() {
      active = false;
      clearInterval(timer);
      closeStreams();
      await running;
    },
    isConnected: () => active,
    async deliver(platformId, _thread, message) {
      const owner = await getDb().get<{ agent_group_id: string }>(
        'SELECT agent_group_id FROM messaging_group_agents WHERE messaging_group_id=?',
        platformId,
      );
      const session =
        owner && (await getSessionsByAgentGroup(owner.agent_group_id)).find((s) => s.messaging_group_id === platformId);
      if (!session) fail(404, 'unknown_session', 'Unknown peer chat.');
      const content = {
        ...(typeof message.content === 'object' ? message.content : {}),
        ...(message.files ? { files: message.files.map((f) => f.filename) } : {}),
      };
      const response = await routeAgentPeer(session, {
        id: message.sourceId ?? randomUUID(),
        platformId,
        content: JSON.stringify(content),
      });
      return response.message.id;
    },
  };
}
registerChannelAdapter('peer', { factory: createPeerAdapter, defaults });
