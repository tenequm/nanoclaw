/**
 * HTTP mailbox transport, runner side: the session mailbox lives on the host
 * and is reached through one endpoint; no SQLite file is opened here.
 *
 * The runner contract is mostly synchronous (MailboxOperations reads and
 * acks are called inline by the poll loop, MCP tools and hooks, outside
 * run()), and a synchronous network call cannot be made honestly. So this
 * implementation keeps a per-process replica of the session's runner-visible
 * state, refreshed in the background, and serves the sync methods from it:
 *
 * - Sync reads answer from the latest snapshot (at most one sync interval
 *   old). run() refreshes before its action, so a tool call starts fresh.
 * - Sync writes apply to the replica at once (read-your-writes) and queue for
 *   the host, flushed on the next tick; run() flushes before it resolves —
 *   the runner-side analog of "durable once session() resolves".
 * - writeMessageOut resolves only after the host committed the row.
 *
 * Failure is loud, never empty: while the host is unreachable, writes are
 * retried (all are idempotent on the host) and reads serve the last good
 * snapshot, for at most `staleAfterMs`. Past that, or on any permanent
 * refusal (bad token, unknown session, rejected request), the mailbox is
 * poisoned: every operation throws and shouldRestartAfter() asks for a
 * fresh runner.
 *
 * Adding an operation: a sync write is one WRITE_EFFECTS entry plus its
 * one-line method; a read is one method over the replica (extend the host
 * snapshot when it needs data the replica does not carry).
 */
import {
  parseDestinationRecord,
  parseInboundRecord,
  parseOutboundRecord,
  parseOutboundWrite,
  parseSessionRoutingRecord,
  parseStateRecord,
} from '../model.generated.js';
import type {
  AgentMailbox,
  Destination,
  InboundMessage,
  MailboxOperations,
  MailboxSessionKey,
  OutboundMessage,
  OutboundMessageDraft,
  ProcessingStatus,
  SessionRouting,
  StateValue,
  TurnState,
} from '../types.js';

export const HTTP_MAILBOX_PROTOCOL = 1;
/** Replica rows kept per table beyond the pending set; older seq lookups miss. */
const REPLICA_WINDOW = 2000;

export interface HttpMailboxContext {
  transport: 'http';
  protocol: number;
  url: string;
  token: string;
}

export interface HttpMailboxOptions {
  syncIntervalMs?: number;
  staleAfterMs?: number;
  requestTimeoutMs?: number;
}

/** Transport failure. `permanent` ones poison the mailbox immediately. */
export class MailboxTransportError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MailboxTransportError';
  }
}

export function parseHttpMailboxContext(value: unknown): HttpMailboxContext {
  const context = value as Partial<HttpMailboxContext> | null;
  if (
    !context ||
    context.transport !== 'http' ||
    typeof context.url !== 'string' ||
    !/^https?:\/\//.test(context.url) ||
    typeof context.token !== 'string' ||
    context.token === ''
  ) {
    throw new Error('Invalid HTTP mailbox context: expected { transport: "http", url, token }');
  }
  if (context.protocol !== HTTP_MAILBOX_PROTOCOL) {
    throw new Error(
      `HTTP mailbox protocol mismatch: host speaks ${String(context.protocol)}, runner speaks ${HTTP_MAILBOX_PROTOCOL}`,
    );
  }
  return context as HttpMailboxContext;
}

interface SnapshotCursor {
  inbound: number;
  outbound: number;
  delivered: number;
}

interface WireSnapshot {
  cursor: SnapshotCursor;
  pending: unknown[];
  claimed: Record<string, ProcessingStatus>;
  inbound: unknown[];
  outbound: unknown[];
  delivered: Array<{ messageOutId: string; platformMessageId: string | null }>;
  latestRoutes: Array<{ channelType: string; platformId: string; threadId: string | null; inReplyTo: string }>;
  replySeqs: Array<{ channelType: string; platformId: string; platformMessageId: string; sequence: number | null }>;
  destinations: unknown[];
  routing: unknown;
  state: unknown[];
}

const routeKey = (...parts: string[]) => parts.join('\u0000');
/** SQLite's datetime() compares at second precision; match it so due-ness agrees with the SQLite runner. */
const dueAt = (timestamp: string | null, now: number) =>
  timestamp === null || Math.floor(Date.parse(timestamp) / 1000) <= Math.floor(now / 1000);
