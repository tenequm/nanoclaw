import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StreamParser, guard, target, revokedStreamClosed, runAppClient } from './app-client.js';
import { bodySHA256 } from '../src/channels/app/contract.js';
const fixture = JSON.parse(
  readFileSync(new URL('../src/channels/app/app-contract.fixtures.json', import.meta.url), 'utf8'),
);

describe('stream byte framing', () => {
  for (const size of [1, 7, 4096])
    it(`replays fixture in ${size} byte chunks`, () => {
      const kinds: string[] = [];
      let synchronized = 0;
      const parser = new StreamParser(0, (event) => {
        kinds.push(event.kind);
        if (event.kind === 'synchronized') synchronized = parser.cursor;
      });
      const bytes = Buffer.from(fixture.stream.raw);
      for (let i = 0; i < bytes.length; i += size) parser.feed(bytes.subarray(i, i + size));
      expect(kinds).toEqual(fixture.stream.expect.kindsInOrder);
      expect(synchronized).toBe(fixture.stream.expect.cursorAtSynchronized);
      expect(parser.cursor).toBe(fixture.stream.expect.cursorAfter);
    });
  it('preserves UTF-8 split inside a character and ignores badge ids', () => {
    const values: unknown[] = [];
    const parser = new StreamParser(4, (e) => values.push(e.data));
    const bytes = Buffer.from(
      'event: message\nid: 5\ndata: {"text":"кіт"}\n\nevent: status\nid: 90\ndata: {}\n\nevent: badge\nid: 99\ndata: {}\n\n',
    );
    for (const byte of bytes) parser.feed(Uint8Array.of(byte));
    expect(values[0]).toEqual({ text: 'кіт' });
    expect(parser.cursor).toBe(5);
  });
  it('never commits an incomplete event', () => {
    const parser = new StreamParser(3, () => {});
    parser.feed(Buffer.from('id: 4\nevent: weather\ndata: {}\n'));
    expect(parser.cursor).toBe(3);
    parser.feed(Buffer.from('\n'));
    expect(parser.cursor).toBe(4);
  });
});
describe('canonical targets', () => {
  it('builds the encoded fixture target', () => {
    expect(
      target(
        ['app', 'conversations', 'conv_taylor01', 'voices'],
        [
          ['provider', 'gemini'],
          ['q', 'кіт cat'],
          ['limit', '20'],
        ],
      ),
    ).toBe(fixture.signing.vectors.find((v: { name: string }) => v.name === 'get-encoded-query').target);
  });
  it('rejects noncanonical segments', () => {
    for (const segment of ['', '.', '..', 'x;y']) expect(() => target(['app', segment])).toThrow();
  });
});
describe('remote guard', () => {
  it('requires remote opt-in and an explicit allowed agent', () => {
    expect(() => guard('https://example.com', false)).toThrow();
    expect(() => guard('https://example.com', true)).toThrow();
    expect(() => guard('https://example.com', true, 'Alex', 'Sam')).toThrow();
    expect(() => guard('https://example.com', true, 'Sam', 'Sam')).not.toThrow();
  });
  it('permits only explicit loopback hosts without opt-in', () => {
    for (const base of ['http://127.0.0.1:5000', 'https://127.0.0.1.sslip.io:5006', 'http://[::1]:5000'])
      expect(() => guard(base, false, 'Local test')).not.toThrow();
    for (const base of [
      'https://evil.localhost',
      'https://127.0.0.1.sslip.io.evil.test',
      'https://user:pass@127.0.0.1',
    ])
      expect(() => guard(base, false)).toThrow();
  });
});

interface FakeOptions {
  cursorShift?: number;
  readNoop?: boolean;
  changedBytesStatus?: number;
}
type Entity = Record<string, unknown> & { kind: string; seq: number };

