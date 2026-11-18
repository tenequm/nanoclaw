import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { signRequest } from './app-sign.js';
import { bodySHA256, pairProofText } from '../src/channels/app/contract.js';
import type {
  Conversation,
  ConversationsResponse,
  Message,
  Question,
  PairResponse,
  FileInitResponse,
  ReadResponse,
} from '../src/channels/app/contract.js';

const PROXY_HOST = '127.0.0.1.sslip.io';
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', PROXY_HOST];
// node:assert appends actual values to its message, which can be payload; a Failure carries only its code.
class Failure extends Error {}
function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Failure(code);
}

export function target(parts: string[], query: [string, string][] = []): string {
  const encode = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  ensure(
    parts.every((p) => p && p !== '.' && p !== '..' && !p.includes(';')),
    'invalid target segment',
  );
  return (
    '/' +
    parts.map(encode).join('/') +
    (query.length ? '?' + query.map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&') : '')
  );
}
export function guard(base: string, remote: boolean, agent?: string, allowedAgent?: string): void {
  const u = new URL(base);
  ensure(
    ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      u.pathname === '/' &&
      !u.search &&
      !u.hash,
    'invalid base',
  );
  const local = LOOPBACK.includes(u.hostname);
  ensure(local || remote, 'remote base requires --remote');
  if (remote) ensure(allowedAgent?.trim(), 'remote requires --agent or LOCAL_REMOTE_AGENT');
  if (!local && agent !== undefined) ensure(agent === allowedAgent, 'remote agent not allowed');
}
export interface Event {
  kind: string;
  id?: number;
  data: Record<string, unknown>;
}
export class StreamParser {
  private decoder = new TextDecoder();
  private stopped = false;
  stop(): void {
    this.stopped = true;
    this.pending = '';
  }
  private pending = '';
  cursor: number;
  constructor(
    cursor: number,
    private consume: (event: Event) => void,
  ) {
    this.cursor = cursor;
  }
  feed(bytes: Uint8Array): void {
    if (this.stopped) return;
    this.pending += this.decoder.decode(bytes, { stream: true });
    let end: number;
    while (!this.stopped && (end = this.pending.indexOf('\n\n')) >= 0) {
      const block = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 2);
      let kind = 'message',
        id: number | undefined;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) kind = line.slice(6).trimStart();
        if (line.startsWith('id:')) id = Number(line.slice(3).trim());
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      const value = JSON.parse(data.join('\n')) as Record<string, unknown>;
      if (kind === 'synchronized') this.cursor = Math.max(this.cursor, Number(value.seq));
      else if (!['status', 'badge'].includes(kind) && Number.isSafeInteger(id))
        this.cursor = Math.max(this.cursor, id!);
      this.consume({ kind, id, data: value });
    }
  }
}
export async function revokedStreamClosed(done: Promise<void>): Promise<void> {
  try {
    await done;
  } catch (error) {
    // Revocation destroys the HTTP response rather than ending the SSE body cleanly.
    if (
      !(
        error instanceof TypeError &&
        error.message === 'terminated' &&
        (error.cause as { code?: string })?.code === 'UND_ERR_SOCKET'
      )
    )
      throw error;
  }
}
class Skip extends Error {}
// A result detail is a skip reason or a fixed code written in this file, never server payload.
function failureDetail(e: unknown): string {
  if (e instanceof Skip || e instanceof Failure) return e.message;
  if ((e as { name?: unknown } | undefined)?.name === 'TimeoutError') return 'timeout';
  const code = (e as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)
    ? 'transport:' + code
    : 'unexpected_failure (payload withheld)';
}
async function expectError(r: Response, status: number, error: string, step: string) {
  ensure(r.status === status, 'status_mismatch:' + step);
  ensure(((await r.json()) as { error?: unknown }).error === error, 'error_mismatch:' + step);
}
interface Device {
  privateKey: string;
  deviceId: string;
}
interface Options {
  scenario?: string;
  remote?: boolean;
  agent?: string;
  deviceDir?: string;
}