const bySequence = (a: { sequence: number | null }, b: { sequence: number | null }) =>
  (a.sequence ?? 0) - (b.sequence ?? 0);
const containsIgnoringCase = (haystack: string, needle: string) =>
  haystack.toLowerCase().includes(needle.toLowerCase());

function trim<V>(map: Map<number, V>): void {
  if (map.size <= REPLICA_WINDOW) return;
  const drop = [...map.keys()].sort((a, b) => a - b).slice(0, map.size - REPLICA_WINDOW);
  for (const key of drop) map.delete(key);
}

class Replica {
  cursor: SnapshotCursor | null = null;
  pending = new Map<string, InboundMessage>();
  claimed = new Map<string, ProcessingStatus>();
  inbound = new Map<number, InboundMessage>();
  outbound = new Map<number, OutboundMessage>();
  delivered = new Map<string, string | null>();
  latestRoutes = new Map<string, { threadId: string | null; inReplyTo: string }>();
  replySeqs = new Map<string, number | null>();
  destinations: Destination[] = [];
  routing: SessionRouting = { channelType: null, platformId: null, threadId: null };
  state = new Map<string, StateValue>();

  apply(snapshot: WireSnapshot): void {
    this.pending = new Map(snapshot.pending.map(parseInboundRecord).map((message) => [message.id, message]));
    this.claimed = new Map(Object.entries(snapshot.claimed));
    for (const message of snapshot.inbound.map(parseInboundRecord)) {
      if (message.sequence !== null) this.inbound.set(message.sequence, message);
    }
    for (const message of snapshot.outbound.map(parseOutboundRecord)) {
      if (message.sequence !== null) this.outbound.set(message.sequence, message);
    }
    for (const row of snapshot.delivered) this.delivered.set(row.messageOutId, row.platformMessageId);
    trim(this.inbound);
    trim(this.outbound);
    if (this.delivered.size > REPLICA_WINDOW) {
      for (const id of [...this.delivered.keys()].slice(0, this.delivered.size - REPLICA_WINDOW)) {
        this.delivered.delete(id);
      }
    }
    this.latestRoutes = new Map(
      snapshot.latestRoutes.map((route) => [
        routeKey(route.channelType, route.platformId),
        { threadId: route.threadId, inReplyTo: route.inReplyTo },
      ]),
    );
    this.replySeqs = new Map(
      snapshot.replySeqs.map((entry) => [
        routeKey(entry.channelType, entry.platformId, entry.platformMessageId),
        entry.sequence,
      ]),
    );
    this.destinations = snapshot.destinations.map(parseDestinationRecord);
    this.routing = parseSessionRoutingRecord(snapshot.routing);
    this.state = new Map(
      snapshot.state
        .map(parseStateRecord)
        .map((record) => [record.key, { value: record.value, updatedAt: record.updatedAt }]),
    );
    this.cursor = snapshot.cursor;
  }

  /**
   * Exact for every pending row's reply target (the host resolves those in each
   * snapshot); otherwise the same rule over the replica window, where an older
   * target misses — the formatter then omits reply_to, as for any message
   * outside the session's history.
   */
  findSeqByPlatformMessageId(channelType: string, platformId: string, platformMessageId: string): number | null {
    const resolved = this.replySeqs.get(routeKey(channelType, platformId, platformMessageId));
    if (resolved !== undefined) return resolved;
    const chat = platformId.startsWith(`${channelType}:`)
      ? platformId.slice(channelType.length + 1).split(':')[0]
      : platformId;
    const prefix = `${chat}:${platformMessageId}:`;
    const inbound = [...this.pending.values(), ...this.inbound.values()]
      .filter(
        (message) =>
          message.sequence !== null &&
          message.channelType === channelType &&
          message.platformId === platformId &&
          (message.id === platformMessageId ||
            (message.id.startsWith(prefix) && !message.id.slice(prefix.length).includes(':'))),
      )
      .sort(bySequence)[0];
    if (inbound) return inbound.sequence;
    const delivered = new Set(
      [...this.delivered].filter(([, platform]) => platform === platformMessageId).map(([id]) => id),
    );
    const outbound = [...this.outbound.values()]
      .filter(
        (message) =>
          delivered.has(message.id) && message.channelType === channelType && message.platformId === platformId,
      )
      .sort(bySequence)[0];
    return outbound?.sequence ?? null;
  }

