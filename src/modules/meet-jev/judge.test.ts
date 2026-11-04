/** The jev call loop's Jev client, mocked at the fetch boundary. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ apiKey: 'test-key' }));

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    JEV_URL: 'https://jev.test/v1/systemone',
    JEV_MODEL: 'jev-1.14',
    get JEV_API_KEY() {
      return env.apiKey;
    },
  };
});

import type { JevState } from './core/types.js';
import { askAction, parseAction } from './judge.js';

const state: JevState = {
  policy: 'Dan answers the caller.',
  agent_name: 'Dan',
  participants: ['Misha'],
  window: [{ t: 0.4, speaker: 'Misha', text: 'Dan, what time is it?' }],
  facts: { agent_speaking: false, pending_answer: false, cut_off_after: null, agent_last_spoke_s_ago: null },
};

const choice = {
  type: 'choice',
  choice: 'answer',
  confidence: 0.72,
  probabilities: { answer: 0.86, stay_silent: 0.1, stop: 0.03, continue: 0.01 },
};

function respond(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: init.ok ?? true, status: init.status ?? 200, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  env.apiKey = 'test-key';
});

describe('askAction', () => {
  it('sends the JSON state and one Choice over the four actions to the pinned model', async () => {
    const fetchMock = respond({ model: 'typesafe/jev-1.14-20261014', answers: { action: choice } });
    const { verdict, ms } = await askAction(state);
    expect(verdict).toEqual({ action: 'answer', probabilities: choice.probabilities, confidence: 0.72 });
    expect(ms).toBeGreaterThanOrEqual(0);

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('https://jev.test/v1/systemone');
    expect(init.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('jev-1.14');
    expect(body.state).toEqual(state);
    expect(Object.keys(body.questions)).toEqual(['action']);
    expect(body.questions.action.type).toBe('choice');
    expect(Object.keys(body.questions.action.criteria).sort()).toEqual(['answer', 'continue', 'stay_silent', 'stop']);
    expect(body.questions.action.instructions).toContain('Dan');
  });

  it('is null on a non-200, and releases its unread body', async () => {
    respond({}, { ok: false, status: 503 });
    expect((await askAction(state)).verdict).toBeNull();
    const cancel = vi.fn(async () => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, body: { cancel } }));
    expect((await askAction(state)).verdict).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('is null on a timeout or a rejected fetch, never throwing', async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
    expect((await askAction(state)).verdict).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('econnreset')));
    expect((await askAction(state)).verdict).toBeNull();
  });

  it('is null without an API key, without calling Jev', async () => {
    env.apiKey = '';
    const fetchMock = respond({ answers: { action: choice } });
    expect((await askAction(state)).verdict).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the caller abort signal through', async () => {
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) =>
      init.signal.aborted ? Promise.reject(new DOMException('aborted', 'AbortError')) : Promise.resolve({}),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect((await askAction(state, { signal: AbortSignal.abort() })).verdict).toBeNull();
  });
});

describe('parseAction', () => {
  it('rejects a malformed body', () => {
    expect(parseAction(null)).toBeNull();
    expect(parseAction({ answers: {} })).toBeNull();
    expect(parseAction({ answers: { action: { ...choice, choice: 'shout' } } })).toBeNull();
    expect(parseAction({ answers: { action: { ...choice, confidence: 'high' } } })).toBeNull();
    expect(parseAction({ answers: { action: { ...choice, probabilities: undefined } } })).toBeNull();
  });

  it('clamps probabilities and reads a missing option as 0', () => {
    const verdict = parseAction({
      answers: { action: { ...choice, confidence: 1.2, probabilities: { answer: 1.01, stay_silent: -0.01 } } },
    });
    expect(verdict).toEqual({
      action: 'answer',
      probabilities: { answer: 1, stay_silent: 0, stop: 0, continue: 0 },
      confidence: 1,
    });
  });
});
