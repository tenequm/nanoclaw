/**
 * The upgrade half of src/webhook-server.ts: registerUpgradeHandler on the REAL shared server
 * (ephemeral WEBHOOK_PORT, a real `ws` client). Until a handler is registered an upgrade still
 * reaches the request routes; after, a registered segment owns its sockets, any other segment is
 * refused with 404, request routes are untouched, and stopWebhookServer does not wait on open
 * websockets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import { allocateFreePort } from './test-utils/free-port.js';
import { registerRootHandler, registerUpgradeHandler, stopWebhookServer } from './webhook-server.js';

let PORT: number;

beforeAll(async () => {
  PORT = await allocateFreePort();
  process.env.WEBHOOK_PORT = String(PORT);
  process.env.WEBHOOK_HOST = '127.0.0.1';
});

afterAll(async () => {
  await stopWebhookServer();
  delete process.env.WEBHOOK_PORT;
  delete process.env.WEBHOOK_HOST;
});

type Outcome = { open: WebSocket } | { status: number } | { error: string };

/** Connects, retrying while the lazily started server is not listening yet. */
async function connect(path: string): Promise<Outcome> {
  for (let attempt = 0; ; attempt++) {
    const outcome = await new Promise<Outcome>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
      ws.once('open', () => resolve({ open: ws }));
      ws.once('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode ?? 0 });
        ws.terminate();
      });
      ws.once('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? err.message }));
    });
    if ('error' in outcome && outcome.error === 'ECONNREFUSED' && attempt < 40) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    return outcome;
  }
}

describe('webhook server upgrade routes', () => {
  it('leaves upgrades to the request routes until an upgrade handler is registered', async () => {
    registerRootHandler('page', (_req, res) => {
      res.writeHead(418, { 'Content-Type': 'text/plain' });
      res.end('teapot');
    });
    expect(await connect('/page/x')).toEqual({ status: 418 });
    expect(await connect('/nowhere')).toEqual({ status: 404 });
  });

  it('hands a registered segment its upgrades, with the original URL', async () => {
    const wss = new WebSocketServer({ noServer: true });
    const urls: string[] = [];
    registerUpgradeHandler('live', (req, socket, head) => {
      urls.push(req.url ?? '');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data) => ws.send(`echo:${String(data)}`));
      });
    });

    const outcome = await connect('/live/call-1/?token=abc');
    if (!('open' in outcome)) throw new Error(`no websocket: ${JSON.stringify(outcome)}`);
    const reply = new Promise<string>((resolve) => outcome.open.once('message', (d) => resolve(String(d))));
    outcome.open.send('hi');
    expect(await reply).toBe('echo:hi');
    expect(urls).toEqual(['/live/call-1/?token=abc']);
    outcome.open.close();
  });

  it('refuses an upgrade to any other segment with 404, and request routes still answer', async () => {
    expect(await connect('/page/x')).toEqual({ status: 404 });
    expect(await connect('/webhook/anything')).toEqual({ status: 404 });
    const res = await fetch(`http://127.0.0.1:${PORT}/page/x`);
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('teapot');
  });

  it('destroys the socket when the handler throws', async () => {
    registerUpgradeHandler('boom', () => {
      throw new Error('handler exploded');
    });
    const outcome = await connect('/boom');
    expect('error' in outcome).toBe(true);
  });

  it('rejects reserved and malformed segments', () => {
    const noop = () => {};
    expect(() => registerUpgradeHandler('webhook', noop)).toThrow(/Invalid upgrade route segment/);
    expect(() => registerUpgradeHandler('a/b', noop)).toThrow(/Invalid upgrade route segment/);
    expect(() => registerUpgradeHandler('', noop)).toThrow(/Invalid upgrade route segment/);
  });

  it('stops without waiting for an open websocket, closing it', async () => {
    const outcome = await connect('/live/call-2');
    if (!('open' in outcome)) throw new Error(`no websocket: ${JSON.stringify(outcome)}`);
    const closed = new Promise<void>((resolve) => outcome.open.once('close', () => resolve()));
    await stopWebhookServer();
    await closed;
  });
});
