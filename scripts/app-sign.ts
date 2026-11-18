import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { bodySHA256, canonicalSigningText } from '../src/channels/app/contract.js';

export function signRequest(input: {
  privateKey: string;
  deviceId: string;
  method: string;
  target: string;
  body?: Uint8Array;
  protocol?: number;
  ts?: number;
}): string {
  const key = createPrivateKey(input.privateKey);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('A P-256 private key is required');
  }
  const fields = {
    protocol: input.protocol ?? 1,
    method: input.method.toUpperCase(),
    target: input.target,
    ts: input.ts ?? Math.floor(Date.now() / 1000),
    nonce: randomBytes(16).toString('base64url'),
    bodyHash: bodySHA256(input.body ?? new Uint8Array()),
    deviceId: input.deviceId,
  };
  const signature = sign('sha256', Buffer.from(canonicalSigningText(fields)), key).toString('base64url');
  return `HeyDan-Sig v=1,p=${fields.protocol},d=${fields.deviceId},t=${fields.ts},n=${fields.nonce},bh=${fields.bodyHash},s=${signature}`;
}
