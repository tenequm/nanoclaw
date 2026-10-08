/**
 * HTTP mailbox transport, host side.
 *
 * Storage stays the SQLite mailbox, unchanged: every AgentMailbox method
 * delegates to an internal SqliteAgentMailbox. What this adds is the runner's
 * path to that storage — containers call one host endpoint instead of opening
 * inbound.db/outbound.db — and the runner context that points them at it.
 *
 * NANOCLAW_MAILBOX_TRANSPORT=sqlite (process env or .env) turns the transport
 * off: runnerContext() goes back to the SQLite null sentinel and the server
 * never listens. That is the rollback; no image or data change is involved.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import type http from 'http';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { SqliteAgentMailbox } from '../sqlite/index.js';
import { sessionMailboxDir, sessionMailboxPath } from '../sqlite/paths.js';
import type { AgentMailbox, MailboxSession, MailboxSessionKey } from '../types.js';
import { createMailboxHttpServer, MAILBOX_HTTP_PATH, MAILBOX_HTTP_PROTOCOL } from './server.js';

const SETTINGS = [
  'NANOCLAW_MAILBOX_TRANSPORT',
  'NANOCLAW_MAILBOX_HTTP_BIND',
  'NANOCLAW_MAILBOX_HTTP_PORT',
  'NANOCLAW_MAILBOX_HTTP_URL',
] as const;
const DEFAULT_PORT = 3010;

export interface MailboxHttpSettings {
  transport: 'http' | 'sqlite';
  bind: string;
  port: number;
  /** Base URL containers use; the endpoint path is appended. */
  url: string;
}

/** What the runner receives in its session context's `mailbox` field. */
export interface HttpRunnerContext {
  transport: 'http';
  protocol: number;
  url: string;
  token: string;
}

/**
 * Bind address when none is configured: never 0.0.0.0. On Linux the Docker
 * bridge (docker0) address, which default-bridge containers reach and the LAN
 * does not; elsewhere (Docker Desktop) loopback, which host.docker.internal
 * forwards to.
 */
function defaultBind(): string {
  if (os.platform() !== 'linux') return '127.0.0.1';
  const bridge = os.networkInterfaces().docker0?.find((entry) => entry.family === 'IPv4');
  if (!bridge) {
    throw new Error('Mailbox HTTP transport: no docker0 IPv4 address; set NANOCLAW_MAILBOX_HTTP_BIND explicitly');
  }
  return bridge.address;
}

/** `process.env` wins, then `.env`, then the default — the driver settings' precedence. */
export function readMailboxHttpSettings(env: NodeJS.ProcessEnv = process.env): MailboxHttpSettings {
  const file = readEnvFile([...SETTINGS]);
  const setting = (key: (typeof SETTINGS)[number]) => env[key]?.trim() || file[key]?.trim() || '';
  const transport = (setting('NANOCLAW_MAILBOX_TRANSPORT') || 'http').toLowerCase();
  if (transport !== 'http' && transport !== 'sqlite') {
    throw new Error(`NANOCLAW_MAILBOX_TRANSPORT must be http or sqlite, got: ${transport}`);
  }
  const port = Number(setting('NANOCLAW_MAILBOX_HTTP_PORT') || DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`NANOCLAW_MAILBOX_HTTP_PORT is not a valid port: ${setting('NANOCLAW_MAILBOX_HTTP_PORT')}`);
  }
  const configuredBind = setting('NANOCLAW_MAILBOX_HTTP_BIND');
  // Resolved lazily: an sqlite-transport host never needs a bridge address.
  let bind = configuredBind;
  const resolveBind = () => (bind ||= defaultBind());
  const url = setting('NANOCLAW_MAILBOX_HTTP_URL').replace(/\/+$/, '');
  return {
    transport,
    port,
    get bind() {
      return resolveBind();
    },
    get url() {
      if (url) return url;
      // A specific bind address is itself reachable from containers on that
      // network (the docker0 address on bl); loopback/wildcard binds are reached
      // through Docker's host.docker.internal name.
      const host = resolveBind();
      const advertised = host === '127.0.0.1' || host === '0.0.0.0' || host === '::' ? 'host.docker.internal' : host;
      return `http://${advertised.includes(':') ? `[${advertised}]` : advertised}:${port}`;
    },
  };
}

