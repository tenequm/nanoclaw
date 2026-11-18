import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import {
  canonicalSigningText,
  parseAuthorization,
  verifyRequestSignature,
  pairProofText,
  mintTicket,
  readTicket,
  formatEvent,
  bodySHA256,
} from './contract.js';
import type { AppEvent, SigningFields } from './contract.js';
const f = JSON.parse(readFileSync(new URL('./app-contract.fixtures.json', import.meta.url), 'utf8'));
function check(ok: unknown, label: string): asserts ok {
  assert.ok(ok, label);
}

test('signing vectors and the authorization header', () => {
  for (const v of f.signing.vectors) {
    check(canonicalSigningText({ ...v, bodyHash: bodySHA256(v.body) }) === v.canonical, 'canonical bytes');
    const auth = parseAuthorization(v.authorization);
    check(auth, 'header parses');
    check(verifyRequestSignature(v, v.signature, f.testKey.publicKeySpki) === v.signatureValid, 'signature verdict');
    check(auth.signature === v.signature && auth.nonce === v.nonce && auth.protocol === v.protocol, 'header fields');
  }
});
test('authorization rejects malformed forms', () => {
  const good = f.signing.vectors[0].authorization;
  for (const h of [
    undefined,
    '',
    good + ',v=1',
    good + ',extra=1',
    good.replace('v=1,', 'v=2,'),
    good.replace('n=', 'n=='),
    good.replace('bh=', 'bh=G'),
    good + '\n',
    good.replace('p=1', 'p=01'),
  ]) {
    check(parseAuthorization(h) === null, 'malformed header rejected');
  }
  check(!verifyRequestSignature(f.signing.vectors[0], 'bad', 'bad'), 'invalid key rejected');
});
test('pair proof text', () => {
  const p = f.pairRequest;
  check(pairProofText(p.code, p.publicKey) === f.pairProofText, 'pair bytes');
});
test('tickets verify claims, expiry, MAC and round trip', () => {
  const { ticketClaims: claims, ticketSecretForTests: secret } = f.fileUpload;
  const ticket = f.fileInitResponse.ticket;
  const now = claims.exp - 1;
  check(JSON.stringify(readTicket(ticket, secret, now)) === JSON.stringify(claims), 'fixture claims');
  check(mintTicket(claims, secret) === ticket, 'fixture encoding');
  check(readTicket(ticket, secret, claims.exp) === null, 'expiry boundary');
  check(readTicket(ticket, 'wrong', now) === null, 'wrong key');
  check(readTicket(ticket + 'x', secret, now) === null, 'tampered mac');
  check(readTicket('x' + ticket, secret, now) === null, 'tampered payload');
  check(
    readTicket(f.fileUpload.expiredAuthorization.slice('HeyDan-Ticket '.length), secret, f.hello.serverTime) === null,
    'expired fixture',
  );
});
test('SSE formatting refuses injected kinds and misplaced ids', () => {
  assert.throws(() => formatEvent({ kind: 'status\nevent: message', data: {} }));
  assert.throws(() => formatEvent({ kind: 'message', id: 2, data: { seq: 1 } } as AppEvent));
  assert.throws(() => formatEvent({ kind: 'badge', data: f.conversations.badge, id: 1 }));
});
test('CryptoKit DER signature verifies with Node', () => {
  const signed: SigningFields & { signature: string; authorization: string } = JSON.parse(
    readFileSync(new URL('./app-swift-signature.fixtures.json', import.meta.url), 'utf8'),
  );
  check(verifyRequestSignature(signed, signed.signature, f.testKey.publicKeySpki), 'Swift signature');
  check(parseAuthorization(signed.authorization)?.signature === signed.signature, 'Swift header');
});
