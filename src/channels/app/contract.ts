import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

export type Role = 'user' | 'agent' | 'host' | (string & {});
export type Voice = 'caller' | 'spoken' | (string & {});
export type Kind =
  | 'conversation'
  | 'message'
  | 'question'
  | 'status'
  | 'badge'
  | 'synchronized'
  | 'image'
  | 'file'
  | 'daily'
  | 'duration'
  | (string & {});
export type State = 'open' | 'answered' | 'expired' | 'idle' | 'working' | 'waiting' | (string & {});
export type Delivery = 'stored' | 'routed' | 'reached' | 'failed' | 'unknown' | (string & {});
export interface Agent {
  id: string;
  name: string;
}

export interface AppVersion {
  version: string;
  build: string;
  os: string;
}

export interface ErrorBody {
  error: string;
  message: string;
  protocol?: number | null;
  serverTime?: number | null;
  retryAfter?: number | null;
  fileId?: string | null;
  maxBytes?: number | null;
  question?: Question | null;
  provider?: string | null;
  field?: string | null;
}

export interface HelloResponse {
  protocol: number;
  minProtocol: number;
  voiceProtocol: number;
  features: string[];
  serverTime: number;
}

export interface PairRequest {
  code: string;
  publicKey: string;
  deviceName: string;
  proof: string;
  app: AppVersion;
}

export interface PairResponse {
  deviceId: string;
  userName: string;
  agents: Agent[];
  protocol: number;
  serverTime: number;
}

export interface LastMessage {
  id: string;
  role: Role;
  preview: string;
  at: number;
}

export interface Conversation {
  kind: Kind;
  id: string;
  seq: number;
  agent: Agent;
  lastMessage: LastMessage | null;
  unread: number;
  readOrder: number;
  canCall: boolean;
  callRefusal: ErrorBody | null;
  createdAt: number;
}

export interface FileAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: Kind;
  width: number | null;
  height: number | null;
}

export interface Reaction {
  emoji: string;
  by: Role;
}

export interface Message {
  kind: Kind;
  id: string;
  conversationId: string;
  order: number;
  seq: number;
  role: Role;
  text: string;
  files: FileAttachment[];
  reactions: Reaction[];
  voice: Voice | null;
  replyTo: string | null;
  clientId: string | null;
  delivery: Delivery | null;
  deliveryError: ErrorBody | null;
  createdAt: number;
  editedAt: number | null;
}

export interface QuestionOption {
  label: string;
  selectedLabel: string;
  value: string;
  style: string | null;
}

export interface QuestionAnswer {
  value: string;
  label: string;
  at: number;
}

export interface Question {
  kind: Kind;
  id: string;
  conversationId: string;
  order: number;
  seq: number;
  title: string;
  text: string;
  options: QuestionOption[];
  state: State;
  answer: QuestionAnswer | null;
  createdAt: number;
  expiresAt: number | null;
}

export interface Badge {
  kind: Kind;
  rev: number;
  unreadTotal: number;
}

export interface Status {
  rev: number;
  kind: Kind;
  conversationId: string;
  state: State;
  label: string | null;
  at: number;
}

export interface ConversationsResponse {
  conversations: Conversation[];
  statuses: Status[];
  badge: Badge;
  seq: number;
}

export interface ReadResponse {
  conversation: Conversation;
  badge: Badge;
}

export interface FileInitResponse {
  fileId: string;
  ticket: string;
  expiresAt: number;
  uploadPath: string;
  uploaded: boolean;
}

export interface TicketClaims {
  v: number;
  purpose: string;
  fileId: string;
  deviceId: string;
  userId: string;
  size: number;
  sha256: string;
  exp: number;
}

export interface PushAlert {
  title: string;
  body: string;
}

export interface PushAPS {
  alert: PushAlert;
  'thread-id': string;
  'mutable-content': number;
  badge: number;
  sound: string;
  category: string;
}

export interface PushData {
  v: number;
  h: string;
  c: string;
  m: string;
  k: Kind;
  a: Agent;
}

export interface PushPayload {
  aps: PushAPS;
  hd: PushData;
}

export interface Synchronized {
  seq: number;
}

export interface SigningFields {
  protocol: number;
  method: string;
  target: string;
  ts: number;
  nonce: string;
  bodyHash: string;
  deviceId: string;
}
export interface Authorization extends Omit<SigningFields, 'method' | 'target'> {
  signature: string;
}

/** The app wire protocol this host speaks; a request on any other is refused with `426 protocol`. */
export const APP_PROTOCOL = 1;

export function canonicalSigningText(fields: SigningFields): string {
  return [
    'HEYDAN-SIG-V1',
    fields.protocol,
    fields.method,
    fields.target,
    fields.ts,
    fields.nonce,
    fields.bodyHash,
    fields.deviceId,
  ].join('\n');
}

function decodeBase64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

