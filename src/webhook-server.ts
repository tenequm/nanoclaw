/**
 * Minimal HTTP server for Chat SDK adapter webhooks.
 *
 * Starts lazily on first adapter registration. Routes requests by path:
 *   /{segment}[/...]       -> raw handler from registerRootHandler(segment, ...)
 *   /webhook/{adapterName} → chat.webhooks[adapterName](request)
 *   /webhook/{path}        → raw handler from registerWebhookHandler(path, ...)
 *   upgrade /{segment}[/...] -> handler from registerUpgradeHandler(segment, ...)
 *
 * Multiple Chat instances can register adapters — each adapter name maps
 * to its owning Chat instance. Raw routes let modules receive non-Chat-SDK
 * webhooks (GitHub, payment providers, health checks) on the same server
 * without editing this file or opening a second port.
 *
 * Listens on WEBHOOK_HOST (default 127.0.0.1) and WEBHOOK_PORT (default 3000).
 */
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';

import type { Chat } from 'chat';

import { getWebhookHost, getWebhookPort } from './config.js';
import { log } from './log.js';

interface WebhookEntry {
  chat: Chat;
  adapterName: string;
}

/** Node-style handler for raw (non-Chat-SDK) webhook routes. */
export type RawWebhookHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

const routes = new Map<string, WebhookEntry>();
const rawRoutes = new Map<string, RawWebhookHandler>();
const rootRoutes = new Map<string, RawWebhookHandler>();
/** Owns the socket of an HTTP upgrade (a websocket) from the first byte; `head` is what was read past the headers. */
export type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
const upgradeRoutes = new Map<string, UpgradeHandler>();
/** Sockets handed to upgrade handlers: server.close() waits for every connection, and a websocket stays open. */
const upgradedSockets = new Set<Duplex>();
let server: http.Server | null = null;
let listenerId: string | null = null;

/** Report only a successfully bound listener owned by this host process. */
export function getWebhookStatus(): { id: string; host: string; port: number; paths: string[] } | null {
  const address = server?.address();
  if (!server?.listening || !address || typeof address === 'string' || !listenerId) return null;
  return {
    id: listenerId,
    host: address.address,
    port: address.port,
    paths: [
      ...[...new Set([...routes.keys(), ...rawRoutes.keys()])].map((p) => `/webhook/${p}`),
      ...[...rootRoutes.keys()].map((s) => `/${s}`),
    ],
  };
}

/** A request URL for a log line: the path only, since a query can carry a credential (`?token=`). */
function loggedPath(url: string | undefined): string {
  return (url || '/').split(/[?#]/, 1)[0];
}

/** Convert Node.js IncomingMessage to a Web API Request. */
async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  const host = req.headers.host || 'localhost';
  const url = `http://${host}${req.url}`;

  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (typeof val === 'string') headers[key] = val;
    else if (Array.isArray(val)) headers[key] = val.join(', ');
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method || 'GET',
    headers,
    body: hasBody ? body : undefined,
  });
}

