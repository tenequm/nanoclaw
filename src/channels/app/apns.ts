import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect, type ClientHttp2Session } from 'node:http2';
import { setTimeout as delay } from 'node:timers/promises';
import { log } from '../../log.js';
import { readAppConfig, type AppConfig } from './config.js';
import type { PushPayload } from './contract.js';

export interface PushDestination {
  token: string;
  environment: 'sandbox' | 'production';
}
export interface PushResult {
  status: number;
  reason?: string;
  clearToken: boolean;
}
type Environment = PushDestination['environment'];
const deadTokens = new Set(['BadDeviceToken', 'Unregistered', 'ExpiredToken', 'DeviceTokenNotForTopic']);
const origins = { sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' };

export function createApnsClient(options: {
  config: AppConfig['apns'];
  origins?: Record<Environment, string>;
  now?: () => number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
  warn?: (environment: Environment, reason: string) => void;
}) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const warn = options.warn ?? ((environment, reason) => log.warn('APNs', { environment, reason }));
  const keys = new Map<Environment, KeyObject | null>();
  const tokens = new Map<Environment, { value: string; at: number }>();
  const sessions = new Map<string, ClientHttp2Session>();
  function jwt(environment: Environment, failedToken?: string): string | null {
    const config = options.config[environment];
    if (!keys.has(environment)) {
      let key: KeyObject | null = null;
      try {
        if (config && options.config.teamId) {
          key = createPrivateKey(readFileSync(config.keyPath));
          if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') key = null;
        }
      } catch {
        /* A missing or unreadable key disables only its environment. */
      }
      keys.set(environment, key);
      if (!key) warn(environment, 'EnvironmentDisabled');
    }
    const key = keys.get(environment);
    if (!key || !config) return null;
    const cached = tokens.get(environment);
    const at = now();
    if (cached) {
      if (failedToken && cached.value !== failedToken) return cached.value;
      if (failedToken && at - cached.at < 20 * 60_000) return cached.value;
      if (!failedToken && at >= cached.at && at - cached.at < 45 * 60_000) return cached.value;
    }
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'ES256', kid: config.keyId })}.${encode({ iss: options.config.teamId, iat: Math.floor(at / 1000) })}`;
    const value = `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    tokens.set(environment, { value, at });
    return value;
  }
  function session(environment: Environment) {
    const origin = (options.origins ?? origins)[environment];
    let current = sessions.get(origin);
    if (!current || current.closed || current.destroyed) {
      current = connect(origin);
      const opened = current;
      sessions.set(origin, opened);
      const forget = () => {
        if (sessions.get(origin) === opened) sessions.delete(origin);
        opened.close();
      };
      opened.on('goaway', forget);
      opened.on('error', forget);
      opened.on('close', forget);
    }
    return current;
  }
  async function request(
    destination: PushDestination,
    entityId: string,
    body: string,
    token: string,
  ): Promise<PushResult> {
    return new Promise((resolve) => {
      const connection = session(destination.environment);
      const stream = connection.request({
        ':method': 'POST',
        ':path': `/3/device/${destination.token}`,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-topic': options.config.topic,
        'apns-collapse-id': entityId,
        'apns-id': randomUUID(),
        authorization: `bearer ${token}`,
        'content-type': 'application/json',
      });
      let status = 0;
      let response = '';
      let finished = false;
      const finish = (reason?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (status === 0 || reason?.startsWith('Transport')) {
          status = 0;
          const origin = (options.origins ?? origins)[destination.environment];
          if (sessions.get(origin) === connection) sessions.delete(origin);
          connection.destroy();
        }
        resolve({ status, reason, clearToken: deadTokens.has(reason ?? '') });
      };
      const timer = setTimeout(() => {
        finish('TransportTimeout');
        stream.close();
      }, options.timeoutMs ?? 10_000);
      stream.setEncoding('utf8');
      stream.on('response', (headers) => {
        status = Number(headers[':status']);
      });
      stream.on('data', (chunk: string) => {
        response += chunk;
        if (response.length > 8192) {
          finish('InvalidResponse');
          stream.close();
        }
      });
      stream.on('error', () => finish('TransportError'));
      stream.on('end', () => {
        let reason: string | undefined;
        try {
          reason = JSON.parse(response).reason;
        } catch {
          /* Success has an empty body. */
        }
        finish(
          status === 0
            ? 'TransportClosed'
            : typeof reason === 'string' && /^[A-Za-z]+$/.test(reason)
              ? reason
              : undefined,
        );
      });
      stream.on('close', () => finish('TransportClosed'));
      stream.end(body);
    });
  }
  return {
    async sendPush(destination: PushDestination, entityId: string, payload: PushPayload): Promise<PushResult> {
      const body = JSON.stringify(payload);
      if (Buffer.byteLength(body) >= 4096) return { status: 0, reason: 'PayloadTooLarge', clearToken: false };
      const initialToken = jwt(destination.environment);
      if (!initialToken) return { status: 0, reason: 'EnvironmentDisabled', clearToken: false };
      let token: string = initialToken;
      let refreshed = false;
      let retries = 0;
      let transportRetried = false;
      for (;;) {
        const result = await request(destination, entityId, body, token).catch(() => {
          const origin = (options.origins ?? origins)[destination.environment];
          sessions.get(origin)?.destroy();
          sessions.delete(origin);
          return { status: 0, reason: 'TransportError', clearToken: false };
        });
        if (result.status === 0 && !transportRetried) {
          transportRetried = true;
          continue;
        }
        if (result.status === 200 || result.clearToken) return result;
        if (result.reason === 'BadEnvironmentKeyInToken') warn(destination.environment, result.reason);
        if (!refreshed && ['ExpiredProviderToken', 'InvalidProviderToken'].includes(result.reason ?? '')) {
          refreshed = true;
          const replacement = jwt(destination.environment, token)!;
          if (replacement !== token) {
            token = replacement;
            continue;
          }
        }
        if ([429, 500, 503].includes(result.status) && retries < 2) {
          await sleep(250 * 2 ** retries++);
          continue;
        }
        return result;
      }
    },
    close() {
      for (const connection of sessions.values()) connection.destroy();
      sessions.clear();
    },
  };
}
let client: ReturnType<typeof createApnsClient> | undefined;
export function sendPush(destination: PushDestination, entityId: string, payload: PushPayload): Promise<PushResult> {
  client ??= createApnsClient({ config: readAppConfig().apns });
  return client.sendPush(destination, entityId, payload);
}
