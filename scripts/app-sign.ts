import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { bodySHA256, canonicalSigningText } from '../src/channels/app/contract.js';

export function signRequest(input: {
  privateKey: string;
  deviceId: string;
  method: string;
  target: string;
  body?: Uint8Array;
  protocol?: number;
  ts?: number;
  nonce?: string;
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
    nonce: input.nonce ?? randomBytes(16).toString('base64url'),
    bodyHash: bodySHA256(input.body ?? new Uint8Array()),
    deviceId: input.deviceId,
  };
  const signature = sign('sha256', Buffer.from(canonicalSigningText(fields)), key).toString('base64url');
  return `HeyDan-Sig v=1,p=${fields.protocol},d=${fields.deviceId},t=${fields.ts},n=${fields.nonce},bh=${fields.bodyHash},s=${signature}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      keygen: { type: 'boolean' },
      key: { type: 'string' },
      device: { type: 'string' },
      method: { type: 'string' },
      target: { type: 'string' },
      body: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: pnpm exec tsx scripts/app-sign.ts --keygen --key <pem>\n       pnpm exec tsx scripts/app-sign.ts --key <pem> --device <id> --method <method> --target <path?query> [--body <file>]',
    );
  } else if (values.keygen && values.key) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    writeFileSync(values.key, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    console.log(publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'));
  } else if (values.key && values.device && values.method && values.target) {
    console.log(
      signRequest({
        privateKey: readFileSync(values.key, 'utf8'),
        deviceId: values.device,
        method: values.method,
        target: values.target,
        body: values.body ? readFileSync(values.body) : undefined,
      }),
    );
  } else {
    throw new Error('Missing arguments; use --help');
  }
}
