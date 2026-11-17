import { test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
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
import type {
  Conversation,
  PushPayload,
  SigningFields,
  AppEvent,
  Badge,
  Status,
  ConversationsResponse,
  ReadResponse,
  CallCancelRequest,
  ErrorBody,
  Message,
  VoiceView,
  SavedVoiceSelection,
} from './contract.js';
const fixturePath = process.env.APP_CONTRACT_FIXTURES ?? new URL('./app-contract.fixtures.json', import.meta.url);
const f = JSON.parse(readFileSync(fixturePath, 'utf8'));
function check(ok: unknown, label: string): asserts ok {
  assert.ok(ok, label);
}

test('signing vectors and replay keyed by device and nonce', () => {
  const seen = new Set<string>();
  for (const v of f.signing.vectors) {
    check(canonicalSigningText({ ...v, bodyHash: bodySHA256(v.body) }) === v.canonical, 'canonical bytes');
    const auth = parseAuthorization(v.authorization);
    check(auth, 'header parses');
    check(verifyRequestSignature(v, v.signature, f.testKey.publicKeySpki) === v.signatureValid, 'signature verdict');
    check(auth.signature === v.signature && auth.nonce === v.nonce && auth.protocol === v.protocol, 'header fields');
    if (v.name === 'post-json' || v.name === 'replay-malleated-signature') {
      const key = JSON.stringify([auth.deviceId, auth.nonce]);
      check(seen.has(key) === (v.name === 'replay-malleated-signature'), 'nonce replay');
      seen.add(key);
    }
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
test('pair proof and tampered proof', () => {
  const p = f.pairRequest;
  check(pairProofText(p.code, p.publicKey) === f.pairProofText, 'pair bytes');
  for (const [value, expected] of [
    [p, true],
    [f.pairProofTampered, false],
  ] as const) {
    const key = createPublicKey({ key: Buffer.from(value.publicKey, 'base64url'), type: 'spki', format: 'der' });
    check(
      verify(
        'sha256',
        Buffer.from(pairProofText(value.code, value.publicKey)),
        key,
        Buffer.from(value.proof, 'base64url'),
      ) === expected,
      'pair verdict',
    );
  }
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
test('SSE formatting reproduces the complete raw stream including comments', () => {
  let output = '';
  for (const block of f.stream.raw.split('\n\n').filter(Boolean)) {
    if (block.startsWith(': ')) {
      output += formatEvent({ comment: block.slice(2) });
      continue;
    }
    const lines: string[] = block.split('\n');
    const kind = lines.find((l) => l.startsWith('event: '))!.slice(7);
    const id = lines.find((l) => l.startsWith('id: '))?.slice(4);
    const data = JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6));
    output += formatEvent({ kind, data, ...(id === undefined ? {} : { id: Number(id) }) });
  }
  check(output === f.stream.raw, 'SSE bytes');
  assert.throws(() => formatEvent({ kind: 'status\nevent: message', data: {} }));
  assert.throws(() => formatEvent({ kind: 'message', id: 2, data: { seq: 1 } } as AppEvent));
});
test('CryptoKit DER signature verifies with Node', () => {
  const signed: SigningFields & { signature: string; authorization: string } = JSON.parse(
    readFileSync(new URL('./app-swift-signature.fixtures.json', import.meta.url), 'utf8'),
  );
  check(verifyRequestSignature(signed, signed.signature, f.testKey.publicKeySpki), 'Swift signature');
  check(parseAuthorization(signed.authorization)?.signature === signed.signature, 'Swift header');
});

test('revised entities, cancellation and conflict errors retain their fields', () => {
  const list: ConversationsResponse = f.conversations;
  const read: ReadResponse = f.readResponse;
  const status: Status = f.statuses.idle;
  const badge: Badge = list.badge;
  check(Number.isSafeInteger(status.rev) && Number.isSafeInteger(badge.rev), 'entity revisions');
  check(read.badge.kind === 'badge', 'read badge');
  const cancel: CallCancelRequest = f.callCancelRequest;
  check(cancel.reason === 'hangup', 'cancel request');
  const bodies = [...Object.values(f.errors), ...Object.values(f.callErrors)] as { body: ErrorBody }[];
  for (const code of ['upload_key_conflict', 'attempt_conflict']) {
    check(
      bodies.some(({ body }) => body.error === code),
      'conflict code',
    );
  }
  const send: Message[] = [f.messages.userUnknown, f.messages.userFailed];
  for (const delivery of ['unknown', 'failed']) {
    check(
      send.some((m) => m.delivery === delivery && m.deliveryError !== null),
      'terminal delivery',
    );
  }
  assert.throws(() => formatEvent({ kind: 'badge', data: badge, id: 1 }));
});
test('voice fixture supports unresolved names and nullable saved choices', () => {
  const path = process.env.VOICE_TTS_FIXTURES ?? new URL('../voice-mode-tts.fixtures.json', import.meta.url);
  const voice = JSON.parse(readFileSync(path, 'utf8'));
  const saved: SavedVoiceSelection = { provider: null, model: null, voice: null };
  for (const name of ['ttsView', 'ttsViewNew']) {
    const view: VoiceView = voice[name];
    check(
      view.providers.some((p) => p.defaultDetails?.voiceName === null),
      'nullable voice name',
    );
    const defaults: VoiceView = { ...view, saved };
    check(defaults.saved.provider === null && defaults.effective.provider !== null, 'saved defaults');
  }
});

test('conversation list and call-refused example remain separate', () => {
  const list: ConversationsResponse = f.conversations;
  const refused: Conversation = f.conversationCallRefused;
  assert.deepEqual(
    list.conversations.map((conversation) => conversation.id),
    ['conv_taylor01'],
  );
  check(Number.isSafeInteger(list.seq), 'initial stream cursor');
  check(
    list.conversations.every((conversation) => conversation.seq <= list.seq),
    'snapshot cursor covers list',
  );
  check(refused.id === 'conv_sam01' && !refused.canCall, 'separate refused conversation');
  check(refused.callRefusal?.error === 'no_line', 'call refusal reason');
});

test('push payload identifies its paired host', () => {
  const payload: PushPayload = f.pushPayload.body;
  check(payload.hd.h === 'https://app.example.com', 'push host public base');
  check(payload.hd.c === f.conversations.conversations[0].id, 'push conversation');
});

test('pair proof and answer delivery errors decode with their HTTP status', () => {
  for (const [name, status, code] of [
    ['badProof', 400, 'bad_proof'],
    ['answerNotDelivered', 502, 'answer_not_delivered'],
  ] as const) {
    const response: { status: number; body: ErrorBody } = f.errors[name];
    check(response.status === status, 'HTTP status');
    check(response.body.error === code, 'error code');
    check(typeof response.body.message === 'string' && response.body.message.length > 0, 'error message');
  }
});
