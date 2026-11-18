import { expect, it } from 'vitest';
import { signRequest } from './app-sign.js';
import { parseAuthorization, verifyRequestSignature } from '../src/channels/app/contract.js';
import fixtures from '../src/channels/app/app-contract.fixtures.json' with { type: 'json' };

it('software helper signs the contract canonical bytes and generates fresh nonces', () => {
  for (const vector of fixtures.signing.vectors.filter((v) => v.signatureValid)) {
    const input = {
      privateKey: fixtures.testKey.privateKeyPkcs8Pem,
      deviceId: vector.deviceId,
      method: vector.method,
      target: vector.target,
      body: Buffer.from(vector.body),
      protocol: vector.protocol,
      ts: vector.ts,
    };
    const auth = parseAuthorization(signRequest(input))!;
    expect(
      verifyRequestSignature(
        { ...auth, method: input.method, target: input.target },
        auth.signature,
        fixtures.testKey.publicKeySpki,
      ),
    ).toBe(true);
    expect(parseAuthorization(signRequest(input))!.nonce).not.toBe(auth.nonce);
  }
});
