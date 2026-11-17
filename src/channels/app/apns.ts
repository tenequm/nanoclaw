import type { PushPayload } from './contract.js';
export interface PushDestination {
  token: string;
  environment: 'sandbox' | 'production';
}
/** N4 implements the APNs transport with per-environment provider tokens. */
export async function sendPush(_destination: PushDestination, _entityId: string, _payload: PushPayload): Promise<void> {
  throw new Error('not_implemented');
}
