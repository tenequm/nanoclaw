/**
 * SHADOW-ONLY end-of-turn judge for the voice-mode worker: measures whether Jev (api.typesafe.ai
 * `systemone`) can tell that the caller finished a turn, on real calls, without acting on it.
 *
 * While an addressed auto turn is open (hands-free or woken; never a Manual/review recording) and
 * its interim text has not changed for `pauseMs`, Jev is asked two Nouls about the text so far.
 * Each judgement is one log line, and each turn's end one outcome line, so the thresholds can be
 * fitted against how the turn really ended. Nothing here can send, end or change a turn: CallTurns
 * hands it the text and the turn's end, and it only logs. No transcript text is ever logged.
 *
 * Off unless `data/jev-turn.json` says `"enabled": true` (hot-reloaded); fail-silent on every
 * error. To remove it: this file, its test, its doc, and the `jevTurn`/`shadow` lines in
 * src/voice-mode-worker.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, JEV_API_KEY, TIMEZONE } from './config.js';
import { JEV_MODEL, JEV_TIMEOUT_MS, JEV_URL } from './modules/jev-gate/jev.js';

export interface JevTurnConfig {
  enabled: boolean;
  /** The interim text unchanged this long asks Jev. */
  pauseMs: number;
  /** Shorter text is not judged. */
  minWords: number;
  /** wouldSend: finished at or above `finished` and trailing below `trailing`. */
  thresholds: { finished: number; trailing: number };
  /** Judgements per call, and per local day across calls; 0 = no cap. */
  maxPerCall: number;
  maxPerDay: number;
}

export const DEFAULT_JEV_TURN_CONFIG: JevTurnConfig = {
  enabled: false,
  pauseMs: 1200,
  minWords: 3,
  thresholds: { finished: 0.8, trailing: 0.5 },
  maxPerCall: 40,
  maxPerDay: 1000,
};

export const jevTurnConfigPath = (): string => path.join(DATA_DIR, 'jev-turn.json');

let cache: { file: string; mtimeMs: number; size: number; config: JevTurnConfig } | null = null;

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** The config, re-read when the file changes. Missing or unreadable = disabled. */
export function loadJevTurnConfig(): JevTurnConfig {
  const file = jevTurnConfigPath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = null;
    return DEFAULT_JEV_TURN_CONFIG;
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.config;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return DEFAULT_JEV_TURN_CONFIG;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_JEV_TURN_CONFIG;
  const r = raw as Record<string, unknown>;
  const t = (r.thresholds ?? {}) as Record<string, unknown>;
  const d = DEFAULT_JEV_TURN_CONFIG;
  const config: JevTurnConfig = {
    enabled: r.enabled === true,
    pauseMs: num(r.pauseMs, d.pauseMs),
    minWords: num(r.minWords, d.minWords),
    thresholds: { finished: num(t.finished, d.thresholds.finished), trailing: num(t.trailing, d.thresholds.trailing) },
    maxPerCall: num(r.maxPerCall, d.maxPerCall),
    maxPerDay: num(r.maxPerDay, d.maxPerDay),
  };
  cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, config };
  return config;
}

/** Test seam: a same-millisecond rewrite is otherwise sticky. */
export function resetJevTurnConfigCache(): void {
  cache = null;
}

/** A daily judgement: `taken` and counted, `capped` for today, or `failed` to count, so skipped too. */
export type DailyTake = 'taken' | 'capped' | 'failed';

const USAGE_PREFIX = 'jev-turn-usage';

/** The local day the daily cap counts in, `YYYY-MM-DD`. */
export const localDay = (now: Date): string => now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

/** Removes other days' usage files, and the previous scheme's count, lock and temp files; best-effort. */
function pruneUsage(dir: string, keep: string): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(USAGE_PREFIX) && name !== keep) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // The next day's first take tries again.
  }
}

/**
 * One judgement for today's cap, counted as one byte appended to the day's usage file: a job process
 * serves one call, so a count in memory would reset with every call. Each append is atomic, and the
 * size read back after it is at least this take's place in the day, so concurrent processes can only
 * under-count, never over-count, and nothing can tear. Any error skips the judgement as `failed`.
 */
export function takeDailyJudgement(max: number, now = new Date(), dir = DATA_DIR): DailyTake {
  if (!(max > 0)) return 'taken';
  try {
    const name = `${USAGE_PREFIX}-${localDay(now)}`;
    const file = path.join(dir, name);
    let fd: number;
    try {
      fd = fs.openSync(file, 'a');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      fs.mkdirSync(dir, { recursive: true });
      fd = fs.openSync(file, 'a');
    }
    let size: number;
    try {
      fs.writeSync(fd, '.');
      size = fs.fstatSync(fd).size;
    } finally {
      fs.closeSync(fd);
    }
    if (size === 1) pruneUsage(dir, name);
    return size <= max ? 'taken' : 'capped';
  } catch {
    return 'failed';
  }
}

