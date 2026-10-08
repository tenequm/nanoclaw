/**
 * The host's mailbox endpoint: one POST route that authenticates a session,
 * opens its existing SQLite files and runs a batch of runner operations.
 *
 * Wire format (protocol 1):
 *   POST /mailbox/v1
 *   authorization: Bearer <per-session token>
 *   x-nanoclaw-agent-group: <agentGroupId>
 *   x-nanoclaw-session: <sessionId>
 *   { "ops": [{ "op": "<name>", "args": [...] }, ...] }
 * -> 200 { "results": [...] } once the batch has committed, or
 * -> 4xx/5xx { "error": { "code", "message" } } with nothing committed.
 */
import fs from 'fs';
import http from 'http';

import Database from 'better-sqlite3';

import { log } from '../../log.js';
import { openOutboundDbRw } from '../sqlite/session-db.js';
import type { MailboxSessionKey } from '../types.js';
import { ensureRunnerOutboundTables, executeRunnerOps, MailboxRequestError, type RunnerOpCall } from './runner-ops.js';

export const MAILBOX_HTTP_PATH = '/mailbox/v1';
export const MAILBOX_HTTP_PROTOCOL = 1;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

interface MailboxHttpServerOptions {
  /** Side-effect-free probe; a session without storage is a 404, never provisioned here. */
  exists(key: MailboxSessionKey): Promise<boolean>;
  verifyToken(key: MailboxSessionKey, token: string): boolean;
  paths(key: MailboxSessionKey): { inbound: string; outbound: string; heartbeat: string };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? undefined : value;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_request', 'request body is not JSON');
  }
}

function parseCalls(body: unknown): RunnerOpCall[] {
  const ops = (body as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops) || ops.length === 0) throw new HttpError(400, 'bad_request', 'ops must be a non-empty array');
  return ops.map((call: { op?: unknown; args?: unknown }) => {
    if (typeof call?.op !== 'string') throw new HttpError(400, 'bad_request', 'op must be a string');
    if (call.args !== undefined && !Array.isArray(call.args)) {
      throw new HttpError(400, 'bad_request', 'args must be an array');
    }
    return { op: call.op, args: (call.args as unknown[] | undefined) ?? [] };
  });
}

/**
 * The heartbeat file sits in the directory the container mounts read-write, so
 * never follow a link the agent planted there. Best effort: a missing beat is
 * the sweep's business, not a reason to fail the batch.
 */
function touch(file: string): void {
  const now = new Date();
  try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o644);
    try {
      fs.futimesSync(fd, now, now);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    log.warn('Mailbox heartbeat touch failed', { file, err });
  }
}

export function createMailboxHttpServer(options: MailboxHttpServerOptions): http.Server {
  const prepared = new Set<string>();

  async function handle(req: http.IncomingMessage): Promise<unknown> {
    if (req.url !== MAILBOX_HTTP_PATH) throw new HttpError(404, 'not_found', 'unknown path');
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'POST only');

    const agentGroupId = header(req, 'x-nanoclaw-agent-group');
    const sessionId = header(req, 'x-nanoclaw-session');
    const token = /^Bearer (\S+)$/.exec(header(req, 'authorization') ?? '')?.[1];
    // Ids become path segments below, so anything path-like is refused before any lookup.
    if (!agentGroupId || !sessionId || !SAFE_ID.test(agentGroupId) || !SAFE_ID.test(sessionId) || !token) {
      throw new HttpError(401, 'unauthorized', 'missing or malformed session credentials');
    }
    const key = { agentGroupId, sessionId };
    if (!options.verifyToken(key, token)) throw new HttpError(401, 'unauthorized', 'session token mismatch');

    const calls = parseCalls(await readBody(req));
    if (!(await options.exists(key))) throw new HttpError(404, 'no_mailbox', 'session mailbox is not prepared');

    const paths = options.paths(key);
    const inbound = new Database(paths.inbound, { readonly: true });
    let outbound: Database.Database | undefined;
    try {
      inbound.pragma('busy_timeout = 5000');
      outbound = openOutboundDbRw(paths.outbound, { fileMustExist: true });
      if (!prepared.has(paths.outbound)) {
        ensureRunnerOutboundTables(outbound);
        prepared.add(paths.outbound);
      }
      return executeRunnerOps({ inbound, outbound, touchHeartbeat: () => touch(paths.heartbeat) }, calls);
    } finally {
      inbound.close();
      outbound?.close();
    }
  }

  return http.createServer((req, res) => {
    handle(req).then(
      (results) => send(res, 200, { results }),
      (err: unknown) => {
        if (err instanceof HttpError) {
          send(res, err.status, { error: { code: err.code, message: err.message } });
        } else if (err instanceof MailboxRequestError) {
          send(res, 400, { error: { code: 'bad_request', message: err.message } });
        } else {
          log.error('Mailbox HTTP request failed', { err });
          send(res, 500, { error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } });
        }
      },
    );
  });
}
