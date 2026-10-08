/**
 * One composed mailbox that picks its transport from the host-written session
 * context at start(): `mailbox: null` (or no context, from a pre-seam host) is
 * the SQLite files, `mailbox: { transport: 'http', ... }` is the host
 * endpoint. One image serves both, so switching transport (and rolling it
 * back) is a host-side setting. Anything else stops the runner with a clear
 * error instead of guessing.
 *
 * Before start() it behaves as the SQLite mailbox, exactly as the composition
 * did before the HTTP transport existed (tests and tools that never start a
 * mailbox keep working). Every runner entry point calls start() first.
 */
import type { AgentMailbox, MailboxOperations, MailboxSessionKey } from '../types.js';
import { HttpAgentMailbox } from './index.js';

export type MailboxTransport = 'sqlite' | 'http';

export function selectMailboxTransport(key: MailboxSessionKey | null): MailboxTransport {
  if (key === null || key.mailbox === null || key.mailbox === undefined) return 'sqlite';
  const transport = (key.mailbox as { transport?: unknown } | null)?.transport;
  if (transport === 'http' || transport === 'sqlite') return transport;
  throw new Error(
    `Invalid mailbox selection in NanoClaw session context (transport: ${JSON.stringify(transport ?? null)}); ` +
      'expected null or { transport: "http" | "sqlite" }',
  );
}

export class ContextSelectedAgentMailbox implements AgentMailbox {
  private selected: AgentMailbox | undefined;

  constructor(
    private readonly createSqlite: () => AgentMailbox,
    private readonly createHttp: () => AgentMailbox = () => new HttpAgentMailbox(),
  ) {}

  private get current(): AgentMailbox {
    return (this.selected ??= this.createSqlite());
  }

  get operations(): MailboxOperations {
    return this.current.operations;
  }

  shouldRestartAfter(error: unknown): boolean {
    return this.current.shouldRestartAfter?.(error) ?? false;
  }

  heartbeat(): boolean {
    return this.current.heartbeat?.() ?? false;
  }

  async start(key: MailboxSessionKey | null): Promise<void> {
    const transport = selectMailboxTransport(key);
    await this.selected?.stop();
    this.selected = transport === 'http' ? this.createHttp() : this.createSqlite();
    await this.selected.start(key);
  }

  run<T>(action: () => T | Promise<T>): Promise<T> {
    return this.current.run(action);
  }

  async stop(): Promise<void> {
    await this.selected?.stop();
  }
}
