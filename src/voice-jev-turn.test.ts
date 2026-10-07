/**
 * The shadow end-of-turn judge: Jev's answers parsed and every failure silent, the trigger's
 * debounce, the outcome counting, the caps, and CallTurns with the shadow attached acting exactly
 * as without it. Jev is mocked at the fetch boundary; nothing here reaches the network.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-jev-turn';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-jev-turn', JEV_API_KEY: '', TIMEZONE: 'UTC' };
});

import type { Heard } from './voice-gemini-live.js';
import {
  DEFAULT_JEV_TURN_CONFIG,
  JevTurnShadow,
  judgeTurnEnd,
  loadJevTurnConfig,
  resetJevTurnConfigCache,
  takeDailyJudgement,
  type JevTurnConfig,
  type JudgeOptions,
  type TurnJudgement,
} from './voice-jev-turn.js';
import { CallTurns, type Transcription } from './voice-livekit-worker.js';

const ENABLED: JevTurnConfig = { ...DEFAULT_JEV_TURN_CONFIG, enabled: true };

const jevBody = (answers: Record<string, unknown>) =>
  new Response(JSON.stringify({ answers }), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.useRealTimers();
});

describe('judgeTurnEnd', () => {
  it('asks the two Nouls and reads them back, clamped', async () => {
    const fetchImpl = vi.fn(async () => jevBody({ finished: { noul: 0.91 }, trailing: { noul: 1.4 } }));
    const result = await judgeTurnEnd('book a table for two', 'Which day?', { apiKey: 'k', fetchImpl });
    expect(result).toMatchObject({ finished: 0.91, trailing: 1 });
    expect(result.error).toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const body = JSON.parse(String(init.body)) as { model: string; state: string; questions: Record<string, unknown> };
    expect(body.model).toBe('jev-latest');
    expect(Object.keys(body.questions).sort()).toEqual(['finished', 'trailing']);
    expect(body.state).toContain('book a table for two');
    expect(body.state).toContain('Which day?');
  });

  it('fails silent: nulls and a reason, never a throw', async () => {
    const cases: Array<[string, JudgeOptions]> = [
      ['no_key', { apiKey: '' }],
      ['http_503', { fetchImpl: async () => new Response('x', { status: 503 }) }],
      ['bad_body', { fetchImpl: async () => new Response('not json', { status: 200 }) }],
      ['missing_trailing', { fetchImpl: async () => jevBody({ finished: { noul: 0.5 } }) }],
      ['missing_finished', { fetchImpl: async () => jevBody({ trailing: { noul: 0.5 } }) }],
      [
        'timeout',
        {
          fetchImpl: async () => {
            throw new DOMException('slow', 'TimeoutError');
          },
        },
      ],
      [
        'request',
        {
          fetchImpl: async () => {
            throw new TypeError('fetch failed');
          },
        },
      ],
    ];
    for (const [reason, opts] of cases) {
      const result = await judgeTurnEnd('book a table', '', { apiKey: 'k', ...opts });
      expect(result, reason).toMatchObject({ finished: null, trailing: null, error: reason });
    }
    // The host's key comes from config.ts; here it is empty.
    expect((await judgeTurnEnd('book a table', '')).error).toBe('no_key');
  });
});

describe('config and the daily cap', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    resetJevTurnConfigCache();
  });

  it('is off with no file, and picks up an edit', () => {
    expect(loadJevTurnConfig().enabled).toBe(false);
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(TEST_DIR, 'jev-turn.json'),
      JSON.stringify({ enabled: true, thresholds: { finished: 0.7 } }),
    );
    expect(loadJevTurnConfig()).toMatchObject({
      enabled: true,
      pauseMs: 1200,
      thresholds: { finished: 0.7, trailing: 0.5 },
    });
    fs.writeFileSync(path.join(TEST_DIR, 'jev-turn.json'), '{ broken');
    resetJevTurnConfigCache();
    expect(loadJevTurnConfig().enabled).toBe(false);
  });

  it('counts judgements per local day in a file', () => {
    const day = new Date('2026-10-07T10:00:00Z');
    expect(takeDailyJudgement(2, day)).toBe('taken');
    expect(takeDailyJudgement(2, day)).toBe('taken');
    expect(takeDailyJudgement(2, day)).toBe('capped');
    expect(takeDailyJudgement(2, new Date('2026-10-08T10:00:00Z'))).toBe('taken');
    expect(takeDailyJudgement(0, day)).toBe('taken');
  });

  it('skips a judgement it cannot account for: the count locked by another process, torn, or unwritable', () => {
    const day = new Date('2026-10-07T10:00:00Z');
    const usage = path.join(TEST_DIR, 'jev-turn-usage.json');
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(`${usage}.lock`, '');
    expect(takeDailyJudgement(5, day)).toBe('failed');
    expect(fs.existsSync(usage)).toBe(false);
    fs.rmSync(`${usage}.lock`);
    expect(takeDailyJudgement(5, day)).toBe('taken');
    // A torn count is never read as zero.
    fs.writeFileSync(usage, '{"day":"2026-10-07","cou');
    expect(takeDailyJudgement(5, day)).toBe('failed');
    expect(fs.readFileSync(usage, 'utf-8')).toBe('{"day":"2026-10-07","cou');
    fs.rmSync(usage);
    fs.chmodSync(TEST_DIR, 0o500);
    try {
      expect(takeDailyJudgement(5, day)).toBe('failed');
    } finally {
      fs.chmodSync(TEST_DIR, 0o700);
    }
    expect(fs.readdirSync(TEST_DIR)).toEqual([]);
  });

  it('takes over a lock a crashed process left behind', () => {
    const day = new Date('2026-10-07T10:00:00Z');
    const lock = path.join(TEST_DIR, 'jev-turn-usage.json.lock');
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(takeDailyJudgement(5, day)).toBe('taken');
    expect(fs.readdirSync(TEST_DIR)).toEqual(['jev-turn-usage.json']);
  });

  it('never over-counts across concurrent processes', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const usage = path.join(TEST_DIR, 'jev-turn-usage.json');
    const tsx = path.resolve('node_modules/.bin/tsx');
    const mod = path.resolve('src/voice-jev-turn.ts');
    const script = [
      `import(${JSON.stringify(mod)}).then(({ takeDailyJudgement }) => {`,
      '  let taken = 0;',
      `  for (let i = 0; i < 150; i++) if (takeDailyJudgement(400, new Date('2026-10-07T10:00:00Z'), ${JSON.stringify(usage)}) === 'taken') taken++;`,
      '  console.log(taken);',
      '});',
    ].join('\n');
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => promisify(execFile)(tsx, ['--eval', script], { cwd: path.resolve('.') })),
    );
    const taken = runs.reduce((sum, run) => sum + Number(run.stdout.trim()), 0);
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThanOrEqual(400);
    expect(JSON.parse(fs.readFileSync(usage, 'utf-8'))).toEqual({ day: '2026-10-07', count: taken });
  }, 30_000);
});

/** A shadow on fake timers with a scripted judge. */
function shadowHarness(
  o: { config?: Partial<JevTurnConfig>; daily?: boolean | 'failed'; answer?: TurnJudgement } = {},
) {
  vi.useFakeTimers();
  const lines: string[] = [];
  const asked: string[] = [];
  const pending: Array<(r: TurnJudgement) => void> = [];
  let auto = true;
  const config = { ...ENABLED, ...o.config };
  const shadow = new JevTurnShadow({
    callId: 'c1',
    log: (line) => void lines.push(line),
    config: () => config,
    takeDaily: () => (o.daily === false ? 'capped' : (o.daily ?? 'taken')),
    judge: (text) => {
      asked.push(text);
      if (auto) return Promise.resolve(o.answer ?? { finished: 0.9, trailing: 0.1, ms: 50 });
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  return {
    shadow,
    lines,
    asked,
    config,
    hold: () => (auto = false),
    release: async (r: TurnJudgement = { finished: 0.9, trailing: 0.1, ms: 50 }) => {
      pending.shift()?.(r);
      await vi.advanceTimersByTimeAsync(0);
    },
    wait: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    shadowLines: () => lines.filter((l) => l.startsWith('voice.turn-end jev shadow')),
    outcome: () => lines.find((l) => l.startsWith('voice.turn-end jev outcome')),
  };
}

describe('JevTurnShadow trigger', () => {
  it('asks nothing while the text keeps changing, then once per distinct stable text', async () => {
    const h = shadowHarness();
    const words = ['book', 'a', 'table', 'for', 'two', 'at', 'eight'];
    for (let i = 3; i <= words.length; i++) {
      h.shadow.interim(1, words.slice(0, i).join(' '));
      await h.wait(500);
    }
    expect(h.asked).toEqual([]);
    await h.wait(700);
    expect(h.asked).toEqual(['book a table for two at eight']);
    // The same text repeated is no change: no second ask.
    h.shadow.interim(1, 'book a table for two at eight');
    await h.wait(5000);
    expect(h.asked).toHaveLength(1);
    expect(h.shadowLines()[0]).toBe(
      'voice.turn-end jev shadow call=c1 turn=1 words=7 pauseMs=1200 finished=0.90 trailing=0.10 wouldSend=true ms=50 err=-',
    );
  });

  it('skips text under minWords, and everything when disabled', async () => {
    const h = shadowHarness();
    h.shadow.interim(1, 'book a');
    await h.wait(3000);
    expect(h.asked).toEqual([]);
    const off = shadowHarness({ config: { enabled: false } });
    off.shadow.interim(1, 'book a table for two');
    await off.wait(3000);
    expect(off.asked).toEqual([]);
    off.shadow.ended(1, 'pause');
    expect(off.lines).toEqual([]);
  });

  it('keeps one judgement in flight, and judges the newer stable text when it lands', async () => {
    const h = shadowHarness();
    h.hold();
    h.shadow.interim(1, 'book a table');
    await h.wait(1200);
    h.shadow.interim(1, 'book a table for two');
    await h.wait(1200);
    expect(h.asked).toEqual(['book a table']);
    await h.release();
    expect(h.asked).toEqual(['book a table', 'book a table for two']);
  });

  it('logs the cap once and stops asking', async () => {
    const h = shadowHarness({ config: { maxPerCall: 1 } });
    h.shadow.interim(1, 'book a table');
    await h.wait(1200);
    h.shadow.interim(1, 'book a table for two');
    await h.wait(1200);
    h.shadow.interim(1, 'book a table for two please');
    await h.wait(1200);
    expect(h.asked).toHaveLength(1);
    expect(h.lines.filter((l) => l.startsWith('voice.turn-end jev capped'))).toEqual([
      'voice.turn-end jev capped call=c1 scope=call limit=1',
    ]);
    const day = shadowHarness({ daily: false });
    day.shadow.interim(1, 'book a table');
    await day.wait(1200);
    expect(day.asked).toEqual([]);
    expect(day.lines).toEqual(['voice.turn-end jev capped call=c1 scope=day limit=1000']);
    const unaccounted = shadowHarness({ daily: 'failed' });
    unaccounted.shadow.interim(1, 'book a table');
    await unaccounted.wait(1200);
    unaccounted.shadow.interim(1, 'book a table for two');
    await unaccounted.wait(1200);
    expect(unaccounted.asked).toEqual([]);
    expect(unaccounted.lines).toEqual(['voice.turn-end jev capped call=c1 scope=usage limit=1000']);
  });

  it('never logs the words', async () => {
    const h = shadowHarness();
    h.shadow.context('Which day suits you?');
    h.shadow.interim(1, 'book a table for two');
    await h.wait(1200);
    h.shadow.ended(1, 'send');
    expect(h.lines.join('\n')).not.toMatch(/book|table|Which/);
  });
});

describe('JevTurnShadow outcome', () => {
  it('counts judgements, the first would-send, and would-sends the caller talked past', async () => {
    const h = shadowHarness();
    h.shadow.interim(3, 'book a table');
    await h.wait(1200); // would-send at t=1200, then the caller goes on: false.
    h.shadow.interim(3, 'book a table for two');
    await h.wait(1200); // would-send at t=2400, the turn's real end.
    await h.wait(600);
    h.shadow.ended(3, 'send');
    expect(h.outcome()).toBe(
      'voice.turn-end jev outcome call=c1 turn=3 endedBy=send-word words=5 judgements=2 firstWouldSendMsBeforeEnd=1800 falseWouldSends=1',
    );
  });

  it('a turn with no would-send, a timeout name, and a judgement that lands after the end', async () => {
    const h = shadowHarness({ answer: { finished: 0.3, trailing: 0.8, ms: 40 } });
    h.shadow.interim(1, 'book a table and also');
    await h.wait(1200);
    h.shadow.ended(1, 'asleep');
    expect(h.outcome()).toBe(
      'voice.turn-end jev outcome call=c1 turn=1 endedBy=timeout words=5 judgements=1 firstWouldSendMsBeforeEnd=- falseWouldSends=0',
    );
    const late = shadowHarness();
    late.hold();
    late.shadow.interim(2, 'book a table');
    await late.wait(1200);
    late.shadow.ended(2, 'hangup');
    await late.release();
    expect(late.outcome()).toContain('endedBy=hangup words=3 judgements=0');
    expect(late.shadowLines()[0]).toMatch(/ late=true$/);
  });

  it('a failed judgement logs its reason and is no would-send', async () => {
    const h = shadowHarness({ answer: { finished: null, trailing: null, ms: 2000, error: 'timeout' } });
    h.shadow.interim(1, 'book a table');
    await h.wait(1200);
    expect(h.shadowLines()[0]).toContain('finished=- trailing=- wouldSend=false ms=2000 err=timeout');
  });
});

const heard = (interim: string, final?: string): Heard => ({
  ...(final !== undefined ? { final } : {}),
  interim,
  finals: final ? 1 : 0,
  failed: false,
  finalizeMs: 0,
});

/** CallTurns with the shadow attached, against a fake transcription. */
function turnsWithShadow(silenceMs: number, wake = false) {
  const h = shadowHarness();
  const results: Heard[] = [];
  const transcriber = {
    ends: 0,
    prepare: async () => true,
    begin: () => undefined,
    push: () => undefined,
    end: async () => {
      transcriber.ends++;
      return results.shift() ?? heard('');
    },
    close: () => undefined,
  } satisfies Transcription & { ends: number };
  const sent: string[] = [];
  const turns = new CallTurns(
    {
      transcriber,
      send: (text) => void sent.push(text),
      lost: () => undefined,
      noise: () => undefined,
      drop: () => undefined,
      cue: () => undefined,
      caption: () => undefined,
      countdown: { stopped: () => undefined, clear: () => undefined },
      changed: () => undefined,
      hold: () => undefined,
      noTurn: () => undefined,
      unheard: () => undefined,
      shadow: h.shadow,
      log: { info: () => undefined, warn: () => undefined },
    },
    { silenceMs, names: ['Andy'], sttModel: 'model' },
  );
  turns.configure(wake, false);
  return { ...h, turns, transcriber, sent, results };
}

describe('JevTurnShadow on CallTurns', () => {
  it('a would-send changes nothing: the turn stays open and nothing is sent or ended', async () => {
    const c = turnsWithShadow(60_000);
    c.turns.onSpeech(true, 0);
    c.turns.onInterim('book a table for two');
    await c.wait(5000);
    expect(c.shadowLines()[0]).toContain('wouldSend=true');
    expect(c.sent).toEqual([]);
    expect(c.transcriber.ends).toBe(0);
    expect(c.turns.turnOpen).toBe(true);
    c.turns.close();
    expect(c.outcome()).toContain('turn=1 endedBy=hangup');
  });

  it('logs the outcome of a turn the closing silence sent', async () => {
    const c = turnsWithShadow(3000);
    c.results.push(heard('book a table for two', 'Book a table for two.'));
    c.turns.onSpeech(true, 0);
    c.turns.onInterim('book a table for two');
    c.turns.onSpeech(false, 0);
    await c.wait(3100);
    expect(c.sent).toEqual(['Book a table for two.']);
    expect(c.outcome()).toMatch(
      /turn=1 endedBy=pause words=5 judgements=1 firstWouldSendMsBeforeEnd=\d+ falseWouldSends=0/,
    );
  });

  it('judges a turn whose only interim holds the wake phrase, on the words after it', async () => {
    const c = turnsWithShadow(60_000, true);
    c.turns.onSpeech(true, 0);
    c.turns.onInterim('Hey Andy book a table for two');
    await c.wait(5000);
    expect(c.asked).toEqual(['book a table for two']);
    c.turns.close();
    expect(c.outcome()).toContain('turn=1 endedBy=hangup words=5 judgements=1');
  });

  it('judges nothing in Manual mode', async () => {
    const c = turnsWithShadow(3000);
    await c.turns.setReviewing(true);
    c.turns.record();
    c.turns.onInterim('book a table for two');
    await c.wait(5000);
    await c.turns.stopRecording();
    expect(c.asked).toEqual([]);
    expect(c.lines).toEqual([]);
  });
});
