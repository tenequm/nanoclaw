/**
 * One jev call at run time: the event queue, the timers and the executor of the core's commands. Wiring
 * only: every choice about the conversation is the core's (`reduce` then `decide` per event); this file
 * runs what it asks for through the ports and feeds what comes back in as events.
 *
 * Events are processed one at a time in arrival order, so the core sees one linear log; results of
 * async commands (a verdict, a turn reaching the agent, a timer) join the end of the queue. After
 * `end` nothing more is processed and nothing pending fires.
 */
import type {
  CallCore,
  CallEvent,
  CallPolicy,
  CallStatus,
  Command,
  JevState,
  RecheckState,
  RecheckVerdict,
  Verdict,
} from './core/types.js';

/** What a turn submission came to: the host's utterance id for it, or why it did not reach the agent. */
export type JevTurnResult = { ok: true; turnId: string } | { ok: false; reason: string };

export interface RuntimePorts {
  now(): number;
  /** Never rejects in practice (askAction answers null on any failure); a rejection counts as a null verdict. */
  judge(state: JevState, signal: AbortSignal): Promise<{ verdict: Verdict | null; ms: number }>;
  /** The answer-ready check; never rejects in practice either, and a rejection counts as a null verdict. */
  recheck(state: RecheckState, signal: AbortSignal): Promise<{ verdict: RecheckVerdict | null; ms: number }>;
  /** Submit a turn; an aborted `signal` (superseded, or the call ended) stops it being routed, or the wait for it. */
  turn(turn: { message: string; note: string }, signal: AbortSignal): Promise<JevTurnResult>;
  speak(replyId: string, text: string): void;
  show(replyId: string, text: string): void;
  drop(replyId: string): void;
  revoke(replyId: string): void;
  stopPlayback(): void;
  status(status: CallStatus): void;
  log(event: string, fields: Record<string, unknown>): void;
  /** Every event as it is processed, numbered from 1: the call's replayable log. */
  record(seq: number, event: CallEvent): void;
}

export interface CallRuntime {
  feed(event: CallEvent): void;
  /** Stops processing, clears every timer, aborts what is in flight; idempotent. */
  end(reason: string): void;
  readonly ended: boolean;
}

interface Queued {
  event: CallEvent;
  /** Checked when the event's turn comes: false drops it (a timer replaced or cancelled after it fired). */
  current?: () => boolean;
}

interface PendingTurn {
  key: string;
  message: string;
  note: string;
  abort: AbortController;
}

