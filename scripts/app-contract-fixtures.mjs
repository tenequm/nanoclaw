// Source: infra/docs/plans/2611-17-hey-dan-app-chat-lanes/gen-fixtures.mjs
// Generates app-contract.fixtures.json for contract.md (protocol 1). Run: node gen-fixtures.mjs <out.json>
import crypto from 'node:crypto';
import fs from 'node:fs';

const out = process.argv[2];
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nonce = (seed) => b64u(crypto.createHash('sha256').update(`nonce:${seed}`).digest().subarray(0, 16));

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const testKey = {
  note: 'A throwaway P-256 key for contract tests only. It protects nothing.',
  privateKeyPkcs8Pem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  publicKeySpki: b64u(publicKey.export({ type: 'spki', format: 'der' })),
};
const P = 1;
const deviceId = 'dev_8Qm3kT1xV2aZ';
const T = 1794943562; // 2026-11-17T19:26:02Z, seconds
const AT = T * 1000;
const sign = (text) => crypto.sign('sha256', Buffer.from(text, 'utf8'), privateKey);

// Eight lines joined by LF, no trailing newline.
const canonical = (v) => ['HEYDAN-SIG-V1', String(v.protocol), v.method, v.target, String(v.ts), v.nonce, v.bodyHash, v.deviceId].join('\n');
const authHeader = (v) => `HeyDan-Sig v=1,p=${v.protocol},d=${v.deviceId},t=${v.ts},n=${v.nonce},bh=${v.bodyHash},s=${v.signature}`;

const vector = (name, method, target, body = '') => {
  const v = { name, protocol: P, method, target, body, ts: T, nonce: nonce(name), deviceId, bodyHash: sha256hex(Buffer.from(body, 'utf8')) };
  v.canonical = canonical(v);
  v.signature = b64u(sign(v.canonical));
  v.authorization = authHeader(v);
  v.signatureValid = true;
  return v;
};

const sendBody = JSON.stringify({ clientId: '0b9f6a52-3c1e-4d7a-9a57-2f1d6c0e8b11', text: 'reply please', fileIds: [] });
const vectors = [
  vector('get-no-body', 'GET', '/app/conversations'),
  vector('get-with-query', 'GET', '/app/conversations/conv_stan01/messages?before=2120&limit=50'),
  vector('get-encoded-query', 'GET', '/app/conversations/conv_stan01/voices?provider=gemini&q=%D0%BA%D1%96%D1%82%20cat&limit=20'),
  vector('post-json', 'POST', '/app/conversations/conv_stan01/messages', sendBody),
  vector('events-connect', 'GET', '/app/events?after=118'),
  vector('delete-device', 'DELETE', '/app/devices/me'),
];
const good = vectors[3];
// A tampered vector keeps the good signature and changes one signed input, so verification must fail.
const tampered = (name, change, why) => {
  const v = { ...good, ...change, name, signatureValid: false, why };
  v.bodyHash = sha256hex(Buffer.from(v.body, 'utf8'));
  v.canonical = canonical(v);
  v.authorization = authHeader(v);
  return v;
};
vectors.push(
  tampered('bad-changed-body', { body: sendBody.replace('reply please', 'reply now') }, 'the body no longer matches the signed hash'),
  tampered('bad-changed-target', { target: '/app/conversations/conv_dan01/messages' }, 'another path'),
  tampered('bad-changed-method', { method: 'PUT' }, 'another method'),
  tampered('bad-other-device', { deviceId: 'dev_someoneElse' }, 'another device id'),
  tampered('bad-changed-nonce', { nonce: nonce('other') }, 'another nonce'),
  tampered('bad-changed-protocol', { protocol: 2 }, 'another protocol'),
);
// The same request with s replaced by n - s: the signature still verifies, so replay protection must key on
// (deviceId, nonce), never on the signature bytes.
{
  const der = Buffer.from(good.signature, 'base64url');
  const { r, s } = parseDer(der);
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const s2 = n - BigInt('0x' + s.toString('hex'));
  const malleated = encodeDer(r, Buffer.from(s2.toString(16).padStart(64, '0'), 'hex'));
  const v = { ...good, name: 'replay-malleated-signature', signature: b64u(malleated), signatureValid: true,
    why: 'verifies, but has the same (deviceId, nonce) as post-json: the second one seen is refused as replayed' };
  v.authorization = authHeader(v);
  vectors.push(v);
}

