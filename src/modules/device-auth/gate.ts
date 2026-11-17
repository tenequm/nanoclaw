import type { IncomingMessage } from 'node:http';
/** N1 extracts the trusted-proxy gate and client-address helpers from voice-mode. */
export function appPeerAllowed(_req: IncomingMessage): boolean {
  return false;
}
/** N1 resolves the rightmost untrusted forwarded hop. */
export function clientAddress(_req: IncomingMessage): string {
  throw new Error('not_implemented');
}
