import fs from 'fs';

const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';

/**
 * The heartbeat location is deployment-configurable via
 * NANOCLAW_HEARTBEAT_PATH for setups that relocate the workspace heartbeat.
 * Unset = today's path, byte-identical. Read per call so the container env,
 * not import order, decides.
 */
export function heartbeatPath(): string {
  return process.env.NANOCLAW_HEARTBEAT_PATH || DEFAULT_HEARTBEAT_PATH;
}

export function touchHeartbeat(): void {
  const heartbeat = heartbeatPath();
  const now = new Date();
  try {
    fs.utimesSync(heartbeat, now, now);
  } catch {
    try {
      fs.writeFileSync(heartbeat, '');
    } catch {
      // Parent may not exist in tests.
    }
  }
}

export const TURN_HEARTBEAT_INTERVAL_MS = 2000;
// Backstop for a turn whose stream wedged without an error: stop vouching for
// it after this much silence so the host sweep can reclaim the container.
export const TURN_SILENCE_CAP_MS = 10 * 60 * 1000;

export interface TurnLiveness {
  /** A prompt entered the stream; a `result` is owed. */
  begin(): void;
  /** A `result` arrived for one in-flight prompt. */
  end(): void;
  /** Any stream event: proof the turn is progressing, resets the silence cap. */
  noteEvent(): void;
  dispose(): void;
}

/**
 * Keeps the heartbeat ticking for the whole of every in-flight turn. The SDK
 * emits whole messages, so between a prompt and its first assistant message,
 * and across every tool run, no event arrives and a per-event heartbeat goes
 * stale even though the agent is busy. Consumers on the host (typing refresh,
 * claim-stuck detection) read the heartbeat as "the agent is working".
 */
export function createTurnLiveness(
  opts: { touch?: () => void; intervalMs?: number; silenceCapMs?: number; now?: () => number } = {},
): TurnLiveness {
  const touch = opts.touch ?? touchHeartbeat;
  const intervalMs = opts.intervalMs ?? TURN_HEARTBEAT_INTERVAL_MS;
  const silenceCapMs = opts.silenceCapMs ?? TURN_SILENCE_CAP_MS;
  const now = opts.now ?? Date.now;

  let inflight = 0;
  let lastEventAt = now();
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const start = (): void => {
    if (timer || disposed || inflight === 0) return;
    timer = setInterval(() => {
      if (now() - lastEventAt > silenceCapMs) {
        stop();
        return;
      }
      touch();
    }, intervalMs);
    timer.unref?.();
  };

  return {
    begin() {
      if (disposed) return;
      inflight += 1;
      lastEventAt = now();
      touch();
      start();
    },
    end() {
      inflight = Math.max(0, inflight - 1);
      if (inflight === 0) stop();
    },
    noteEvent() {
      lastEventAt = now();
      start();
    },
    dispose() {
      disposed = true;
      inflight = 0;
      stop();
    },
  };
}
