import type { IncomingMessage } from 'node:http';
export interface DeviceIdentity {
  deviceId: string;
  userId: string;
  agentIds: string[];
}
/** N1 verifies headers and consumes a durable nonce before reading the body. */
export async function verifyRequest(_req: IncomingMessage): Promise<DeviceIdentity> {
  throw new Error('not_implemented');
}
/** N1 streams and verifies the signed body hash. */
export async function readSignedBody(_req: IncomingMessage, _bodyHash: string, _maxBytes: number): Promise<Buffer> {
  throw new Error('not_implemented');
}