export function createCallRuntime<S>(core: CallCore<S>, policy: CallPolicy, ports: RuntimePorts): CallRuntime {
  let state = core.initial(policy, ports.now());
  let ended = false;
  let draining = false;
  let seq = 0;
  const queue: Queued[] = [];
  const timers = new Map<string, { gen: number; handle: ReturnType<typeof setTimeout> }>();
  let timerGen = 0;
  const judges = new Set<AbortController>();
  const rechecks = new Set<AbortController>();
  const turnQueue: PendingTurn[] = [];
  let turnInFlight: PendingTurn | null = null;

  const enqueue = (item: Queued): void => {
    if (ended) return;
    queue.push(item);
    drain();
  };

  const drain = (): void => {
    if (draining) return;
    draining = true;
    try {
      while (!ended && queue.length > 0) {
        const item = queue.shift()!;
        if (item.current && !item.current()) continue;
        step(item.event);
      }
    } finally {
      draining = false;
    }
  };

  const step = (event: CallEvent): void => {
    seq++;
    safely('record', () => ports.record(seq, event));
    let commands: Command[];
    try {
      state = core.reduce(state, event);
      commands = core.decide(state, event);
    } catch (err) {
      safely('log', () => ports.log('core_error', { seq, event: event.kind, err: errText(err) }));
      return;
    }
    for (const command of commands) safely(command.kind, () => execute(command));
  };

  const safely = (what: string, run: () => void): void => {
    try {
      run();
    } catch (err) {
      try {
        ports.log('port_error', { command: what, err: errText(err) });
      } catch {
        // The log port itself failed; nothing left to tell.
      }
    }
  };

  const execute = (command: Command): void => {
    switch (command.kind) {
      case 'status':
        return ports.status(command.status);
      case 'judge':
        return judge(command.windowVersion, command.state);
      case 'recheck':
        return recheck(command.wakeKey, command.state);
      case 'wait':
        return wait(command.key, command.ms);
      case 'cancel_wait':
        clearTimeout(timers.get(command.key)?.handle);
        timers.delete(command.key);
        return;
      case 'turn':
        return turn(command);
      case 'speak':
        return ports.speak(command.replyId, command.text);
      case 'show':
        return ports.show(command.replyId, command.text);
      case 'drop':
        return ports.drop(command.replyId);
      case 'revoke':
        return ports.revoke(command.replyId);
      case 'stop_playback':
        return ports.stopPlayback();
      case 'log':
        return ports.log(command.event, command.fields);
    }
  };

  /** Only the newest window's verdict can be acted on, so a new judge aborts the ones in flight. */
  const judge = (windowVersion: number, jevState: JevState): void => {
    for (const inFlight of judges) inFlight.abort();
    judges.clear();
    const abort = new AbortController();
    judges.add(abort);
    void Promise.resolve()
      .then(() => ports.judge(jevState, abort.signal))
      .catch(() => ({ verdict: null, ms: 0 }))
      .then(({ verdict, ms }) => {
        judges.delete(abort);
        enqueue({ event: { kind: 'verdict', windowVersion, verdict, ms, at: ports.now() } });
      });
  };

  /** Apart from `judge`: a new boundary's judge must not abort the check of an answer already landed. */
  const recheck = (wakeKey: string, recheckState: RecheckState): void => {
    const abort = new AbortController();
    rechecks.add(abort);
    void Promise.resolve()
      .then(() => ports.recheck(recheckState, abort.signal))
      .catch(() => ({ verdict: null, ms: 0 }))
      .then(({ verdict, ms }) => {
        rechecks.delete(abort);
        enqueue({ event: { kind: 'recheck_verdict', wakeKey, verdict, ms, at: ports.now() } });
      });
  };

  const wait = (key: string, ms: number): void => {
    clearTimeout(timers.get(key)?.handle);
    const gen = ++timerGen;
    const handle = setTimeout(
      () =>
        enqueue({
          event: { kind: 'timer', key, at: ports.now() },
          current: () => {
            if (timers.get(key)?.gen !== gen) return false;
            timers.delete(key);
            return true;
          },
        }),
      Math.max(0, ms),
    );
    handle.unref?.();
    timers.set(key, { gen, handle });
  };

  const turn = (command: Extract<Command, { kind: 'turn' }>): void => {
    const replaced = command.supersedes;
    if (replaced !== undefined) {
      const queued = turnQueue.findIndex((t) => t.key === replaced);
      if (queued >= 0) {
        turnQueue.splice(queued, 1);
        enqueue({ event: { kind: 'turn_failed', key: replaced, reason: 'superseded', at: ports.now() } });
      } else if (turnInFlight?.key === replaced) {
        turnInFlight.abort.abort();
      }
    }
    turnQueue.push({ key: command.key, message: command.message, note: command.note, abort: new AbortController() });
    pumpTurns();
  };

  /** One turn at a time, so the host's utterance ids follow the order the core asked for them in. */
  const pumpTurns = (): void => {
    if (turnInFlight || ended) return;
    const next = turnQueue.shift();
    if (!next) return;
    turnInFlight = next;
    void Promise.resolve()
      .then(() => ports.turn({ message: next.message, note: next.note }, next.abort.signal))
      .catch((err: unknown): JevTurnResult => ({ ok: false, reason: `error: ${errText(err)}` }))
      .then((result) => {
        turnInFlight = null;
        const at = ports.now();
        enqueue({
          event: result.ok
            ? { kind: 'turn', key: next.key, turnId: result.turnId, at }
            : { kind: 'turn_failed', key: next.key, reason: result.reason, at },
        });
        pumpTurns();
      });
  };

  return {
    feed: (event) => enqueue({ event }),
    end(reason) {
      if (ended) return;
      ended = true;
      queue.length = 0;
      for (const { handle } of timers.values()) clearTimeout(handle);
      timers.clear();
      for (const abort of [...judges, ...rechecks]) abort.abort();
      judges.clear();
      rechecks.clear();
      turnInFlight?.abort.abort();
      for (const pending of turnQueue) pending.abort.abort();
      turnQueue.length = 0;
      safely('log', () => ports.log('call_end', { reason, events: seq }));
    },
    get ended() {
      return ended;
    },
  };
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
