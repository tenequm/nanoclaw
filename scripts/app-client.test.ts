import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { StreamParser, guard, target } from './app-client.js';
import { signRequest } from './app-sign.js';
import { canonicalSigningText, parseAuthorization, verifyRequestSignature } from '../src/channels/app/contract.js';
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
describe('canonical targets and signing', () => {
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
  for (const vector of fixture.signing.vectors)
    it(vector.name, () => {
      expect(verifyRequestSignature(vector, vector.signature, fixture.testKey.publicKeySpki)).toBe(
        vector.signatureValid,
      );
      const auth = parseAuthorization(
        signRequest({
          privateKey: fixture.testKey.privateKeyPkcs8Pem,
          deviceId: vector.deviceId,
          method: vector.method,
          target: vector.target,
          body: Buffer.from(vector.body),
          protocol: vector.protocol,
          ts: vector.ts,
          nonce: vector.nonce,
        }),
      )!;
      expect(canonicalSigningText({ ...auth, method: vector.method, target: vector.target })).toBe(
        canonicalSigningText(vector),
      );
      expect(
        verifyRequestSignature(
          { ...auth, method: vector.method, target: vector.target },
          auth.signature,
          fixture.testKey.publicKeySpki,
        ),
      ).toBe(true);
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

it('records every scenario as skipped when pairing is a 501 stub', async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runAppClient } = await import('./app-client.js');
  const server = createServer((_req, res) => {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_implemented', message: 'private payload sentinel' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const directory = mkdtempSync(join(tmpdir(), 'n9b-stub-'));
  vi.stubEnv('HEYDAN_PAIR_LINK', `http://127.0.0.1:${address.port}/app/pair#test-code`);
  try {
    await runAppClient(`http://127.0.0.1:${address.port}`, directory, { deviceDir: join(directory, 'devices') });
    const results = readdirSync(join(directory, 'results')).map((file) =>
      JSON.parse(readFileSync(join(directory, 'results', file), 'utf8')),
    );
    expect(results.find((r) => r.id === 'n9b-direct-pair').status).toBe('skip');
    expect(results.filter((r) => r.id !== 'n9b-direct-guard').every((r) => r.status === 'skip')).toBe(true);
    expect(results.some((r) => r.id === 'n9b-direct-security-revoke')).toBe(true);
    expect(readFileSync(join(directory, 'logs/n9b-client.log'), 'utf8')).not.toContain('private payload sentinel');
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