/** Host-only token file: outside the session directory the container mounts read-write. */
function tokenPath(key: MailboxSessionKey): string {
  return path.join(DATA_DIR, 'v2-sessions', key.agentGroupId, '.mailbox-http', `${key.sessionId}.token`);
}

export class HttpServedAgentMailbox implements AgentMailbox {
  private readonly tokens = new Map<string, string>();
  private server: http.Server | undefined;
  private settingsCache: MailboxHttpSettings | undefined;

  constructor(
    private readonly delegate: SqliteAgentMailbox = new SqliteAgentMailbox(),
    private readonly settingsSource: () => MailboxHttpSettings = () => readMailboxHttpSettings(),
  ) {}

  private get settings(): MailboxHttpSettings {
    return (this.settingsCache ??= this.settingsSource());
  }

  exists(key: MailboxSessionKey): Promise<boolean> {
    return this.delegate.exists(key);
  }

  prepare(key: MailboxSessionKey): void {
    this.delegate.prepare(key);
  }

  async destroy(key: MailboxSessionKey): Promise<void> {
    this.tokens.delete(`${key.agentGroupId}/${key.sessionId}`);
    fs.rmSync(tokenPath(key), { force: true });
    await this.delegate.destroy(key);
  }

  session<T>(key: MailboxSessionKey, action: (mailbox: MailboxSession) => T | Promise<T>): Promise<T> {
    return this.delegate.session(key, action);
  }

  /**
   * A fresh token per spawn: the newest container of a session is the only one
   * the endpoint accepts, so a container the host replaced is fenced out.
   */
  async runnerContext(key: MailboxSessionKey): Promise<HttpRunnerContext | unknown> {
    if (this.settings.transport === 'sqlite') return this.delegate.runnerContext(key);
    const token = randomBytes(32).toString('hex');
    const file = tokenPath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, token, { mode: 0o600 });
    this.tokens.set(`${key.agentGroupId}/${key.sessionId}`, token);
    return {
      transport: 'http',
      protocol: MAILBOX_HTTP_PROTOCOL,
      url: `${this.settings.url}${MAILBOX_HTTP_PATH}`,
      token,
    } satisfies HttpRunnerContext;
  }

  /**
   * Nothing beyond the delegate's: the endpoint and token travel in the
   * runner context (host-written, 0600, mounted read-only), the one place the
   * runner reads its mailbox selection from. Environment stays secret-free.
   */
  runnerEnvironment(key: MailboxSessionKey): Promise<Record<string, string>> {
    return this.delegate.runnerEnvironment(key);
  }

  verifyToken(key: MailboxSessionKey, presented: string): boolean {
    const id = `${key.agentGroupId}/${key.sessionId}`;
    let expected = this.tokens.get(id);
    if (expected === undefined) {
      // After a host restart, adopted containers still hold the token written at their spawn.
      try {
        expected = fs.readFileSync(tokenPath(key), 'utf8');
      } catch {
        return false;
      }
      this.tokens.set(id, expected);
    }
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Start the endpoint (host startup). A no-op on the sqlite transport. */
  async listen(): Promise<void> {
    if (this.server || this.settings.transport === 'sqlite') return;
    const server = createMailboxHttpServer({
      exists: (key) => this.delegate.exists(key),
      verifyToken: (key, token) => this.verifyToken(key, token),
      paths: (key) => ({
        inbound: sessionMailboxPath(key, 'inbound'),
        outbound: sessionMailboxPath(key, 'outbound'),
        heartbeat: path.join(sessionMailboxDir(key), '.heartbeat'),
      }),
    });
    const { bind, port } = this.settings;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bind, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    log.info('Mailbox HTTP endpoint listening', { bind, port, url: this.settings.url });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The bound address, for tests that listen on port 0. */
  address(): { address: string; port: number } | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? { address: address.address, port: address.port } : undefined;
  }
}