// Just enough of the app server for the stream and upload scenarios; signatures are not verified.
async function fakeApp(options: FakeOptions = {}) {
  const agent = { id: 'ag_taylor', name: 'Taylor' };
  const conversationId = 'conv_taylor01';
  const log: Entity[] = [];
  const open = new Set<ServerResponse>();
  const downloads: Record<string, number> = { file_txt: 5, file_png: 8 };
  let seq = 0,
    order = 0,
    readOrder = 0,
    devices = 0,
    uploadSha = '';
  const unread = () => log.filter((e) => e.role === 'agent' && Number(e.order) > readOrder).length;
  const badge = () => ({ kind: 'badge', rev: seq, unreadTotal: unread() });
  const frame = (kind: string, data: unknown, id?: number) =>
    `event: ${kind}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;
  const broadcast = (text: string) => {
    for (const res of open) res.write(text);
  };
  const append = (entity: Record<string, unknown>) => {
    const e = { ...entity, seq: ++seq } as Entity;
    log.push(e);
    broadcast(frame(e.kind, e, e.seq));
  };
  const message = (role: string, text: string, extra: Record<string, unknown> = {}) => {
    const n = ++order;
    return {
      kind: 'message',
      id: `msg_${n}`,
      order: n,
      role,
      text,
      files: [],
      ...extra,
    };
  };
  for (const text of ['One', 'Two', 'Three']) append(message('agent', text));
  const conversation = () => ({ id: conversationId, agent, readOrder });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, 'http://fake');
    const reply = (status: number, value?: unknown) => {
      res.writeHead(status, value === undefined ? {} : { 'Content-Type': 'application/json' });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const route = `${req.method} ${url.pathname}`;
    if (route === 'POST /app/pair')
      return reply(200, { deviceId: `dev_${++devices}`, userName: 'Alex', agents: [agent], protocol: 1 });
    if (route === 'GET /app/conversations')
      return reply(200, { conversations: [conversation()], statuses: [], badge: badge(), seq });
    if (route === 'GET /app/events') {
      const after = Number(url.searchParams.get('after'));
      const from = after > 0 ? after + (options.cursorShift ?? 0) : 0;
      const frames = [
        ...log.filter((e) => e.seq > from).map((e) => frame(e.kind, e, e.seq)),
        frame('status', { kind: 'status', conversationId, state: 'idle', label: null }),
        frame('badge', badge()),
        frame('synchronized', { seq }),
      ];
      const text = frames.join('');
      // Two whole events and part of a third in the first write, the rest in a later one.
      const split = frames.length > 4 ? frames[0].length + frames[1].length + 7 : text.length;
      let closed = false;
      res.on('close', () => {
        closed = true;
        open.delete(res);
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(text.slice(0, split));
      setTimeout(() => {
        if (closed) return;
        res.write(text.slice(split));
        open.add(res);
      }, 20);
      return;
    }
    if (route === `POST /app/conversations/${conversationId}/messages`) {
      const { clientId, text } = JSON.parse(body.toString()) as { clientId: string; text: string };
      const sent = message('user', text, { clientId });
      reply(200, { message: { ...sent, seq: 0, delivery: 'stored' } });
      append({ ...sent, delivery: 'reached' });
      const files = [
        { id: 'file_txt', name: 'a.txt', mimeType: 'text/plain', size: 5, kind: 'file', width: null, height: null },
        { id: 'file_png', name: 'a.png', mimeType: 'image/png', size: 8, kind: 'image', width: 1, height: 1 },
      ];
      append(message('agent', 'Done.', text === 'file' ? { files } : {}));
      return broadcast(frame('badge', badge()));
    }
    if (route === `POST /app/conversations/${conversationId}/read`) {
      const { order: requested } = JSON.parse(body.toString()) as { order: number };
      if (!options.readNoop) readOrder = Math.max(readOrder, Math.min(requested, order));
      broadcast(frame('badge', badge()));
      return reply(200, { conversation: conversation(), badge: badge() });
    }
    if (route === 'POST /app/files') {
      uploadSha = (JSON.parse(body.toString()) as { sha256: string }).sha256;
      return reply(200, { fileId: 'file_up', ticket: 'ticket_up', expiresAt: 0, uploadPath: '/app/files/file_up' });
    }
    if (route === 'PUT /app/files/file_up') {
      if (bodySHA256(body) === uploadSha) return reply(204);
      const status = options.changedBytesStatus ?? 400;
      return reply(status, { error: status === 400 ? 'bad_body' : 'conflict' });
    }
    const size = req.method === 'GET' ? downloads[url.pathname.replace('/app/files/', '')] : undefined;
    if (size === undefined) return reply(404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.alloc(size));
  }
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function runAgainstFake(scenario: string, fake: FakeOptions = {}) {
  const app = await fakeApp(fake);
  const directory = mkdtempSync(join(tmpdir(), 'app-client-'));
  vi.stubEnv('HEYDAN_PAIR_LINK', `${app.base}/app/pair#code-one`);
  vi.stubEnv('HEYDAN_PAIR_LINK_SECOND', `${app.base}/app/pair#code-two`);
  try {
    const outcome = await runAppClient(app.base, directory, { scenario, deviceDir: join(directory, 'devices') }).then(
      () => 'resolved',
      () => 'rejected',
    );
    const results: Record<string, { status: string; detail: string }> = {};
    for (const file of readdirSync(join(directory, 'results'))) {
      const result = JSON.parse(readFileSync(join(directory, 'results', file), 'utf8'));
      results[result.id.replace('app-client-direct-', '')] = result;
    }
    return { outcome, results };
  } finally {
    vi.unstubAllEnvs();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('scenarios against an in-process server', () => {
  it('resumes a replay split across writes and proves the read on the other device', async () => {
    const { outcome, results } = await runAgainstFake('stream');
    expect(outcome).toBe('resolved');
    expect(results['stream-resume'].status).toBe('pass');
    expect(results['read-other-device'].status).toBe('pass');
  });
  it.each([
    [-1, 'duplicate_events'],
    [1, 'replay_mismatch'],
  ])('fails stream-resume when the server resumes %i off the cursor', async (cursorShift, detail) => {
    const { outcome, results } = await runAgainstFake('stream', { cursorShift });
    expect(outcome).toBe('rejected');
    expect(results['stream-resume']).toMatchObject({ status: 'fail', detail });
  });
  it('fails read-other-device when the read leaves unread unchanged', async () => {
    const { results } = await runAgainstFake('stream', { readNoop: true });
    expect(results['read-other-device']).toMatchObject({ status: 'fail', detail: 'unread_not_lowered' });
  });
  it('uploads, accepts the same bytes again, refuses other bytes and downloads agent files', async () => {
    const { outcome, results } = await runAgainstFake('upload');
    expect(outcome).toBe('resolved');
    expect(results.upload.status).toBe('pass');
    expect(results['download-files'].status).toBe('pass');
  });
  it('names the PUT that answered the wrong status', async () => {
    const { results } = await runAgainstFake('upload', { changedBytesStatus: 409 });
    expect(results.upload).toMatchObject({ status: 'fail', detail: 'status_mismatch:put-3' });
  });
});

it('refuses a remote base without --remote before any request', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const directory = mkdtempSync(join(tmpdir(), 'app-client-'));
  try {
    await expect(runAppClient('https://example.com', directory)).rejects.toThrow('Client guard refused');
    const files = readdirSync(join(directory, 'results'));
    expect(files).toEqual(['app-client-remote-guard.json']);
    expect(JSON.parse(readFileSync(join(directory, 'results', files[0]), 'utf8'))).toMatchObject({
      title: 'remote guard',
      status: 'fail',
      detail: 'remote base requires --remote',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('stops mid-chunk and resumes without losing or duplicating versions', () => {
  const wire = Buffer.from(
    'event: message\nid: 1\ndata: {}\n\nevent: message\nid: 2\ndata: {}\n\nevent: synchronized\ndata: {"seq":2}\n\n',
  );
  const seen: number[] = [];
  const cut = new StreamParser(0, (e) => {
    seen.push(e.id!);
    cut.stop();
  });
  cut.feed(wire);
  cut.feed(wire);
  expect(cut.cursor).toBe(1);
  expect(seen).toEqual([1]);
  const resumed = new StreamParser(cut.cursor, (e) => {
    if (e.id) seen.push(e.id);
  });
  resumed.feed(wire.subarray(wire.indexOf('event: message', 1)));
  expect(seen).toEqual([1, 2]);
  expect(resumed.cursor).toBe(2);
});

it('accepts a revoked socket closing but propagates parser failures', async () => {
  await expect(revokedStreamClosed(Promise.resolve())).resolves.toBeUndefined();
  await expect(
    revokedStreamClosed(Promise.reject(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }))),
  ).resolves.toBeUndefined();
  await expect(revokedStreamClosed(Promise.reject(new SyntaxError('bad event')))).rejects.toThrow('bad event');
});