export async function runAppClient(baseUrl: string, runDir: string, options: Options = {}): Promise<void> {
  const allowedAgent = options.agent ?? process.env.LOCAL_REMOTE_AGENT;
  const scenario = options.scenario ?? 'all';
  ensure(['pair', 'send', 'stream', 'upload', 'security', 'all'].includes(scenario), 'unknown scenario');
  const host = URL.canParse(baseUrl) ? new URL(baseUrl).hostname : '';
  const route = host === PROXY_HOST ? 'chain' : LOOPBACK.includes(host) ? 'direct' : 'remote';
  mkdirSync(join(runDir, 'results'), { recursive: true });
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  const log = join(runDir, 'logs/app-client.log');
  let failures = 0;
  async function check(id: string, fn: () => Promise<void>) {
    let status = 'pass',
      detail = 'Verified';
    const started = Date.now();
    try {
      await fn();
    } catch (e) {
      status = e instanceof Skip ? 'skip' : 'fail';
      detail = failureDetail(e);
      if (status === 'fail') failures++;
    }
    const result = {
      id: `app-client-${route}-${id}`,
      title: `${route} ${id.replaceAll('-', ' ')}`,
      status,
      detail,
      evidence: ['logs/app-client.log'],
      at: new Date().toISOString(),
    };
    writeFileSync(join(runDir, 'results', result.id + '.json'), JSON.stringify(result) + '\n', { mode: 0o600 });
    appendFileSync(log, `${result.id} ${status} ${Date.now() - started}ms\n`, { mode: 0o600 });
    console.log(`${result.id}: ${status} (${detail})`);
    return { status, detail };
  }
  if ((await check('guard', async () => guard(baseUrl, !!options.remote, undefined, allowedAgent))).status !== 'pass')
    throw new Error('Client guard refused');
  const statePath = '.local/stack.json';
  const stack = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, 'utf8')) as { owner: string; group: string })
    : undefined;
  const dir = options.deviceDir ?? '.local/app-client';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  async function raw(method: string, path: string, body?: Uint8Array, authorization?: string, signal?: AbortSignal) {
    const response = await fetch(baseUrl + path, {
      method,
      body: body ? Buffer.from(body) : undefined,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(authorization ? { Authorization: authorization } : {}),
      },
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(15000),
    });
    appendFileSync(log, `http ${method} ${response.status}\n`, { mode: 0o600 });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      throw new Failure('rate_limited, retry after ' + (Number.isFinite(retryAfter) ? retryAfter : 0) + ' s');
    }
    return response;
  }
  async function request(device: Device, method: string, path: string, value?: unknown, ts?: number) {
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    return raw(method, path, body, signRequest({ ...device, method, target: path, body, ts }));
  }
  async function json<T>(r: Response): Promise<T> {
    ensure(r.ok, 'http_' + r.status);
    return r.json() as Promise<T>;
  }
  const pairedThisRun: { device: Device; file: string }[] = [];
  const revoked = new Set<string>();
  async function pair(index: number, tampered = false): Promise<Device> {
    // A refused proof never consumes the code, so the tampered pair reuses the first link.
    const linkName = index === 0 || tampered ? 'HEYDAN_PAIR_LINK' : 'HEYDAN_PAIR_LINK_SECOND';
    let link = process.env[linkName];
    if (!link) {
      if (options.remote || !stack)
        throw new Skip(options.remote ? `${linkName} unset` : `${linkName} unset and no local stack`);
      const output = execFileSync(
        'pnpm',
        ['ncl', 'devices', 'pair', '--user', stack.owner, '--agents', stack.group, '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const envelope = JSON.parse(output.slice(output.indexOf('{')));
      link = envelope.data;
    }
    ensure(link, 'pair link missing');
    const url = new URL(link);
    guard(url.origin, !!options.remote, undefined, allowedAgent);
    // The loopback direct and chain endpoints deliberately share one local host identity.
    if (options.remote || !stack) ensure(url.origin === new URL(baseUrl).origin, 'pairing host mismatch');
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const code = url.hash.slice(1);
    const proof = sign('sha256', Buffer.from(pairProofText(code, publicKey)), keys.privateKey).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        code,
        publicKey,
        deviceName: 'app-client scripted client',
        proof: tampered ? proof.slice(0, -4) + 'AAAA' : proof,
        app: { version: '1', build: '1', os: 'Node' },
      }),
    );
    const response = await raw('POST', '/app/pair', body);
    if (tampered) {
      await expectError(response, 400, 'bad_proof', 'pair-proof');
      return {} as Device;
    }
    const paired = await json<PairResponse>(response);
    for (const agent of paired.agents) guard(baseUrl, !!options.remote, agent.name, allowedAgent);
    const device = {
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      deviceId: paired.deviceId,
    };
    const file = join(dir, `device-${index}.json`);
    writeFileSync(file, JSON.stringify(device), { mode: 0o600 });
    chmodSync(file, 0o600);
    pairedThisRun.push({ device, file });
    return device;
  }
  async function loadOrPair(index: number): Promise<Device> {
    const file = join(dir, `device-${index}.json`);
    if (existsSync(file) && !options.remote && stack) {
      const device = JSON.parse(readFileSync(file, 'utf8')) as Device;
      const response = await request(device, 'GET', '/app/conversations');
      if (response.status === 200) {
        await response.body?.cancel();
        return device;
      }
      const value = (await response.json()) as { error: string };
      ensure(
        response.status === 401 && ['unknown_device', 'device_revoked'].includes(value.error),
        'device validation failed',
      );
    }
    return pair(index);
  }
  async function revoke(device: Device) {
    ensure((await request(device, 'DELETE', '/app/devices/me')).status === 204, 'status_mismatch:revoke');
    revoked.add(device.deviceId);
  }
  // A remote base keeps none of this run's devices: each is revoked and its key file removed.
  async function revokeRemote() {
    if (route !== 'remote' || !pairedThisRun.length) return;
    await check('cleanup-revoke', async () => {
      for (const { device, file } of pairedThisRun) {
        if (!revoked.has(device.deviceId)) await revoke(device);
        rmSync(file, { force: true });
      }
    });
  }
  let a: Device | undefined, b: Device | undefined;
  let secondUnavailable = 'pairing failed';
  const paired = await check('pair', async () => {
    a = await loadOrPair(0);
    try {
      b = await loadOrPair(1);
    } catch (error) {
      // One pair link still runs every single-device check; only read-other-device skips.
      if (!(error instanceof Skip)) throw error;
      secondUnavailable = error.message;
    }
    if (b) ensure(a.deviceId !== b.deviceId, 'same_device:pair');
  });
  const requirePair = () => {
    if (!a)
      throw new Skip(paired.status === 'skip' ? 'Pairing dependency: ' + paired.detail : 'Pairing dependency failed');
    return a;
  };
  const requireSecond = () => {
    requirePair();
    if (!b) throw new Skip('Second device unavailable: ' + secondUnavailable);
    return b;
  };
  if (scenario === 'pair') {
    await revokeRemote();
    if (failures) throw new Error('Client checks failed');
    return;
  }
  let conversation: Conversation | undefined;
  let initialCursor = 0;
  await check('conversations', async () => {
    const list = await json<ConversationsResponse>(await request(requirePair(), 'GET', '/app/conversations'));
    initialCursor = list.seq;
    const candidate = list.conversations[0];
    ensure(candidate, 'no_conversation');
    guard(baseUrl, !!options.remote, candidate.agent.name, allowedAgent);
    conversation = candidate;
  });
  function conv() {
    requirePair();
    if (!conversation) throw new Skip('Conversation dependency unavailable');
    return conversation;
  }
  function path(suffix: string) {
    return target(['app', 'conversations', conv().id, suffix]);
  }
  const streams: { stop: () => void; done: Promise<void>; parser: StreamParser; events: Event[] }[] = [];
  async function stream(device: Device, after: number, cutAfter?: number) {
    const controller = new AbortController();
    const events: Event[] = [];
    const parser = new StreamParser(after, (e) => {
      appendFileSync(
        log,
        JSON.stringify({ kind: e.kind, id: e.data.id, seq: e.id, state: e.data.state, delivery: e.data.delivery }) +
          '\n',
        { mode: 0o600 },
      );
      events.push(e);
      if (cutAfter && events.length >= cutAfter) {
        parser.stop();
        controller.abort();
      }
    });
    const t = target(['app', 'events'], [['after', String(after)]]);
    const connectTimer = setTimeout(() => controller.abort(), 15000);
    let response: Response;
    try {
      response = await raw(
        'GET',
        t,
        undefined,
        signRequest({ ...device, method: 'GET', target: t }),
        controller.signal,
      );
    } finally {
      clearTimeout(connectTimer);
    }
    ensure(response.ok, 'http_' + response.status);
    ensure(response.headers.get('content-type')?.includes('text/event-stream'), 'not_event_stream');
    ensure(response.body, 'no_stream_body');
    const done = (async () => {
      try {
        for await (const chunk of response.body!) parser.feed(chunk);
      } catch (e) {
        if (!controller.signal.aborted) throw e;
      }
    })();
    void done.catch(() => {});
    const value = { stop: () => controller.abort(), done, parser, events };
    streams.push(value);
    return value;
  }
  async function until(predicate: () => boolean, step: string) {
    const end = Date.now() + 45000;
    while (!predicate()) {
      ensure(Date.now() < end, 'event_deadline:' + step);
      await delay(50);
    }
  }
  let live: Awaited<ReturnType<typeof stream>> | undefined;
  await check('stream-open', async () => {
    conv();
    live = await stream(requirePair(), initialCursor);
    await until(() => live!.events.some((e) => e.kind === 'synchronized'), 'synchronized');
  });
  function events() {
    if (!live) throw new Skip('Stream dependency unavailable');
    return live.events;
  }
  const since = (start: number) => events().slice(start);
  async function send(text: string, fileIds: string[] = [], clientId: string = randomUUID()) {
    return json<{ message: Message }>(
      await request(requirePair(), 'POST', path('messages'), { clientId, text, fileIds }),
    );
  }
  async function reached(message: Message) {
    await until(
      () => events().some((e) => e.kind === 'message' && e.data.id === message.id && e.data.delivery === 'reached'),
      'reached',
    );
  }
  try {
    if (['all', 'send'].includes(scenario)) {
      for (const command of ['reply', 'multi', 'markdown', 'edit', 'question', 'long'])
        await check('send-' + command, async () => {
          const start = events().length;
          const { message } = await send(command + ' app-client');
          ensure(message.delivery === 'stored', 'delivery_mismatch:send');
          await reached(message);
          const replies = () => since(start).filter((e) => e.kind === 'message' && e.data.role === 'agent');
          if (command === 'question') {
            await until(() => since(start).some((e) => e.kind === 'question'), 'question');
            const q = since(start).find((e) => e.kind === 'question')!.data as unknown as Question;
            const response = await json<{ question: Question }>(
              await request(requirePair(), 'POST', target(['app', 'questions', q.id, 'answer']), {
                value: q.options[0].value,
              }),
            );
            ensure(response.question.state === 'answered', 'state_mismatch:answer');
            await until(
              () => events().some((e) => e.kind === 'question' && e.data.id === q.id && e.data.state === 'answered'),
              'question-answered',
            );
          }
          await until(() => new Set(replies().map((e) => e.data.id)).size >= (command === 'multi' ? 3 : 1), 'replies');
          if (command === 'markdown') {
            const text = replies()
              .map((e) => String(e.data.text))
              .join('\n');
            ensure(/^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/m.test(text) || /^```/m.test(text), 'markdown_missing');
          }
          if (command === 'edit') {
            await until(
              () =>
                replies().some((e, i, all) =>
                  all
                    .slice(0, i)
                    .some((prior) => prior.data.id === e.data.id && Number(prior.data.seq) < Number(e.data.seq)),
                ),
              'edit-version',
            );
            const versions = replies();
            ensure(new Set(versions.map((e) => e.data.id)).size === 1, 'edit_id_mismatch');
            ensure(new Set(versions.map((e) => e.data.order)).size === 1, 'edit_order_mismatch');
            ensure(
              versions.slice(1).every((e) => typeof e.data.editedAt === 'number'),
              'edited_at_missing',
            );
          }
          if (command === 'long') {
            ensure(
              since(start).some(
                (e) => e.kind === 'status' && e.data.state === 'working' && typeof e.data.label === 'string',
              ),
              'working_status_missing',
            );
            await until(() => since(start).some((e) => e.kind === 'status' && e.data.state === 'idle'), 'idle');
          }
          if (command === 'reply') {
            const duplicate = await send(command + ' app-client', [], message.clientId!);
            ensure(duplicate.message.id === message.id, 'duplicate_id_mismatch');
            const states = events()
              .filter((e) => e.data.id === message.id)
              .map((e) => e.data.delivery);
            ensure(!states.slice(states.indexOf('reached') + 1).includes('routed'), 'delivery_regressed');
          }
        });
      await check('voice-refusal', async () => {
        const r = await request(requirePair(), 'POST', path('messages'), {
          clientId: randomUUID(),
          text: '/voice',
          fileIds: [],
        });
        await expectError(r, 409, 'use_call_screen', 'voice');
      });
    }
    if (['all', 'stream'].includes(scenario)) {
      await check('stream-resume', async () => {
        conv();
        const replay = await stream(requirePair(), 0, 1);
        await replay.done;
        ensure(replay.events.length, 'empty_replay');
        const resumed = await stream(requirePair(), replay.parser.cursor);
        await until(() => resumed.events.some((e) => e.kind === 'synchronized'), 'resumed-synchronized');
        resumed.stop();
        await resumed.done;
        const full = await stream(requirePair(), 0);
        await until(() => full.events.some((e) => e.kind === 'synchronized'), 'full-synchronized');
        full.stop();
        await full.done;
        ensure(
          replay.parser.cursor < Number(full.events.find((e) => e.kind === 'synchronized')!.data.seq),
          'cut_not_mid_replay',
        );
        ensure(
          resumed.events.some((e) => ['conversation', 'message', 'question'].includes(e.kind)),
          'resume_without_entities',
        );
        const ids = (es: Event[]) => es.filter((e) => e.id !== undefined).map((e) => e.id!);
        const combined = ids([...replay.events, ...resumed.events]);
        ensure(new Set(combined).size === combined.length, 'duplicate_events');
        ensure(isDeepStrictEqual(combined, ids(full.events)), 'replay_mismatch');
      });
      await check('read-other-device', async () => {
        conv();
        const other = await stream(requireSecond(), initialCursor);
        await until(() => other.events.some((e) => e.kind === 'synchronized'), 'other-synchronized');
        const before = other.events.length;
        const { message } = await send('reply app-client badge');
        await reached(message);
        await until(
          () =>
            events().some(
              (e) => e.kind === 'message' && e.data.role === 'agent' && Number(e.data.order) > message.order,
            ),
          'agent-reply',
        );
        const order = Math.max(
          ...events()
            .filter((e) => e.kind === 'message' || e.kind === 'question')
            .map((e) => Number(e.data.order)),
        );
        const lastBadge = () => Number(other.events.findLast((e) => e.kind === 'badge')?.data.unreadTotal ?? 0);
        await until(() => lastBadge() > 0, 'unread-badge');
        const unreadBefore = lastBadge();
        const answer = await json<ReadResponse>(await request(requirePair(), 'POST', path('read'), { order }));
        ensure(answer.badge.unreadTotal < unreadBefore, 'unread_not_lowered');
        ensure(answer.conversation.readOrder === order, 'read_order_mismatch');
        await until(
          () =>
            other.events
              .slice(before)
              .some((e) => e.kind === 'badge' && e.data.unreadTotal === answer.badge.unreadTotal),
          'other-badge',
        );
        for (const e of other.events.filter((e) => ['status', 'badge'].includes(e.kind)))
          ensure(e.id === undefined, 'ephemeral_event_id');
        other.stop();
        await other.done;
      });
    }
    if (['all', 'upload'].includes(scenario)) {
      await check('upload', async () => {
        conv();
        const bytes = Buffer.from('app-client attachment\n');
        const minted = await json<FileInitResponse>(
          await request(requirePair(), 'POST', '/app/files', {
            uploadKey: randomUUID(),
            name: 'app-client.txt',
            mimeType: 'text/plain',
            size: bytes.length,
            sha256: bodySHA256(bytes),
          }),
        );
        ensure(minted.uploadPath === target(['app', 'files', minted.fileId]), 'upload_path_mismatch');
        for (const [n, payload] of [bytes, bytes, Buffer.alloc(bytes.length, 120)].entries()) {
          const step = `put-${n + 1}`;
          const r = await raw('PUT', minted.uploadPath, payload, 'HeyDan-Ticket ' + minted.ticket);
          if (payload !== bytes) await expectError(r, 400, 'bad_body', step);
          else {
            ensure(r.status === 204, 'status_mismatch:' + step);
            ensure((await r.text()) === '', 'body_not_empty:' + step);
          }
        }
        await reached((await send('reply app-client upload', [minted.fileId])).message);
      });
      await check('download-files', async () => {
        const start = events().length;
        await reached((await send('file')).message);
        const agentFiles = () =>
          since(start)
            .filter((e) => e.kind === 'message')
            .flatMap((e) => (e.data as unknown as Message).files);
        await until(() => new Set(agentFiles().map((f) => f.id)).size >= 2, 'agent-files');
        const unique = [...new Map(agentFiles().map((f) => [f.id, f])).values()];
        ensure(unique.length === 2, 'file_count');
        for (const f of unique) {
          const r = await request(requirePair(), 'GET', target(['app', 'files', f.id]));
          ensure(r.ok, 'http_' + r.status);
          ensure((await r.arrayBuffer()).byteLength === f.size, 'size_mismatch');
          if (f.mimeType === 'image/png') {
            ensure(f.kind === 'image', 'image_kind');
            ensure(f.width! > 0 && f.height! > 0, 'image_dimensions');
          }
        }
        ensure(
          unique.some((f) => f.mimeType === 'image/png'),
          'png_missing',
        );
      });
    }
    if (['all', 'security'].includes(scenario)) {
      await check('security-replay', async () => {
        const d = requirePair(),
          t = '/app/conversations',
          auth = signRequest({ ...d, method: 'GET', target: t });
        const first = await raw('GET', t, undefined, auth);
        ensure(first.ok, 'http_' + first.status);
        await expectError(await raw('GET', t, undefined, auth), 401, 'replayed', 'replay');
      });
      await check('security-body', async () => {
        const d = requirePair(),
          t = path('read'),
          body = Buffer.from('{"order":0}');
        const r = await raw(
          'POST',
          t,
          Buffer.from('{"order":1}'),
          signRequest({ ...d, method: 'POST', target: t, body }),
        );
        await expectError(r, 400, 'bad_body', 'body');
      });
      await check('security-clock', async () => {
        const d = requirePair();
        const r = await request(d, 'GET', '/app/conversations', undefined, Math.floor(Date.now() / 1000) - 300);
        ensure(r.status === 401, 'status_mismatch:clock');
        const value = (await r.json()) as { error?: string; serverTime: number };
        ensure(value.error === 'stale_timestamp', 'error_mismatch:clock');
        const retry = await request(d, 'GET', '/app/conversations', undefined, Math.floor(value.serverTime / 1000));
        ensure(retry.ok, 'http_' + retry.status);
      });
      await check('security-pair-proof', async () => {
        requirePair();
        await pair(2, true);
      });
      await check('security-canonical', async () => {
        // A remote base sits behind the real proxy chain, so it gets the check too.
        if (route === 'direct') throw new Skip('Requires proxy chain');
        const t = '/app//conversations';
        const r = await raw('GET', t, undefined, signRequest({ ...requirePair(), method: 'GET', target: t }));
        await expectError(r, 401, 'bad_signature', 'canonical');
      });
      await check('security-revoke', async () => {
        conv();
        // Remote revokes the run's last device here; locally a throwaway keeps devices 0 and 1 reusable.
        const disposable = route === 'remote' ? (b ?? requirePair()) : await pair(3);
        const opened = await stream(disposable, live!.parser.cursor);
        await revoke(disposable);
        let deadline: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            revokedStreamClosed(opened.done),
            new Promise<never>((_, reject) => {
              deadline = setTimeout(() => reject(new Failure('event_deadline:revoke-close')), 5000);
            }),
          ]);
        } finally {
          clearTimeout(deadline);
        }
        await expectError(await request(disposable, 'GET', '/app/conversations'), 401, 'device_revoked', 'revoked-get');
      });
    }
  } finally {
    for (const s of streams) s.stop();
    await Promise.allSettled(streams.map((s) => s.done));
    await revokeRemote();
  }
  if (failures) throw new Error(`${failures} client checks failed`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      remote: { type: 'boolean' },
      agent: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.base)
    console.log('Usage: app-client.ts <pair|send|stream|upload|security|all> --base <url> [--remote --agent <name>]');
  else
    runAppClient(values.base, process.env.LOCAL_RUN_DIR ?? '.local/app-client/run', {
      scenario: positionals[0],
      remote: values.remote,
      agent: values.agent,
    }).catch(() => {
      console.error('Client checks failed; see run results (payload withheld)');
      process.exitCode = 1;
    });
}