  inboundBySequence(sequence: number): InboundMessage | undefined {
    const windowed = this.inbound.get(sequence);
    if (windowed) return windowed;
    for (const message of this.pending.values()) if (message.sequence === sequence) return message;
    return undefined;
  }
}

/** How each queued sync write shows up in the replica before the host confirms it. */
const WRITE_EFFECTS: Record<string, (replica: Replica, args: unknown[]) => void> = {
  markMessages: (replica, [ids, status]) => {
    for (const id of ids as string[]) replica.claimed.set(id, status as ProcessingStatus);
  },
  markScriptSkipped: (replica, [skips]) => {
    for (const skip of skips as Array<{ id: string; reason: string }>) {
      replica.claimed.set(skip.id, skip.reason === 'error' ? 'script-skip:error' : 'completed');
    }
  },
  setState: (replica, [key, value]) => {
    const record = parseStateRecord({ key, value, updatedAt: new Date().toISOString() });
    replica.state.set(record.key, { value: record.value, updatedAt: record.updatedAt });
  },
  deleteState: (replica, [key]) => {
    replica.state.delete(key as string);
  },
  clearStaleProcessingAcks: (replica) => {
    for (const [id, status] of replica.claimed) if (status === 'processing') replica.claimed.delete(id);
  },
  setContainerToolInFlight: () => {},
  clearContainerToolInFlight: () => {},
  markContainerTurn: () => {},
  writeMessageOut: () => {},
};

interface QueuedWrite {
  op: string;
  args: unknown[];
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpAgentMailbox implements AgentMailbox {
  readonly operations: MailboxOperations;
  private readonly syncIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly requestTimeoutMs: number;
  private key: MailboxSessionKey | null = null;
  private context: HttpMailboxContext | null = null;
  private readonly replica = new Replica();
  private queue: QueuedWrite[] = [];
  private heartbeatPending = false;
  private enqueued = 0;
  private flushed = 0;
  private lastSuccessAt = 0;
  private failingSince: number | null = null;
  private fatal: Error | null = null;
  private running: Promise<void> = Promise.resolve();
  private scheduled: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(options: HttpMailboxOptions = {}) {
    this.syncIntervalMs = options.syncIntervalMs ?? 250;
    this.staleAfterMs = options.staleAfterMs ?? 15_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.operations = this.createOperations();
  }

  shouldRestartAfter(error: unknown): boolean {
    return error instanceof MailboxTransportError;
  }

  async start(key: MailboxSessionKey | null): Promise<void> {
    if (!key) throw new Error('HTTP mailbox requires the host session context; refusing the legacy null sentinel');
    this.context = parseHttpMailboxContext(key.mailbox);
    this.key = key;
    await this.syncUntilSettled();
    this.interval = setInterval(() => {
      this.sync().catch(() => {});
    }, this.syncIntervalMs);
    // Standalone scripts (PreCompact hook, ncl) must exit when their work is done.
    (this.interval as { unref?: () => void }).unref?.();
  }

  async run<T>(action: () => T | Promise<T>): Promise<T> {
    await this.syncUntilSettled();
    const result = await action();
    await this.drain();
    return result;
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.context && !this.fatal) await this.drain();
  }

  /** Heartbeats ride the next exchange; the host touches the session's heartbeat file. */
  heartbeat(): boolean {
    if (!this.fatal) {
      this.heartbeatPending = true;
      this.scheduleFlush();
    }
    return true;
  }

  // -- transport ---------------------------------------------------------

  private assertReadable(): void {
    if (this.fatal) throw this.fatal;
    if (!this.replica.cursor) throw new MailboxTransportError('HTTP mailbox used before start()', true);
    const age = Date.now() - this.lastSuccessAt;
    if (age > this.staleAfterMs) {
      throw new MailboxTransportError(`HTTP mailbox snapshot is ${age}ms old; host unreachable`, false);
    }
  }

  private write(op: string, args: unknown[]): Promise<unknown> {
    if (this.fatal) throw this.fatal;
    if (!this.context) throw new MailboxTransportError('HTTP mailbox used before start()', true);
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const queued = { op, args, resolve, reject };
    WRITE_EFFECTS[op](this.replica, args);
    this.queue.push(queued);
    this.enqueued += 1;
    this.scheduleFlush();
    return done;
  }

