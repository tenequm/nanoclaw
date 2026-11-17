import { readFileSync } from 'node:fs';
import { createPrivateKey, hkdfSync } from 'node:crypto';
import { envValue } from '../../env.js';
import { parseEncryptionKey } from '../../secret-seal.js';

export function readAppConfig(read: (key: string) => string | undefined = envValue) {
  const key = parseEncryptionKey(read('NANOCLAW_ENCRYPTION_KEY'));
  const apnsKey = (environment: 'SANDBOX' | 'PRODUCTION') => {
    const keyId = read(`APP_APNS_${environment}_KEY_ID`);
    const keyPath = read(`APP_APNS_${environment}_KEY_PATH`);
    return keyId && keyPath ? { keyId, keyPath } : null;
  };
  return {
    publicBase: read('APP_PUBLIC_BASE') || null,
    livekitUrl: read('APP_LIVEKIT_URL') || null,
    ticketKey: key ? Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'heydan-app-ticket-v1', 32)) : null,
    apns: {
      teamId: read('APP_APNS_TEAM_ID') || null,
      topic: read('APP_APNS_TOPIC') || 'com.tenequm.HeyDan',
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
    [config.apns.sandbox, config.apns.production].some((key) => {
      if (!key) return false;
      try {
        return createPrivateKey(readFileSync(key.keyPath)).asymmetricKeyDetails?.namedCurve === 'prime256v1';
      } catch {
        return false;
      }
    });
  return [
    ...(config.ticketKey ? ['files'] : []),
    ...(config.livekitUrl ? ['calls', 'voice-picker'] : []),
    ...(pushReady ? ['push'] : []),
  ];
}