/** Write a Web API Response back to a Node.js ServerResponse. */
async function fromWebResponse(webRes: Response, nodeRes: http.ServerResponse): Promise<void> {
  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  if (webRes.body) {
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  nodeRes.end();
}

/**
 * Register a webhook adapter on the shared server.
 * Starts the server lazily on first call.
 *
 * `routingPath` is the URL segment (`/webhook/<routingPath>`); `adapterName`
 * stays the handler key into `chat.webhooks`. The split lets N instances of
 * one platform (each with its own Chat + signing secret) listen on distinct
 * URLs while dispatching to the same SDK adapter name. Defaulting
 * routingPath to adapterName keeps the historical single-instance route
 * byte-identical. Signature adopted verbatim from PR #2617 (@davekim917's
 * #1804 prototype) so the two changes converge textually.
 */
export function registerWebhookAdapter(chat: Chat, adapterName: string, routingPath: string = adapterName): void {
  routes.set(routingPath, { chat, adapterName });
  ensureServer();
  log.info('Webhook adapter registered', { adapter: adapterName, path: `/webhook/${routingPath}` });
}

/**
 * Register a raw Node-style handler at /webhook/{path} on the shared server.
 *
 * For webhooks that don't flow through a Chat SDK adapter (GitHub, payment
 * providers, health checks): modules register their endpoint here instead of
 * editing this file or standing up a second HTTP server on another port.
 * The handler owns the request/response directly.
 *
 * Starts the server lazily on first call.
 */
export function registerWebhookHandler(path: string, handler: RawWebhookHandler): void {
  rawRoutes.set(path, handler);
  ensureServer();
  log.info('Webhook handler registered', { path: `/webhook/${path}` });
}

/**
 * Register a raw handler at /{segment} and every path below it, outside /webhook: for
 * browser-facing pages a reverse proxy forwards by a short path prefix. The handler sees the
 * original URL. `webhook` is reserved.
 *
 * Starts the server lazily on first call.
 */
export function registerRootHandler(segment: string, handler: RawWebhookHandler): void {
  if (segment === 'webhook' || !/^[^/?#]+$/.test(segment)) throw new Error(`Invalid root route segment: ${segment}`);
  rootRoutes.set(segment, handler);
  ensureServer();
  log.info('Root handler registered', { path: `/${segment}` });
}

/**
 * Register an upgrade handler at /{segment} and every path below it; the handler owns the socket.
 * The server listens for upgrades only once one is registered: until then an upgrade request
 * reaches the request routes as it always has. After that, an upgrade to any other segment is
 * answered 404 and its socket destroyed.
 *
 * Starts the server lazily on first call.
 */
export function registerUpgradeHandler(segment: string, handler: UpgradeHandler): void {
  if (segment === 'webhook' || !/^[^/?#]+$/.test(segment)) throw new Error(`Invalid upgrade route segment: ${segment}`);
  upgradeRoutes.set(segment, handler);
  ensureServer();
  if (server && server.listenerCount('upgrade') === 0) server.on('upgrade', dispatchUpgrade);
  log.info('Upgrade handler registered', { path: `/${segment}` });
}

function dispatchUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  // Node detaches its own socket listeners on upgrade; an unhandled 'error' would crash the host.
  socket.on('error', (err) => log.debug('Upgrade socket error', { path: loggedPath(req.url), err }));
  const segment = (req.url || '/').match(/^\/([^/?#]+)/)?.[1];
  const handler = segment === undefined ? undefined : upgradeRoutes.get(segment);
  if (!handler) {
    socket.once('finish', () => socket.destroy());
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  upgradedSockets.add(socket);
  socket.once('close', () => upgradedSockets.delete(socket));
  try {
    handler(req, socket, head);
  } catch (err) {
    log.error('Upgrade handler error', { path: loggedPath(req.url), err });
    socket.destroy();
  }
}

function ensureServer(): void {
  if (server) return;

  const host = getWebhookHost();
  const port = getWebhookPort();
  const id = randomUUID();

  const candidate = http.createServer((req, res) => {
    res.setHeader('x-nanoclaw-webhook-id', id);
    void (async () => {
      const url = req.url || '/';

      // Route: /webhook/{adapterName}, else a root route /{segment}
      const match = url.match(/^\/webhook\/([^/?]+)/);
      const segment = match ? undefined : url.match(/^\/([^/?#]+)/)?.[1];
      const rootHandler = segment === undefined ? undefined : rootRoutes.get(segment);
      if (!match && !rootHandler) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const adapterName = match?.[1] ?? segment ?? '';

      try {
        // Raw routes take priority — the handler writes the response itself.
        const rawHandler = rootHandler ?? rawRoutes.get(adapterName);
        if (rawHandler) {
          await rawHandler(req, res);
          return;
        }

        const entry = routes.get(adapterName);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }

        const webReq = await toWebRequest(req);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const webhooks = entry.chat.webhooks as Record<string, (r: Request, opts?: any) => Promise<Response>>;
        const handler = webhooks[entry.adapterName];
        const webRes = await handler(webReq, {
          waitUntil: (p: Promise<unknown>) => {
            void p.catch(() => {});
          },
        });
        await fromWebResponse(webRes, res);
      } catch (err) {
        log.error('Webhook handler error', { adapter: adapterName, path: loggedPath(req.url), err });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      }
    })();
  });

  // Keep the candidate as the singleton while listen is pending so concurrent
  // registrations cannot create competing listeners. A failed listen must
  // release that singleton, though, or later registrations can never retry.
  server = candidate;
  listenerId = id;
  if (upgradeRoutes.size > 0) candidate.on('upgrade', dispatchUpgrade);
  candidate.on('error', (err) => {
    if (!candidate.listening && server === candidate) server = null;
    log.error('Webhook server error', { host, port, err });
  });

  candidate.listen(port, host, () => {
    log.info('Webhook server started', { host, port, adapters: [...routes.keys()] });
  });
}

/** Shut down the webhook server. */
export async function stopWebhookServer(): Promise<void> {
  if (server) {
    const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
    for (const socket of upgradedSockets) socket.destroy();
    upgradedSockets.clear();
    await closed;
    server = null;
    routes.clear();
    rawRoutes.clear();
    rootRoutes.clear();
    upgradeRoutes.clear();
    log.info('Webhook server stopped');
  }
}