export function parseAuthorization(header: string | undefined): Authorization | null {
  if (!header?.startsWith('HeyDan-Sig ')) return null;
  const fields = new Map<string, string>();
  for (const part of header.slice(11).split(',')) {
    const match = /^([a-z]+)=([^\s,=]+)$/.exec(part);
    if (!match || fields.has(match[1])) return null;
    fields.set(match[1], match[2]);
  }
  if (fields.size !== 7 || [...fields.keys()].some((k) => !['v', 'p', 'd', 't', 'n', 'bh', 's'].includes(k)))
    return null;
  const p = fields.get('p')!,
    t = fields.get('t')!,
    n = fields.get('n')!;
  const bh = fields.get('bh')!,
    s = fields.get('s')!,
    d = fields.get('d')!;
  if (
    fields.get('v') !== '1' ||
    !/^[1-9][0-9]*$/.test(p) ||
    !/^(0|[1-9][0-9]*)$/.test(t) ||
    !Number.isSafeInteger(Number(p)) ||
    !Number.isSafeInteger(Number(t)) ||
    !/^[a-f0-9]{64}$/.test(bh) ||
    decodeBase64url(n)?.length !== 16 ||
    !decodeBase64url(s)
  )
    return null;
  return { protocol: Number(p), ts: Number(t), nonce: n, bodyHash: bh, deviceId: d, signature: s };
}

// This checks cryptography only; device, clock, protocol, nonce persistence and body streaming belong to the caller.
export const verifyRequestSignature = (fields: SigningFields, signature: string, publicKey: string): boolean =>
  verifyP256(canonicalSigningText(fields), signature, publicKey);

export function verifyP256(text: string, signature: string, publicKey: string): boolean {
  try {
    const der = decodeBase64url(publicKey),
      sig = decodeBase64url(signature);
    if (!der || !sig) return false;
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    return verify('sha256', Buffer.from(text, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

export function bodySHA256(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('hex');
}
export function pairProofText(code: string, publicKey: string): string {
  return `HEYDAN-PAIR-V1\n${code}\n${publicKey}`;
}

function validClaims(value: unknown): value is TicketClaims {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    c.v === 1 &&
    c.purpose === 'upload' &&
    [c.fileId, c.deviceId, c.userId].every((v) => typeof v === 'string' && v.length > 0) &&
    typeof c.size === 'number' &&
    Number.isSafeInteger(c.size) &&
    c.size >= 0 &&
    typeof c.exp === 'number' &&
    Number.isSafeInteger(c.exp) &&
    c.exp >= 0 &&
    typeof c.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(c.sha256)
  );
}
export function mintTicket(claims: TicketClaims, secret: string | Uint8Array): string {
  if (!validClaims(claims)) throw new TypeError('Invalid upload ticket claims');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function readTicket(ticket: string, secret: string | Uint8Array, nowMs = Date.now()): TicketClaims | null {
  try {
    const parts = ticket.split('.');
    if (parts.length !== 2 || !Number.isFinite(nowMs)) return null;
    const payload = decodeBase64url(parts[0]),
      mac = decodeBase64url(parts[1]);
    const expected = createHmac('sha256', secret).update(parts[0]).digest();
    if (!payload || !mac || mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
    const claims: unknown = JSON.parse(payload.toString('utf8'));
    return validClaims(claims) && claims.exp > nowMs ? claims : null;
  } catch {
    return null;
  }
}

export type AppEvent =
  | { kind: 'message'; data: Message; id: number }
  | { kind: 'question'; data: Question; id: number }
  | { kind: 'conversation'; data: Conversation; id: number }
  | { kind: 'badge'; data: Badge; id?: never }
  | { kind: 'status'; data: Status; id?: never }
  | { kind: 'synchronized'; data: Synchronized; id?: never }
  | { kind: string; data: unknown; id?: number };
export function formatEvent(event: AppEvent | { comment: string }): string {
  if ('comment' in event) {
    if (/[\r\n]/.test(event.comment)) throw new TypeError('Invalid SSE comment');
    return `: ${event.comment}\n\n`;
  }
  if (!event.kind || /[\r\n]/.test(event.kind)) throw new TypeError('Invalid SSE event kind');
  if (event.id !== undefined && (!Number.isSafeInteger(event.id) || event.id < 0))
    throw new TypeError('Invalid SSE id');
  if (['status', 'badge', 'synchronized'].includes(event.kind) && event.id !== undefined)
    throw new TypeError('Non-log event has an id');
  if (['message', 'question', 'conversation'].includes(event.kind)) {
    if (event.id === undefined || (event.data as { seq?: number })?.seq !== event.id)
      throw new TypeError('Entity event id must equal seq');
  }
  const data = JSON.stringify(event.data);
  if (data === undefined) throw new TypeError('Missing SSE data');
  return `${event.id === undefined ? '' : `id: ${event.id}\n`}event: ${event.kind}\ndata: ${data}\n\n`;
}
