import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
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
  Badge,
} from '../src/channels/app/contract.js';

export function target(parts: string[], query: [string, string][] = []): string {
  const encode = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  assert(
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
  assert(
    ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      u.pathname === '/' &&
      !u.search &&
      !u.hash,
    'invalid base',
  );
  const local = ['127.0.0.1', 'localhost', '[::1]', '127.0.0.1.sslip.io'].includes(u.hostname);
  assert(local || remote, 'remote base requires --remote');
  if (remote) assert(allowedAgent?.trim(), 'remote requires --agent or LOCAL_REMOTE_AGENT');
  if (!local && agent !== undefined) assert(agent === allowedAgent, 'remote agent not allowed');
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
class RateLimited extends Error {}
interface Device {
  privateKey: string;
  publicKey: string;
  deviceId: string;
  base: string;
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
  assert(['pair', 'send', 'stream', 'upload', 'security', 'all'].includes(scenario), 'unknown scenario');
  mkdirSync(join(runDir, 'results'), { recursive: true });
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  const log = join(runDir, 'logs/n9b-client.log');
  let failures = 0;
  async function check(id: string, fn: () => Promise<void>) {
    let status = 'pass',
      detail = 'Verified';
    const started = Date.now();
    try {
      await fn();
    } catch (e) {
      status = e instanceof Skip ? 'skip' : 'fail';
      detail =
        e instanceof Skip || e instanceof RateLimited ? e.message : 'Assertion or transport failure (payload withheld)';
      if (status === 'fail') failures++;
    }
    const result = {
      id: 'n9b-' + (new URL(baseUrl).hostname === '127.0.0.1.sslip.io' ? 'chain-' : 'direct-') + id,
      title: (new URL(baseUrl).hostname === '127.0.0.1.sslip.io' ? 'chain ' : 'direct ') + id.replaceAll('-', ' '),
      status,
      detail,
      evidence: ['logs/n9b-client.log'],
      at: new Date().toISOString(),
    };
    writeFileSync(join(runDir, 'results', result.id + '.json'), JSON.stringify(result) + '\n', { mode: 0o600 });
    appendFileSync(log, `${result.id} ${status} ${Date.now() - started}ms\n`, { mode: 0o600 });
    console.log(`${result.id}: ${status} (${detail})`);
    return status;
  }
  if ((await check('guard', async () => guard(baseUrl, !!options.remote, undefined, allowedAgent))) !== 'pass')
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
      throw new RateLimited('rate_limited, retry after ' + (Number.isFinite(retryAfter) ? retryAfter : 0) + ' s');
    }
    if (response.status === 501) {
      await response.body?.cancel();
      throw new Skip('501 not_implemented');
    }
    return response;
  }
  async function request(device: Device, method: string, path: string, value?: unknown, ts?: number) {
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    return raw(method, path, body, signRequest({ ...device, method, target: path, body, ts }));
  }
  async function json<T>(r: Response): Promise<T> {
    assert(r.ok, `HTTP ${r.status}`);
    return r.json() as Promise<T>;
  }
  async function pair(index: number, tampered = false): Promise<Device> {
    let link = process.env[index === 0 ? 'HEYDAN_PAIR_LINK' : 'HEYDAN_PAIR_LINK_SECOND'];
    if (!link) {
      if (options.remote || !stack) throw new Skip('Local stack unavailable for pairing a second device');
      const output = execFileSync(
        'pnpm',
        [
          'ncl',
          'devices',
          'pair',
          '--user',
          process.env.LOCAL_OWNER_ID ?? stack.owner,
          '--agents',
          stack.group,
          '--json',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const envelope = JSON.parse(output.slice(output.indexOf('{')));
      if (envelope.error === 'not_implemented' || envelope.error?.code === 'not_implemented')
        throw new Skip('501 not_implemented');
      link = typeof envelope.data === 'string' ? envelope.data : envelope.data?.link;
    }
    assert(link, 'pair link missing');
    const url = new URL(link);
    guard(url.origin, !!options.remote, undefined, allowedAgent);
    // The loopback direct and chain endpoints deliberately share one local host identity.
    if (options.remote || !stack) assert(url.origin === new URL(baseUrl).origin, 'pairing host mismatch');
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    const code = url.hash.slice(1);
    const proof = sign('sha256', Buffer.from(pairProofText(code, publicKey)), keys.privateKey).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        code,
        publicKey,
        deviceName: 'N9b scripted client',
        proof: tampered ? proof.slice(0, -4) + 'AAAA' : proof,
        app: { version: '1', build: '1', os: 'Node' },
      }),
    );
    const response = await raw('POST', '/app/pair', body);
    if (tampered) {
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'bad_proof');
      return {} as Device;
    }
    const paired = await json<PairResponse>(response);
    for (const agent of paired.agents) guard(baseUrl, !!options.remote, agent.name, allowedAgent);
    const device = {
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey,
      deviceId: paired.deviceId,
      base: baseUrl,
    };
    const file = join(dir, `device-${index}.json`);
    writeFileSync(file, JSON.stringify(device), { mode: 0o600 });
    chmodSync(file, 0o600);
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
      const value = await response.json();
      assert(
        response.status === 401 && ['unknown_device', 'device_revoked'].includes(value.error),
        'device validation failed',
      );
    }
    return pair(index);
  }
  let a: Device | undefined, b: Device | undefined;
  const paired = await check('pair', async () => {
    a = await loadOrPair(0);
    b = await loadOrPair(1);
    assert.notEqual(a.deviceId, b.deviceId);
  });
  const requirePair = () => {
    if (!a || !b)
      throw new Skip(
        paired === 'skip' ? 'Pairing dependency: 501 not_implemented or unavailable' : 'Pairing dependency failed',
      );
    return a;
  };
  if (scenario === 'pair') {
    if (failures) throw new Error('Client checks failed');
    return;
  }
  let conversation: Conversation | undefined;
  let initialCursor = 0;
  await check('conversations', async () => {
    const list = await json<ConversationsResponse>(await request(requirePair(), 'GET', '/app/conversations'));
    initialCursor = list.seq;
    const candidate = list.conversations[0];
    assert(candidate);
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
    assert(response.ok && response.headers.get('content-type')?.includes('text/event-stream'));
    assert(response.body);
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
  async function until(predicate: () => boolean) {
    const end = Date.now() + 45000;
    while (!predicate()) {
      assert(Date.now() < end, 'event deadline');
      await delay(50);
    }
  }
  let live: Awaited<ReturnType<typeof stream>> | undefined;
  await check('stream-open', async () => {
    conv();
    live = await stream(requirePair(), initialCursor);
    await until(() => live!.events.some((e) => e.kind === 'synchronized'));
  });
  function events() {
    if (!live) throw new Skip('Stream dependency unavailable');
    return live.events;
  }
  async function send(text: string, fileIds: string[] = [], clientId: string = randomUUID()) {
    return json<{ message: Message }>(
      await request(requirePair(), 'POST', path('messages'), { clientId, text, fileIds }),
    );
  }
  async function reached(message: Message) {
    await until(() =>
      events().some((e) => e.kind === 'message' && e.data.id === message.id && e.data.delivery === 'reached'),
    );
  }
  try {
    if (['all', 'send'].includes(scenario)) {
      for (const command of ['reply', 'multi', 'markdown', 'edit', 'question', 'long'])
        await check('send-' + command, async () => {
          const start = events().length;
          const { message } = await send(command + ' n9b');
          assert.equal(message.delivery, 'stored');
          await reached(message);
          const replies = () =>
            events()
              .slice(start)
              .filter((e) => e.kind === 'message' && e.data.role === 'agent');
          if (command === 'question') {
            await until(() =>
              events()
                .slice(start)
                .some((e) => e.kind === 'question'),
            );
            const q = events()
              .slice(start)
              .find((e) => e.kind === 'question')!.data as unknown as Question;
            const response = await json<{ question: Question }>(
              await request(requirePair(), 'POST', target(['app', 'questions', q.id, 'answer']), {
                value: q.options[0].value,
              }),
            );
            assert.equal(response.question.state, 'answered');
            await until(() =>
              events().some((e) => e.kind === 'question' && e.data.id === q.id && e.data.state === 'answered'),
            );
          }
          await until(() => new Set(replies().map((e) => e.data.id)).size >= (command === 'multi' ? 3 : 1));
          if (command === 'edit') {
            await until(() =>
              replies().some((e, i, all) =>
                all
                  .slice(0, i)
                  .some((prior) => prior.data.id === e.data.id && Number(prior.data.seq) < Number(e.data.seq)),
              ),
            );
            const versions = replies();
            assert.equal(new Set(versions.map((e) => e.data.id)).size, 1);
            assert.equal(new Set(versions.map((e) => e.data.order)).size, 1);
          }
          if (command === 'long') {
            assert(
              events()
                .slice(start)
                .some((e) => e.kind === 'status' && e.data.state === 'working' && typeof e.data.label === 'string'),
            );
            await until(() =>
              events()
                .slice(start)
                .some((e) => e.kind === 'status' && e.data.state === 'idle'),
            );
          }
          if (command === 'reply') {
            const duplicate = await send(command + ' n9b', [], message.clientId!);
            assert.equal(duplicate.message.id, message.id);
            const states = events()
              .filter((e) => e.data.id === message.id)
              .map((e) => e.data.delivery);
            assert(!states.slice(states.indexOf('reached') + 1).includes('routed'));
          }
        });
      await check('voice-refusal', async () => {
        const r = await request(requirePair(), 'POST', path('messages'), {
          clientId: randomUUID(),
          text: '/voice',
          fileIds: [],
        });
        assert.equal(r.status, 409);
        assert.equal((await r.json()).error, 'use_call_screen');
      });
    }
    if (['all', 'stream'].includes(scenario)) {
      await check('stream-resume', async () => {
        conv();
        const replay = await stream(requirePair(), 0, 1);
        await replay.done;
        assert(replay.events.length);
        const resumed = await stream(requirePair(), replay.parser.cursor);
        await until(() => resumed.events.some((e) => e.kind === 'synchronized'));
        resumed.stop();
        await resumed.done;
        const full = await stream(requirePair(), 0);
        await until(() => full.events.some((e) => e.kind === 'synchronized'));
        full.stop();
        await full.done;
        assert(replay.parser.cursor < Number(full.events.find((e) => e.kind === 'synchronized')!.data.seq));
        assert(resumed.events.some((e) => ['conversation', 'message', 'question'].includes(e.kind)));
        const ids = (es: Event[]) => es.filter((e) => e.id !== undefined).map((e) => e.id!);
        const combined = ids([...replay.events, ...resumed.events]);
        assert.equal(new Set(combined).size, combined.length);
        assert.deepEqual(combined, ids(full.events));
      });
      await check('read-other-device', async () => {
        conv();
        const other = await stream(b!, initialCursor);
        await until(() => other.events.some((e) => e.kind === 'synchronized'));
        const before = other.events.length;
        const { message } = await send('reply n9b badge');
        await reached(message);
        await until(() =>
          events().some((e) => e.kind === 'message' && e.data.role === 'agent' && Number(e.data.order) > message.order),
        );
        const order = Math.max(
          ...events()
            .filter((e) => e.kind === 'message' || e.kind === 'question')
            .map((e) => Number(e.data.order)),
        );
        const answer = await json<{ badge: Badge }>(await request(requirePair(), 'POST', path('read'), { order }));
        await until(() =>
          other.events.slice(before).some((e) => e.kind === 'badge' && e.data.unreadTotal === answer.badge.unreadTotal),
        );
        for (const e of other.events.filter((e) => ['status', 'badge'].includes(e.kind))) assert.equal(e.id, undefined);
        other.stop();
        await other.done;
      });
    }
    if (['all', 'upload'].includes(scenario)) {
      let filesUnavailable = false;
      await check('upload', async () => {
        conv();
        const bytes = Buffer.from('N9b attachment\n');
        let mintResponse: Response;
        try {
          mintResponse = await request(requirePair(), 'POST', '/app/files', {
            uploadKey: randomUUID(),
            name: 'n9b.txt',
            mimeType: 'text/plain',
            size: bytes.length,
            sha256: bodySHA256(bytes),
          });
        } catch (error) {
          if (error instanceof Skip) filesUnavailable = true;
          throw error;
        }
        const minted = await json<FileInitResponse>(mintResponse);
        assert.equal(minted.uploadPath, target(['app', 'files', minted.fileId]));
        for (const payload of [bytes, bytes, Buffer.alloc(bytes.length, 120)]) {
          const r = await raw('PUT', minted.uploadPath, payload, 'HeyDan-Ticket ' + minted.ticket);
          assert.equal(r.status, payload === bytes ? 204 : 400);
          if (payload === bytes) assert.equal(await r.text(), '');
          else assert.equal((await r.json()).error, 'bad_body');
        }
        await reached((await send('reply n9b upload', [minted.fileId])).message);
      });
      await check('download-files', async () => {
        if (filesUnavailable) throw new Skip('File routes: 501 not_implemented');
        const start = events().length;
        await reached((await send('file')).message);
        await until(
          () =>
            new Set(
              events()
                .slice(start)
                .filter((e) => e.kind === 'message')
                .flatMap((e) => (e.data as unknown as Message).files)
                .map((f) => f.id),
            ).size >= 2,
        );
        const files = events()
          .slice(start)
          .filter((e) => e.kind === 'message')
          .flatMap((e) => (e.data as unknown as Message).files);
        const unique = [...new Map(files.map((f) => [f.id, f])).values()];
        assert.equal(unique.length, 2);
        for (const f of unique) {
          const r = await request(requirePair(), 'GET', target(['app', 'files', f.id]));
          assert(r.ok);
          assert.equal((await r.arrayBuffer()).byteLength, f.size);
          if (f.mimeType === 'image/png') {
            assert.equal(f.kind, 'image');
            assert(f.width! > 0 && f.height! > 0);
          }
        }
        assert(unique.some((f) => f.mimeType === 'image/png'));
      });
    }
    if (['all', 'security'].includes(scenario)) {
      await check('security-replay', async () => {
        const d = requirePair(),
          t = '/app/conversations',
          auth = signRequest({ ...d, method: 'GET', target: t });
        assert((await raw('GET', t, undefined, auth)).ok);
        const r = await raw('GET', t, undefined, auth);
        assert.equal(r.status, 401);
        assert.equal((await r.json()).error, 'replayed');
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
        assert.equal(r.status, 400);
        assert.equal((await r.json()).error, 'bad_body');
      });
      await check('security-clock', async () => {
        const d = requirePair();
        const r = await request(d, 'GET', '/app/conversations', undefined, Math.floor(Date.now() / 1000) - 300);
        assert.equal(r.status, 401);
        const value = await r.json();
        assert.equal(value.error, 'stale_timestamp');
        assert((await request(d, 'GET', '/app/conversations', undefined, Math.floor(value.serverTime / 1000))).ok);
      });
      await check('security-pair-proof', async () => {
        requirePair();
        await pair(2, true);
      });
      await check('security-canonical', async () => {
        if (new URL(baseUrl).hostname !== '127.0.0.1.sslip.io') throw new Skip('Requires proxy chain');
        const t = '/app//conversations';
        const r = await raw('GET', t, undefined, signRequest({ ...requirePair(), method: 'GET', target: t }));
        assert.equal(r.status, 401);
        assert.equal((await r.json()).error, 'bad_signature');
      });
      await check('security-revoke', async () => {
        conv();
        const disposable = await pair(3);
        const opened = await stream(disposable, live!.parser.cursor);
        assert.equal((await request(disposable, 'DELETE', '/app/devices/me')).status, 204);
        await Promise.race([
          revokedStreamClosed(opened.done),
          delay(5000).then(() => {
            throw new Error('revocation stream deadline');
          }),
        ]);
        const r = await request(disposable, 'GET', '/app/conversations');
        assert.equal(r.status, 401);
        assert.equal((await r.json()).error, 'device_revoked');
      });
    }
  } finally {
    for (const s of streams) s.stop();
    await Promise.allSettled(streams.map((s) => s.done));
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
  if (values.help)
    console.log('Usage: app-client.ts <pair|send|stream|upload|security|all> --base <url> [--remote --agent <name>]');
  else
    runAppClient(values.base ?? 'http://127.0.0.1:5000', process.env.LOCAL_RUN_DIR ?? '.local/app-client/run', {
      scenario: positionals[0],
      remote: values.remote,
      agent: values.agent,
    }).catch(() => {
      console.error('Client checks failed; see run results (payload withheld)');
      process.exitCode = 1;
    });
}