function parseDer(der) {
  let i = 2;
  const rl = der[i + 1]; const r = der.subarray(i + 2, i + 2 + rl); i = i + 2 + rl;
  const sl = der[i + 1]; const s = der.subarray(i + 2, i + 2 + sl);
  const trim = (b) => (b[0] === 0 ? b.subarray(1) : b);
  return { r: trim(r), s: trim(s) };
}
function encodeDer(r, s) {
  const int = (b) => { let x = b; while (x.length > 1 && x[0] === 0 && !(x[1] & 0x80)) x = x.subarray(1); if (x[0] & 0x80) x = Buffer.concat([Buffer.from([0]), x]); return Buffer.concat([Buffer.from([0x02, x.length]), x]); };
  const body = Buffer.concat([int(r), int(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

const pairCode = 'k3Jx9QpL2mVb7RtY5wZc8NdF4hG6sA1e';
const pairText = (code, key) => ['HEYDAN-PAIR-V1', code, key].join('\n');
const pairProof = b64u(sign(pairText(pairCode, testKey.publicKeySpki)));

const ticketSecret = 'contract-test-ticket-secret';
const fileBytes = Buffer.from('hello from the contract fixtures\n', 'utf8');
const mintTicket = (claims) => {
  const c = b64u(JSON.stringify(claims));
  return `${c}.${b64u(crypto.createHmac('sha256', ticketSecret).update(c).digest())}`;
};
const ticketClaims = { v: 1, purpose: 'upload', fileId: 'file_7hT2pQ9a', deviceId, userId: 'telegram:1000001',
  size: fileBytes.length, sha256: sha256hex(fileBytes), exp: AT + 3600_000 };
const ticket = mintTicket(ticketClaims);
const expiredTicket = mintTicket({ ...ticketClaims, exp: AT - 1000 });

const agent = { id: 'ag_stan', name: 'Stan' };

// ---- One coherent event log for conv_stan01 (seq 119-131), what GET /app/events?after=118 replays. ----
const L = (seq, ms) => ({ seq, at: AT + ms });
const m = (over) => ({ kind: 'message', conversationId: 'conv_stan01', files: [], reactions: [], voice: null, replyTo: null,
  clientId: null, delivery: null, deliveryError: null, editedAt: null, ...over });
const send119 = m({ id: 'msg_0119', order: 119, seq: 119, role: 'user', text: 'reply please', clientId: '0b9f6a52-3c1e-4d7a-9a57-2f1d6c0e8b11', delivery: 'stored', createdAt: AT });
const send119Routed = { ...send119, seq: 120, delivery: 'routed' };
const send119Reached = { ...send119, seq: 121, delivery: 'reached' };
const reply122 = m({ id: 'msg_0122', order: 122, seq: 122, role: 'agent', text: 'Working on it.', createdAt: AT + 6_000 });
const q123 = { kind: 'question', id: 'q_0123', conversationId: 'conv_stan01', order: 123, seq: 123, title: 'Deploy', text: 'Deploy to which environment?',
  options: [
    { label: 'Staging', selectedLabel: 'Staging', value: 'staging', style: 'primary' },
    { label: 'Production', selectedLabel: 'Production', value: 'production', style: 'danger' },
    { label: 'Cancel', selectedLabel: 'Cancelled', value: 'cancel', style: null },
  ], state: 'open', answer: null, createdAt: AT + 12_000, expiresAt: AT + 312_000 };
// seq 124 belongs to a conversation this device may not see (Dan): the stream skips it.
const q123Answered = { ...q123, seq: 125, state: 'answered', answer: { value: 'staging', label: 'Staging', at: AT + 25_000 } };
const draft126 = m({ id: 'msg_0126', order: 126, seq: 126, role: 'agent', text: 'First draft.', createdAt: AT + 30_000 });
const draft126Edited = { ...draft126, seq: 127, text: 'Second draft.', editedAt: AT + 31_000 };
const draft126Reacted = { ...draft126Edited, seq: 128, reactions: [{ emoji: '\u{1F44D}', by: 'agent' }] };
const conv129 = { kind: 'conversation', id: 'conv_stan01', seq: 129, agent,
  lastMessage: { id: 'msg_0126', role: 'agent', preview: 'Second draft.', at: AT + 31_000 },
  unread: 3, readOrder: 118, canCall: true, callRefusal: null, createdAt: AT - 86_400_000 };
const live130 = m({ id: 'msg_0130', order: 130, seq: 130, role: 'narrator', voice: 'whispered', mood: 'calm', text: 'A role and fields from a later server.', createdAt: AT + 40_000 });
const statusWorking = { kind: 'status', conversationId: 'conv_stan01', rev: 41, state: 'working', label: 'Running a command', at: AT + 33_000 };
const statusIdle = { kind: 'status', conversationId: 'conv_stan01', rev: 42, state: 'idle', label: null, at: AT + 45_000 };
const badge = (rev, unreadTotal) => ({ kind: 'badge', rev, unreadTotal });

const sse = (event, data, id) => `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const replay = [send119, send119Routed, send119Reached, reply122, q123, q123Answered, draft126, draft126Edited, draft126Reacted, conv129];
const stream = {
  note: 'Raw bytes of one connection opened with after=118 while the log ends at 129. Lines end in LF; an empty line ends an event; a line starting with a colon is a comment. seq 124 is filtered out (another agent).',
  request: 'GET /app/events?after=118',
  raw:
    replay.map((e) => sse(e.kind, e, e.seq)).join('') +
    sse('status', statusWorking) +
    sse('badge', badge(7, 3)) +
    sse('synchronized', { seq: 129 }) +
    ': ping\n\n' +
    sse('message', live130, 130) +
    sse('weather', { kind: 'weather', note: 'an event kind from a later server' }, 131) +
    sse('status', statusIdle) +
    sse('badge', badge(8, 4)) +
    ': ping\n\n',
  expect: {
    kindsInOrder: ['message', 'message', 'message', 'message', 'question', 'question', 'message', 'message', 'message', 'conversation', 'status', 'badge', 'synchronized', 'message', 'weather', 'status', 'badge'],
    cursorAtSynchronized: 129,
    cursorAfter: 131,
    ignoredKinds: ['weather'],
    finalEntities: {
      msg_0119: { seq: 121, delivery: 'reached' },
      q_0123: { seq: 125, state: 'answered' },
      msg_0126: { seq: 128, text: 'Second draft.', reactions: 1 },
    },
    finalThreadOrder: ['msg_0119', 'msg_0122', 'q_0123', 'msg_0126', 'msg_0130'],
    renderedThreadOrder: ['msg_0119', 'msg_0122', 'q_0123', 'msg_0126'],
    finalStatus: { rev: 42, state: 'idle' },
    finalBadge: { rev: 8, unreadTotal: 4 },
  },
};

// ---- Standalone examples (seq and order 2000+, not part of the log above). ----
const ex = (over) => m({ seq: 2000, order: 2000, createdAt: AT + 100_000, ...over });
const agentMarkdown = ex({ id: 'msg_2101', order: 2101, seq: 2101, role: 'agent',
  text: '## Result\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```sh\necho "$HOME"\n```' });
const fileRefImage = { id: 'file_img01', name: 'chart.png', mimeType: 'image/png', size: 48211, kind: 'image', width: 1200, height: 800 };
const fileRefDoc = { id: 'file_doc01', name: 'report.pdf', mimeType: 'application/pdf', size: 301442, kind: 'file', width: null, height: null };
const agentWithFiles = ex({ id: 'msg_2102', order: 2102, seq: 2102, role: 'agent', text: 'Done. The report is attached.', files: [fileRefImage, fileRefDoc] });
const userWithFile = ex({ id: 'msg_2103', order: 2103, seq: 2104, role: 'user', text: 'Here is the log.', clientId: '5d2c8e0a-61b4-4f0e-8c43-1f7a9e2b6d30',
  delivery: 'reached', files: [{ id: 'file_7hT2pQ9a', name: 'notes.txt', mimeType: 'text/plain', size: fileBytes.length, kind: 'file', width: null, height: null }] });
const userUnknown = ex({ id: 'msg_2105', order: 2105, seq: 2106, role: 'user', text: 'are you there?', clientId: '9a1f3c7e-2b4d-4e8a-b6c0-7d5e1f9a3b2c',
  delivery: 'unknown', deliveryError: { error: 'outcome_unknown', message: 'The host restarted while sending this, so it may or may not have reached the agent. Check before you send it again.' } });
const userFailed = ex({ id: 'msg_2113', order: 2113, seq: 2114, role: 'user', text: 'hello?', clientId: '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7',
  delivery: 'failed', deliveryError: { error: 'not_routed', message: 'This message did not reach the agent. You can send it again.' } });
const voiceCaller = ex({ id: 'msg_2107', order: 2107, seq: 2107, role: 'user', text: 'What is two plus two?', voice: 'caller' });
const voiceSpoken = ex({ id: 'msg_2108', order: 2108, seq: 2108, role: 'agent', text: 'Four.', voice: 'spoken' });
const hostLine = ex({ id: 'msg_2109', order: 2109, seq: 2109, role: 'host', text: 'Context cleared.' });
const questionExpired = { ...q123, id: 'q_2110', order: 2110, seq: 2111, expiresAt: AT + 100_000, state: 'expired' };
const questionNoDeadline = { ...q123, id: 'q_2112', order: 2112, seq: 2112, expiresAt: null };
const statusWaiting = { kind: 'status', conversationId: 'conv_stan01', rev: 40, state: 'waiting', label: 'Waiting for your answer', at: AT + 12_000 };
const convDan = { ...conv129, id: 'conv_dan01', seq: 2120, agent: { id: 'ag_dan', name: 'Dan' }, lastMessage: null, unread: 0, readOrder: 0,
  canCall: false, callRefusal: { error: 'no_line', message: 'Calls are not set up for this agent.' } };

const errors = {
  protocol: { status: 426, body: { error: 'protocol', protocol: 1, message: 'Update Hey Dan to keep chatting.' } },
  badSignature: { status: 401, body: { error: 'bad_signature', message: 'The request signature is not valid.' } },
  unknownDevice: { status: 401, body: { error: 'unknown_device', message: 'This device is not paired.' } },
  deviceRevoked: { status: 401, body: { error: 'device_revoked', message: 'This device was unpaired.' } },
  staleTimestamp: { status: 401, body: { error: 'stale_timestamp', message: 'The request is too old or too new.', serverTime: AT } },
  replayed: { status: 401, body: { error: 'replayed', message: 'This request was already used.' } },
  badBody: { status: 400, body: { error: 'bad_body', message: 'The request body does not match its signature.' } },
  badRequest: { status: 400, body: { error: 'bad_request', message: 'The request is malformed.' } },
  forbidden: { status: 403, body: { error: 'forbidden', message: 'This device cannot reach that agent.' } },
  invalidCode: { status: 403, body: { error: 'invalid_code', message: 'This pairing link is used or expired. Send /pair again.' } },
  notFound: { status: 404, body: { error: 'not_found', message: 'Not found.' } },
  useCallScreen: { status: 409, body: { error: 'use_call_screen', message: 'Start a call with the call button.' } },
  usePairingScreen: { status: 409, body: { error: 'use_pairing_screen', message: 'Add agents from Telegram with /pair.' } },
  clientIdConflict: { status: 409, body: { error: 'client_id_conflict', message: 'This message was already sent with different content.' } },
  badFile: { status: 400, body: { error: 'bad_file', message: 'An attachment is missing or was already sent.', fileId: 'file_7hT2pQ9a' } },
  tooLarge: { status: 413, body: { error: 'too_large', message: 'A file can be at most 25 MB.', maxBytes: 26214400 } },
  lengthRequired: { status: 411, body: { error: 'length_required', message: 'The upload needs a Content-Length.' } },
  ticketExpired: { status: 401, body: { error: 'ticket_expired', message: 'The upload link expired.' } },
  uploadKeyConflict: { status: 409, body: { error: 'upload_key_conflict', message: 'This upload key was already used for another file.' } },
  attemptConflict: { status: 409, body: { error: 'attempt_conflict', message: 'This call attempt was already used for another conversation.' } },
  uploadConflict: { status: 409, body: { error: 'conflict', message: 'Different bytes were already uploaded for this file.' } },
  rateLimited: { status: 429, headers: { 'Retry-After': '30' }, body: { error: 'rate_limited', message: 'Too many requests. Try again shortly.', retryAfter: 30 } },
  futureError: { status: 418, body: { error: 'teapot_from_a_later_server', message: 'Shown as written.', extra: { any: 'thing' } } },
};

const fixtures = {
  about: 'Hey Dan app contract v1 fixtures, generated by gen-fixtures.mjs. Server tests produce these shapes; HeyDanCore tests decode them. See contract.md. "stream" is one coherent log; everything with seq 2000+ is a standalone example.',
  protocol: P,
  testKey,
  signing: { windowSeconds: 120, scheme: 'HeyDan-Sig', vectors },
  hello: { protocol: 1, minProtocol: 1, voiceProtocol: 6, features: ['files', 'calls', 'push', 'voice-picker'], serverTime: AT },
  pairLink: { link: `https://app.opx.one/app/pair#${pairCode}`, host: 'https://app.opx.one', code: pairCode,
    localLink: `http://127.0.0.1:4101/app/pair#${pairCode}`, localHost: 'http://127.0.0.1:4101' },
  pairRequest: { code: pairCode, publicKey: testKey.publicKeySpki, deviceName: 'iPhone', proof: pairProof,
    app: { version: '0.6.0', build: '2611171926', os: 'iOS 27.2' } },
  pairProofText: pairText(pairCode, testKey.publicKeySpki),
  pairProofTampered: { code: 'X' + pairCode.slice(1), publicKey: testKey.publicKeySpki, proof: pairProof, valid: false, why: 'the proof was made for another code' },
  pairResponse: { deviceId, userName: 'Misha', agents: [agent], protocol: 1, serverTime: AT },
  errors,
  conversations: { conversations: [conv129, convDan], statuses: [statusWorking], badge: badge(7, 3), seq: 129 },
  historyPage: { items: [send119Reached, reply122, q123Answered, draft126Reacted, live130], hasMoreBefore: true, hasMoreAfter: false },
  messages: { agentMarkdown, agentWithFiles, userWithFile, userUnknown, userFailed, voiceCaller, voiceSpoken, host: hostLine, future: live130,
    send: { stored: send119, routed: send119Routed, reached: send119Reached },
    editSequence: [draft126, draft126Edited, draft126Reacted] },
  questions: { open: q123, answered: q123Answered, expired: questionExpired, noDeadline: questionNoDeadline },
  statuses: { working: statusWorking, waiting: statusWaiting, idle: statusIdle },
  stream,
  sendRequest: JSON.parse(sendBody),
  sendResponse: { message: send119 },
  readRequest: { order: 126 },
  readResponse: { conversation: { ...conv129, seq: 2130, unread: 0, readOrder: 126 }, badge: badge(9, 0) },
  answerRequest: { value: 'staging' },
  answerResponse: { question: q123Answered },
  answerConflict: { status: 409, body: { error: 'not_open', message: 'This question was already answered.', question: q123Answered } },
  fileInitRequest: { uploadKey: 'c7d1e2f3-4a5b-4c6d-8e7f-90a1b2c3d4e5', name: 'notes.txt', mimeType: 'text/plain', size: fileBytes.length, sha256: sha256hex(fileBytes) },
  fileInitResponse: { fileId: 'file_7hT2pQ9a', ticket, expiresAt: AT + 3600_000, uploadPath: '/app/files/file_7hT2pQ9a', uploaded: false },
  fileTicketRenewResponse: { fileId: 'file_7hT2pQ9a', ticket, expiresAt: AT + 3600_000, uploadPath: '/app/files/file_7hT2pQ9a', uploaded: false },
  fileUpload: { method: 'PUT', target: '/app/files/file_7hT2pQ9a', authorization: `HeyDan-Ticket ${ticket}`,
    bodyUtf8: fileBytes.toString('utf8'), successStatus: 204, ticketClaims, ticketSecretForTests: ticketSecret,
    expiredAuthorization: `HeyDan-Ticket ${expiredTicket}` },
  callRequest: { conversationId: 'conv_stan01', attemptId: 'f3e2d1c0-b9a8-4776-8554-433221100fed', voiceProtocol: 6, jev: null },
  callGrant: { protocol: 6, url: 'wss://lk.opx.one', token: 'eyJ.fixture.token', callId: 'call_5tGh2', attemptId: 'f3e2d1c0-b9a8-4776-8554-433221100fed',
    agent: 'Stan', chat: 'Stan (app)', silenceMs: 1400, limit: { ms: 3600000, kind: 'duration' } },
  callErrors: {
    protocol: { status: 426, body: { error: 'protocol', protocol: 6, message: 'The voice service is updating. Update Hey Dan to make calls.' } },
    noLine: { status: 403, body: { error: 'no_line', message: 'Calls are not set up for this agent.' } },
    noChat: { status: 409, body: { error: 'no_chat', message: 'This agent has no conversation to call in.' } },
    limit: { status: 429, headers: { 'Retry-After': '600' }, body: { error: 'limit', message: 'The call limit is reached.', retryAfter: 600 } },
    room: { status: 502, body: { error: 'room', message: 'Could not open the call room.' } },
    stopped: { status: 409, body: { error: 'stopped', message: 'This call attempt is no longer active.' } },
    voiceOffline: { status: 503, body: { error: 'voice_offline', message: 'Calls are offline right now.' } },
    providerUnavailable: { status: 503, body: { error: 'provider_unavailable', message: 'That voice provider is not set up.', provider: 'elevenlabs' } },
  },
  callEndRequest: { reason: 'hangup' },
  callCancelRequest: { reason: 'hangup' },
  pushTokenRequest: { token: '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0', environment: 'sandbox' },
  pushPayload: {
    headers: { 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-topic': 'com.tenequm.HeyDan', 'apns-collapse-id': 'msg_2102' },
    body: {
      aps: { alert: { title: 'Stan', body: 'Done. The report is attached.' }, 'thread-id': 'conv_stan01', 'mutable-content': 1, badge: 3, sound: 'default', category: 'message' },
      hd: { v: 1, c: 'conv_stan01', m: 'msg_2102', k: 'message', a: agent },
    },
  },
};
fs.writeFileSync(out, JSON.stringify(fixtures, null, 2) + '\n');

// Self-checks: vectors verify as marked, the pair proofs, the ticket, unique seqs in the log.
for (const v of vectors) {
  const text = canonical({ ...v, bodyHash: sha256hex(Buffer.from(v.body, 'utf8')) });
  if (text !== v.canonical) throw new Error(`vector ${v.name}: canonical text drifted`);
  const ok = crypto.verify('sha256', Buffer.from(text, 'utf8'), publicKey, Buffer.from(v.signature, 'base64url'));
  if (ok !== v.signatureValid) throw new Error(`vector ${v.name}: expected ${v.signatureValid}, got ${ok}`);
}
const pk = crypto.createPublicKey({ key: Buffer.from(testKey.publicKeySpki, 'base64url'), format: 'der', type: 'spki' });
if (!crypto.verify('sha256', Buffer.from(fixtures.pairProofText), pk, Buffer.from(pairProof, 'base64url'))) throw new Error('pair proof');
if (crypto.verify('sha256', Buffer.from(pairText(fixtures.pairProofTampered.code, testKey.publicKeySpki)), pk, Buffer.from(pairProof, 'base64url'))) throw new Error('tampered pair proof verified');
const seqs = replay.map((e) => e.seq);
if (new Set(seqs).size !== seqs.length) throw new Error('duplicate seq in the log');
console.log('vectors', vectors.length, 'ok; bytes', fs.statSync(out).size);