  /** Fire-and-forget sync writes still surface failures: the next op throws once poisoned. */
  private writeSync(op: string, args: unknown[]): void {
    this.write(op, args).catch(() => {});
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.sync().catch(() => {});
    }, 0);
  }

  /** One coalesced exchange after any in flight: queued writes + heartbeat + snapshot. */
  private sync(): Promise<void> {
    if (this.scheduled) return this.scheduled;
    const next = this.running
      .catch(() => {})
      .then(() => {
        this.scheduled = null;
        return this.exchange();
      });
    this.scheduled = next;
    this.running = next;
    return next;
  }

  private async syncUntilSettled(): Promise<void> {
    for (;;) {
      try {
        await this.sync();
        return;
      } catch (error) {
        if (this.fatal) throw this.fatal;
        await sleep(this.syncIntervalMs);
      }
    }
  }

  /** Wait until every write queued before this call is committed on the host. */
  private async drain(): Promise<void> {
    const target = this.enqueued;
    while (this.flushed < target) {
      if (this.fatal) throw this.fatal;
      try {
        await this.sync();
      } catch {
        if (this.fatal) throw this.fatal;
        await sleep(this.syncIntervalMs);
      }
    }
  }

  private poison(error: Error): void {
    if (this.fatal) return;
    this.fatal = error;
    console.error(`[mailbox-http] ${error.message} — mailbox disabled; this runner needs a restart`);
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const queued of this.queue.splice(0)) queued.reject(error);
  }

  private async exchange(): Promise<void> {
    if (this.fatal) throw this.fatal;
    const batch = this.queue.slice();
    const heartbeat = this.heartbeatPending;
    this.heartbeatPending = false;
    const ops = [
      ...batch.map(({ op, args }) => ({ op, args })),
      ...(heartbeat ? [{ op: 'heartbeat', args: [] }] : []),
      { op: 'snapshot', args: [this.replica.cursor] },
    ];
    let results: unknown[];
    try {
      results = await this.post(ops);
    } catch (error) {
      if (heartbeat) this.heartbeatPending = true;
      const failure =
        error instanceof MailboxTransportError
          ? error
          : new MailboxTransportError(`HTTP mailbox request failed: ${String(error)}`, false);
      const now = Date.now();
      if (this.failingSince === null) {
        this.failingSince = now;
        console.error(`[mailbox-http] ${failure.message} — retrying for up to ${this.staleAfterMs}ms`);
      }
      if (failure.permanent || now - this.failingSince > this.staleAfterMs) this.poison(failure);
      throw this.fatal ?? failure;
    }
    this.failingSince = null;
    this.lastSuccessAt = Date.now();
    this.queue.splice(0, batch.length);
    this.flushed += batch.length;
    batch.forEach((queued, index) => queued.resolve(results[index]));
    try {
      this.replica.apply(results[results.length - 1] as WireSnapshot);
    } catch (error) {
      this.poison(new MailboxTransportError(`HTTP mailbox snapshot failed validation: ${String(error)}`, true));
      throw this.fatal;
    }
    // Writes queued while this exchange was in flight are not in the snapshot yet.
    for (const queued of this.queue) WRITE_EFFECTS[queued.op](this.replica, queued.args);
  }

  private async post(ops: Array<{ op: string; args: unknown[] }>): Promise<unknown[]> {
    const { url, token } = this.context!;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-nanoclaw-agent-group': this.key!.agentGroupId,
        'x-nanoclaw-session': this.key!.sessionId,
      },
      body: JSON.stringify({ ops }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const body = (await response.json().catch(() => null)) as {
      results?: unknown[];
      error?: { code?: string; message?: string };
    } | null;
    if (!response.ok) {
      const detail = body?.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${response.status}`;
      // 4xx is the host refusing this request (bad token, unknown session, invalid op): retrying cannot help.
      const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      throw new MailboxTransportError(`HTTP mailbox rejected request (${detail})`, permanent, response.status);
    }
    if (!Array.isArray(body?.results) || body.results.length !== ops.length) {
      throw new MailboxTransportError('HTTP mailbox returned a malformed response', true, response.status);
    }
    return body.results;
  }

  // -- the runner contract over the replica -------------------------------

  private createOperations(): MailboxOperations {
    const replica = this.replica;
    const read = <T>(fn: () => T): T => {
      this.assertReadable();
      return fn();
    };
    return {
      getPendingMessages: (limit, isFirstPoll) =>
        read(() => {
          const now = Date.now();
          const unclaimed = [...replica.pending.values()]
            .filter((message) => dueAt(message.processAfter, now) && (!message.onWake || isFirstPoll))
            .filter((message) => !replica.claimed.has(message.id))
            .sort(bySequence);
          const wake = unclaimed.filter((message) => message.trigger).slice(0, limit);
          const remaining = limit - wake.length;
          const context = remaining > 0 ? unclaimed.filter((message) => !message.trigger).slice(-remaining) : [];
          return [...wake, ...context].sort(bySequence);
        }),
      markMessages: (ids, status) => this.writeSync('markMessages', [ids, status]),
      markScriptSkipped: (skips) => this.writeSync('markScriptSkipped', [skips]),
      getMessageIn: (id) => read(() => replica.pending.get(id) ?? [...replica.inbound.values()].find((m) => m.id === id)),
      findQuestionResponse: (questionId) =>
        read(() => {
          const response = [...replica.pending.values()]
            .sort(bySequence)
            .find((message) => containsIgnoringCase(message.content, `"questionId":"${questionId}"`));
          return response && !replica.claimed.has(response.id) ? response : undefined;
        }),
      findCliResponse: (requestId) =>
        read(() =>
          [...replica.pending.values()]
            .sort(bySequence)
            .find((message) => containsIgnoringCase(message.content, `"requestId":"${requestId}"`)),
        ),
      writeMessageOut: async (message: OutboundMessageDraft) => {
        parseOutboundWrite(message);
        return (await this.write('writeMessageOut', [message])) as number;
      },
      getMessageIdBySeq: (sequence) =>
        read(() => {
          const inbound = replica.inboundBySequence(sequence);
          if (inbound) return inbound.id;
          const outbound = replica.outbound.get(sequence);
          if (!outbound) return null;
          return replica.delivered.get(outbound.id) || outbound.id;
        }),
      getRoutingBySeq: (sequence) =>
        read(() => {
          const row = replica.inboundBySequence(sequence) ?? replica.outbound.get(sequence);
          return row
            ? parseSessionRoutingRecord({
                channelType: row.channelType,
                platformId: row.platformId,
                threadId: row.threadId,
              })
            : null;
        }),
      getLatestInboundRoute: (channelType, platformId) =>
        read(() => replica.latestRoutes.get(routeKey(channelType, platformId)) ?? null),
      findSeqByPlatformMessageId: (channelType, platformId, platformMessageId) =>
        read(() => replica.findSeqByPlatformMessageId(channelType, platformId, platformMessageId)),
      getUndeliveredMessages: () =>
        read(() => {
          const now = Date.now();
          return [...replica.outbound.values()]
            .filter((message) => dueAt(message.deliverAfter, now))
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || bySequence(a, b));
        }),
      getState: (key) => read(() => replica.state.get(key)),
      setState: (key, value) => this.writeSync('setState', [key, value]),
      deleteState: (key) => this.writeSync('deleteState', [key]),
      getSessionRouting: () => read(() => replica.routing),
      getDestinations: () => read(() => replica.destinations),
      findDestinationByName: (name) => read(() => replica.destinations.find((entry) => entry.name === name)),
      findDestinationByRouting: (channelType, platformId) =>
        read(() =>
          replica.destinations.find((entry) =>
            channelType === 'agent'
              ? entry.type === 'agent' && entry.agentGroupId === platformId
              : entry.type === 'channel' && entry.channelType === channelType && entry.platformId === platformId,
          ),
        ),
      setContainerToolInFlight: (tool, declaredTimeoutMs) =>
        this.writeSync('setContainerToolInFlight', [tool, declaredTimeoutMs]),
      clearContainerToolInFlight: () => this.writeSync('clearContainerToolInFlight', []),
      markContainerTurn: (turn: TurnState) => {
        if (turn !== 'working' && turn !== 'idle') throw new Error(`Invalid turn state: ${String(turn)}`);
        this.writeSync('markContainerTurn', [turn]);
      },
      clearStaleProcessingAcks: () => this.writeSync('clearStaleProcessingAcks', []),
    };
  }
}
