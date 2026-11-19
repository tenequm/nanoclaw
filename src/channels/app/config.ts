import { readFileSync } from 'node:fs';
import { createPrivateKey, hkdfSync } from 'node:crypto';
import { transcriptionKey } from '../../transcription.js';
import { envValue } from '../../env.js';
import { parseEncryptionKey } from '../../secret-seal.js';

export function readAppConfig(
  read: (key: string) => string | undefined = (key) => (key === 'OPENAI_API_KEY' ? transcriptionKey() : envValue(key)),
) {
  const key = parseEncryptionKey(read('NANOCLAW_ENCRYPTION_KEY'));
  const apnsKey = (environment: 'SANDBOX' | 'PRODUCTION') => {
    const keyId = read(`APP_APNS_${environment}_KEY_ID`);
    const keyPath = read(`APP_APNS_${environment}_KEY_PATH`);
    return keyId && keyPath ? { keyId, keyPath } : null;
  };
  return {
    transcriptionConfigured: Boolean(read('OPENAI_API_KEY')),
    publicBase: read('APP_PUBLIC_BASE')?.replace(/\/+$/, '') || null,
    livekitUrl: read('APP_LIVEKIT_URL') || null,
    ticketKey: key ? Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'heydan-app-ticket-v1', 32)) : null,
    apns: {
      teamId: read('APP_APNS_TEAM_ID') || null,
      topic: read('APP_APNS_TOPIC') || null,
      sandbox: apnsKey('SANDBOX'),
      production: apnsKey('PRODUCTION'),
    },
  };
}
export type AppConfig = ReturnType<typeof readAppConfig>;
export function configuredFeatures(config: AppConfig): string[] {
  const pushReady =
    config.publicBase &&
    config.apns.teamId &&
    config.apns.topic &&
    [config.apns.sandbox, config.apns.production].some((key) => {
      if (!key) return false;
      try {
        return createPrivateKey(readFileSync(key.keyPath)).asymmetricKeyDetails?.namedCurve === 'prime256v1';
      } catch {
        return false;
      }
    });
  return [
    'agents',
    'unread',
    'agent-status',
    'agent-settings',
    ...(config.ticketKey ? ['files'] : []),
    ...(config.livekitUrl ? ['calls'] : []),
    ...(pushReady ? ['push'] : []),
    ...(config.livekitUrl ? ['voice-picker'] : []),
    ...(config.ticketKey && config.transcriptionConfigured ? ['voice-messages'] : []),
  ];
}

// Unsigned routes reach this, so re-read `.env` and the key files at most once a minute.
const CONFIG_REFRESH_MS = 60_000;
let cache: { config: AppConfig; features: string[]; checkedAt: number } | undefined;
function current() {
  const now = performance.now();
  if (!cache || now - cache.checkedAt >= CONFIG_REFRESH_MS) {
    const config = readAppConfig();
    cache = { config, features: configuredFeatures(config), checkedAt: now };
  }
  return cache;
}
export const appConfig = (): AppConfig => current().config;
export const appFeatures = (): string[] => current().features;
/** Test seam: drop the cached configuration after changing the environment. */
export function resetAppConfigCache(): void {
  cache = undefined;
}