export const JEV_TURN_QUESTIONS = {
  finished:
    'Has the speaker finished the request or thought they were dictating to the assistant, so it is a good moment for the assistant to reply?',
  trailing:
    "Does the last sentence trail off, or announce that more is coming (e.g. 'and also', 'wait', 'one more thing', an unfinished clause)?",
} as const;

type QuestionId = keyof typeof JEV_TURN_QUESTIONS;

export interface TurnJudgement {
  finished: number | null;
  trailing: number | null;
  ms: number;
  error?: string;
}

export interface JudgeOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function readNoul(answers: unknown, id: QuestionId): number | null {
  const answer = (answers as Record<string, unknown> | null | undefined)?.[id];
  const noul = (answer as { noul?: unknown } | null | undefined)?.noul;
  return typeof noul === 'number' && Number.isFinite(noul) ? Math.min(1, Math.max(0, noul)) : null;
}

/** Ask Jev whether the caller's turn is over. Never throws: any failure is nulls and a reason. */
export async function judgeTurnEnd(
  transcriptSoFar: string,
  recentContext: string,
  opts: JudgeOptions = {},
): Promise<TurnJudgement> {
  const now = opts.now ?? Date.now;
  const started = now();
  const fail = (error: string): TurnJudgement => ({ finished: null, trailing: null, ms: now() - started, error });
  const key = opts.apiKey ?? JEV_API_KEY;
  if (!key) return fail('no_key');
  const state = [
    'A caller is speaking to an AI voice assistant on a phone call. The text is live speech-to-text of the',
    "caller's current turn, so far; it may lack punctuation.",
    '',
    `The assistant last said: ${recentContext.trim() || '(nothing yet)'}`,
    '',
    `The caller so far: ${transcriptSoFar.trim()}`,
  ].join('\n');
  const questions = Object.fromEntries(
    Object.entries(JEV_TURN_QUESTIONS).map(([id, instructions]) => [id, { type: 'noul', instructions }]),
  );
  try {
    const response = await (opts.fetchImpl ?? fetch)(JEV_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state, model: JEV_MODEL, questions }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!response.ok) return fail(`http_${response.status}`);
    const body = (await response.json()) as { answers?: unknown } | null;
    const finished = readNoul(body?.answers, 'finished');
    const trailing = readNoul(body?.answers, 'trailing');
    if (finished === null) return fail('missing_finished');
    if (trailing === null) return fail('missing_trailing');
    return { finished, trailing, ms: now() - started };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout');
    return fail(name === 'SyntaxError' ? 'bad_body' : 'request');
  }
}

export const wordsIn = (text: string): number => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;

/** What the shadow logs a turn's end as, from CallTurns' TurnEnd (or the call's end). */
const END_NAMES: Record<string, string> = { send: 'send-word', asleep: 'timeout' };

interface Judged {
  words: number;
  wouldSend: boolean;
  at: number;
  /** The caller said more after the judged text, before the turn ended. */
  grew: boolean;
}

interface ShadowTurn {
  segment: number;
  text: string;
  words: number;
  changedAt: number;
  judgedTexts: Set<string>;
  judged: Judged[];
  timer?: ReturnType<typeof setTimeout>;
  /** The text went stable while a judgement was in flight: look again when it lands. */
  recheck: boolean;
}

export interface JevTurnShadowDeps {
  callId: string;
  log: (line: string, fields: Record<string, unknown>) => void;
  judge?: (text: string, context: string) => Promise<TurnJudgement>;
  config?: () => JevTurnConfig;
  takeDaily?: (max: number) => DailyTake;
  now?: () => number;
}

/** What CallTurns tells the shadow; it never calls back into the turn. */
export interface TurnShadowSink {
  interim(segment: number, text: string): void;
  ended(segment: number, why: string): void;
}

const fmt = (value: number | null): string => (value === null ? '-' : value.toFixed(2));
const line = (head: string, fields: Record<string, unknown>): string =>
  `${head} ${Object.entries(fields)
    .map(([k, v]) => `${k}=${v === undefined || v === null ? '-' : String(v)}`)
    .join(' ')}`;

/** One per call. */
export class JevTurnShadow implements TurnShadowSink {
  private turn?: ShadowTurn;
  private inFlight = false;
  private calls = 0;
  /** The cap and usage lines already logged this call. */
  private readonly logged = new Set<'call' | 'day' | 'usage'>();
  /** The local day the daily cap was reached; the usage file is left alone until the day changes. */
  private cappedOn?: string;
  private recent: string[] = [];
  private readonly now: () => number;
  private readonly config: () => JevTurnConfig;

