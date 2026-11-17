import http from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { registerRootHandler, stopWebhookServer } from '../../webhook-server.js';

afterEach(async () => {
  await stopWebhookServer();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('configures uploads and keepalive and lets a stream outlive the receive timeout', async () => {
  vi.stubEnv('WEBHOOK_PORT', '4501');
  vi.stubEnv('WEBHOOK_HOST', '127.0.0.1');
  const original = http.createServer;
  const spy = vi.spyOn(http, 'createServer').mockImplementation((...args: Parameters<typeof http.createServer>) => {
    const handler = typeof args[0] === 'function' ? args[0] : args[1];
    return original({ connectionsCheckingInterval: 5 }, handler);
  });
  registerRootHandler('n2b-timeout', async (req, res) => {
    if (req.method === 'POST') {
      for await (const _chunk of req) {
        /* Consume the deliberately slow upload. */
      }
      res.end('uploaded');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': start\n\n');
    setTimeout(() => res.end(': survived\n\n'), 1500);
  });
  const server = spy.mock.results[0].value as http.Server;
  if (!server.listening) await once(server, 'listening');
  expect(server.requestTimeout).toBe(900_000);
  expect(server.keepAliveTimeout).toBe(95_000);
  expect(server.headersTimeout).toBe(60_000);
  // Scale the old 300 s boundary to 300 ms and the new 900 s boundary to 900 ms.
  server.requestTimeout = 900;
  server.headersTimeout = 900;
  const upload = new Promise<string>((resolve, reject) => {
    const request = http.request(
      'http://127.0.0.1:4501/n2b-timeout',
      { method: 'POST', headers: { 'Content-Length': 2 } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
      },
    );
    request.on('error', reject);
    request.write('a');
    setTimeout(() => request.end('b'), 450);
  });
  expect(await upload).toBe('uploaded');
  expect(await (await fetch('http://127.0.0.1:4501/n2b-timeout')).text()).toContain('survived');
});

it('shuts down promptly with a streaming response and an incomplete HTTP request', async () => {
  vi.stubEnv('WEBHOOK_PORT', '4501');
  vi.stubEnv('WEBHOOK_HOST', '127.0.0.1');
  const spy = vi.spyOn(http, 'createServer');
  registerRootHandler('n2b-shutdown', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': open\n\n');
  });
  const server = spy.mock.results[0].value as http.Server;
  if (!server.listening) await once(server, 'listening');
  const incomplete = connect(4501, '127.0.0.1');
  await once(incomplete, 'connect');
  incomplete.write('GET /n2b-shutdown HTTP/1.1\r\n');
  const response = await fetch('http://127.0.0.1:4501/n2b-shutdown');
  const reader = response.body!.getReader();
  await reader.read();
  try {
    await stopWebhookServer();
    expect(server.listening).toBe(false);
  } finally {
    incomplete.destroy();
    await reader.cancel().catch(() => {});
  }
});