  constructor(private readonly deps: JevTurnShadowDeps) {
    this.now = deps.now ?? Date.now;
    this.config = deps.config ?? loadJevTurnConfig;
  }

  /** A line the agent spoke: what the caller's turn answers. */
  context(spoken: string): void {
    this.recent = [...this.recent, spoken.trim().slice(0, 600)].filter(Boolean).slice(-2);
  }

  interim(segment: number, text: string): void {
    if (this.turn && this.turn.segment !== segment) this.ended(this.turn.segment, 'superseded');
    if (!this.turn && !this.config().enabled) return;
    const turn = (this.turn ??= {
      segment,
      text: '',
      words: 0,
      changedAt: this.now(),
      judgedTexts: new Set(),
      judged: [],
      recheck: false,
    });
    if (text === turn.text) return;
    turn.text = text;
    turn.words = wordsIn(text);
    turn.changedAt = this.now();
    for (const j of turn.judged) if (turn.words > j.words) j.grew = true;
    clearTimeout(turn.timer);
    const { pauseMs } = this.config();
    turn.timer = setTimeout(() => this.fire(turn), pauseMs);
    turn.timer.unref?.();
  }

  ended(segment: number, why: string): void {
    const turn = this.turn;
    if (!turn || turn.segment !== segment) return;
    this.turn = undefined;
    clearTimeout(turn.timer);
    const end = this.now();
    const first = turn.judged.find((j) => j.wouldSend);
    const fields = {
      call: this.deps.callId,
      turn: segment,
      endedBy: END_NAMES[why] ?? why,
      words: turn.words,
      judgements: turn.judged.length,
      firstWouldSendMsBeforeEnd: first ? end - first.at : undefined,
      falseWouldSends: turn.judged.filter((j) => j.wouldSend && j.grew).length,
    };
    this.deps.log(line('voice-mode.turn-end jev outcome', fields), { jevTurn: 'outcome', ...fields });
  }

  private fire(turn: ShadowTurn): void {
    if (this.turn !== turn) return;
    const config = this.config();
    if (!config.enabled || turn.words < config.minWords || turn.judgedTexts.has(turn.text)) return;
    if (this.inFlight) {
      turn.recheck = true;
      return;
    }
    if (config.maxPerCall > 0 && this.calls >= config.maxPerCall) {
      this.capped('call', config.maxPerCall);
      return;
    }
    const today = localDay(new Date(this.now()));
    if (this.cappedOn === today) return;
    const daily = (this.deps.takeDaily ?? takeDailyJudgement)(config.maxPerDay);
    if (daily === 'capped') {
      this.cappedOn = today;
      this.capped('day', config.maxPerDay);
      return;
    }
    if (daily === 'failed') {
      this.capped('usage');
      return;
    }
    this.calls++;
    this.inFlight = true;
    const text = turn.text;
    const words = turn.words;
    const pauseMs = this.now() - turn.changedAt;
    turn.judgedTexts.add(text);
    const judge = this.deps.judge ?? judgeTurnEnd;
    void judge(text, this.recent.join('\n'))
      .catch((): TurnJudgement => ({ finished: null, trailing: null, ms: 0, error: 'internal' }))
      .then((result) => {
        this.inFlight = false;
        this.record(turn, config, { words, pauseMs }, result);
        const current = this.turn;
        if (current?.recheck && this.now() - current.changedAt >= config.pauseMs) {
          current.recheck = false;
          this.fire(current);
        }
      });
  }

  private record(
    turn: ShadowTurn,
    config: JevTurnConfig,
    at: { words: number; pauseMs: number },
    result: TurnJudgement,
  ): void {
    const { finished, trailing } = result;
    const wouldSend =
      finished !== null &&
      trailing !== null &&
      finished >= config.thresholds.finished &&
      trailing < config.thresholds.trailing;
    const late = this.turn !== turn;
    if (!late) turn.judged.push({ words: at.words, wouldSend, at: this.now(), grew: turn.words > at.words });
    const fields = {
      call: this.deps.callId,
      turn: turn.segment,
      words: at.words,
      pauseMs: at.pauseMs,
      finished: fmt(finished),
      trailing: fmt(trailing),
      wouldSend,
      ms: result.ms,
      err: result.error,
      ...(late ? { late: true } : {}),
    };
    this.deps.log(line('voice-mode.turn-end jev shadow', fields), { jevTurn: 'shadow', ...fields });
  }

  /** Logs a cap, or a daily count that could not be kept (`usage`, no limit), once per call. */
  private capped(scope: 'call' | 'day' | 'usage', limit?: number): void {
    if (this.logged.has(scope)) return;
    this.logged.add(scope);
    const fields = { call: this.deps.callId, scope, ...(limit !== undefined ? { limit } : {}) };
    this.deps.log(line('voice-mode.turn-end jev capped', fields), { jevTurn: 'capped', ...fields });
  }
}
