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

import { log } from '../../log.js';
import type { JevState } from './core/types.js';
import { askAction, askStillWanted, judgeQuestions, parseAction, parseStillWanted } from './judge.js';

const state: JevState = {
  policy: 'Dan answers the caller.',
  agent_name: 'Dan',
  participants: ['Misha'],
  latest: { speaker: 'Misha', text: 'Dan, what time is it?' },
  window: [{ t: 0.4, speaker: 'Misha', text: 'Dan, what time is it?' }],
  facts: {
    humans_in_room: 1,
    agent_speaking: false,
    pending_answer: false,
    cut_off_after: null,
    agent_last_spoke_s_ago: null,
    last_reply_to: null,
    in_exchange_with: null,
    addressed_by_name: true,
    latest_is_question: true,
    latest_to_you: false,
    latest_language: 'en',
  },
};

const recheckState = {
  ...state,
  latest: undefined,
  trigger: { speaker: 'Misha', text: 'Dan, what is the capital of Peru?' },
  reply: 'Lima.',
  since: [{ t: 1.2, speaker: 'Olena', text: 'It is Lima.' }],
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
  vi.clearAllMocks();
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(body.questions)).toEqual([
      'action',
      'wants_reply_now',
      'for_someone_else',
      'unfinished',
      'already_answered',
    ]);
    for (const key of ['wants_reply_now', 'for_someone_else', 'unfinished', 'already_answered']) {
      expect(body.questions[key]).toMatchObject({
        type: 'noul',
        instructions: expect.stringContaining('`latest`'),
        criteria: { true: expect.any(String), false: expect.any(String) },
      });
    }
    expect(body.questions.action.type).toBe('choice');
    expect(Object.keys(body.questions.action.criteria).sort()).toEqual(['answer', 'continue', 'stay_silent', 'stop']);
    expect(JSON.stringify(body.questions.action.instructions)).toContain('Dan');
  });

  it('logs the exact state and response metadata with call and window identity', async () => {
    const model = 'typesafe/jev-1.14-20261014';
    const usage = { input_tokens: 120, output_tokens: 12 };
    const fetchMock = respond({ model, usage, answers: { action: choice } });
    await askAction(state, { callId: 'c1', windowVersion: 7 });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(log.info).toHaveBeenCalledExactlyOnceWith('meet-jev: judge', {
      callId: 'c1',
      windowVersion: 7,
      question: 'action',
      state: sent.state,
      model,
      usage,
      answer: choice,
      shadow: { wants_reply_now: null, for_someone_else: null, unfinished: null, already_answered: null },
      shadow_rule: 'stay_silent',
      ms: expect.any(Number),
      failure: null,
    });
  });

  it.each(['answer', 'stay_silent', 'stop', 'continue'])(
    'preserves the %s verdict with and without shadow answers',
    async (action) => {
      const actionAnswer = { ...choice, choice: action };
      respond({ answers: { action: actionAnswer } });
      const baseline = (await askAction(state)).verdict;
      for (const wantsReply of [0, 1]) {
        respond({
          answers: {
            action: actionAnswer,
            wants_reply_now: { type: 'noul', noul: wantsReply },
            for_someone_else: { type: 'noul', noul: 0 },
            unfinished: { type: 'noul', noul: 0 },
            already_answered: { type: 'noul', noul: 0 },
          },
        });
        expect((await askAction(state)).verdict).toEqual(baseline);
      }
    },
  );

  it.each([
    undefined,
    null,
    false,
    0.9,
    [],
    {},
    { noul: 0.9 },
    { type: 'choice', noul: 0.9 },
    { type: 'noul', noul: '0.9' },
    { type: 'noul', noul: -0.1 },
    { type: 'noul', noul: 1.1 },
    { type: 'noul', noul: Number.NaN },
    { type: 'noul', noul: Number.POSITIVE_INFINITY },
  ])('logs malformed shadow answers as null without changing the verdict: %j', async (malformed) => {
    respond({
      answers: {
        action: choice,
        wants_reply_now: malformed,
        for_someone_else: malformed,
        unfinished: malformed,
        already_answered: malformed,
      },
    });
    expect((await askAction(state)).verdict).toEqual(parseAction({ answers: { action: choice } }));
    expect(log.info).toHaveBeenCalledWith(
      'meet-jev: judge',
      expect.objectContaining({
        shadow: { wants_reply_now: null, for_someone_else: null, unfinished: null, already_answered: null },
        shadow_rule: 'stay_silent',
        failure: null,
      }),
    );
  });

  it.each([
    [0.7, 0, 0, 0, 'answer'],
    [1, 0.29, 0.29, 0.49, 'answer'],
    [0.69, 0, 0, 0, 'stay_silent'],
    [1, 0.3, 0, 0, 'stay_silent'],
    [1, 0, 0.3, 0, 'stay_silent'],
    [1, 0, 0, 0.5, 'stay_silent'],
    [null, 0, 0, 0, 'stay_silent'],
    [1, null, 0, 0, 'stay_silent'],
    [1, 0, null, 0, 'stay_silent'],
    [1, 0, 0, null, 'stay_silent'],
  ])('logs the shadow rule for %j, %j, %j, %j', async (wants, other, unfinished, answered, rule) => {
    const shadow = {
      wants_reply_now: wants,
      for_someone_else: other,
      unfinished,
      already_answered: answered,
    };
    respond({
      answers: {
        action: choice,
        ...Object.fromEntries(Object.entries(shadow).map(([key, noul]) => [key, { type: 'noul', noul }])),
      },
    });
    await askAction(state);
    expect(log.info).toHaveBeenCalledWith(
      'meet-jev: judge',
      expect.objectContaining({
        shadow,
        shadow_rule: rule,
      }),
    );
  });

  it.each(['http', 'timeout', 'abort', 'bad_body', 'parse', 'request'])(
    'logs a %s failure without credentials or request URLs',
    async (category) => {
      if (category === 'http') respond({}, { ok: false, status: 503 });
      else if (category === 'parse') respond({ model: 'test-model', answers: { action: { choice: 'invalid' } } });
      else if (category === 'bad_body')
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({
            ok: true,
            json: async () => {
              throw new SyntaxError('secret query test-key');
            },
          }),
        );
      else
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockRejectedValue(
              new DOMException(
                'secret query test-key',
                category === 'timeout' ? 'TimeoutError' : category === 'abort' ? 'AbortError' : 'Error',
              ),
            ),
        );
      const result = await askAction(state, { callId: 'c1', windowVersion: 8 });
      expect(result.verdict).toBeNull();
      expect(log.info).toHaveBeenCalledExactlyOnceWith(
        'meet-jev: judge',
        expect.objectContaining({
          callId: 'c1',
          windowVersion: 8,
          state,
          failure: expect.objectContaining({ category, message: expect.any(String) }),
        }),
      );
      expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toMatch(/test-key|secret query|authorization|https:/);
      if (category === 'parse')
        expect(log.info).toHaveBeenCalledWith(
          'meet-jev: judge',
          expect.objectContaining({ model: 'test-model', answer: { choice: 'invalid' } }),
        );
    },
  );

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

  it('rejects a malformed distribution instead of clamping or defaulting it', () => {
    const with_ = (action: Record<string, unknown>) => parseAction({ answers: { action: { ...choice, ...action } } });
    expect(with_({ probabilities: { answer: 0.9, stay_silent: 0.1 } })).toBeNull();
    expect(with_({ probabilities: { answer: 1.01, stay_silent: -0.01, stop: 0, continue: 0 } })).toBeNull();
    expect(with_({ probabilities: { answer: 0.5, stay_silent: 0.1, stop: 0.1, continue: 0.1 } })).toBeNull();
    expect(with_({ probabilities: { answer: 0.9, stay_silent: 0.5, stop: 0.1, continue: 0.1 } })).toBeNull();
    expect(with_({ probabilities: { answer: '0.86', stay_silent: 0.1, stop: 0.03, continue: 0.01 } })).toBeNull();
    expect(with_({ probabilities: { answer: Number.NaN, stay_silent: 0.1, stop: 0.03, continue: 0.01 } })).toBeNull();
    expect(with_({ confidence: 1.2 })).toBeNull();
    expect(with_({ confidence: -0.1 })).toBeNull();
  });

  it('takes a distribution that sums to 1 within rounding', () => {
    const probabilities = { answer: 0.86, stay_silent: 0.1, stop: 0.03, continue: 0.02 };
    expect(parseAction({ answers: { action: { ...choice, probabilities } } })).toEqual({
      action: 'answer',
      probabilities,
      confidence: 0.72,
    });
  });
});

describe('askStillWanted', () => {
  const stillWanted = { type: 'choice', choice: 'show', confidence: 0.8, probabilities: { speak: 0.1, show: 0.9 } };

  it('asks one Choice still_wanted over speak and show with the recheck state', async () => {
    const fetchMock = respond({ answers: { still_wanted: stillWanted } });
    const { verdict } = await askStillWanted(recheckState, { callId: 'c2', windowVersion: 9 });
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      'meet-jev: judge',
      expect.objectContaining({
        callId: 'c2',
        windowVersion: 9,
        question: 'still_wanted',
        state: recheckState,
        answer: stillWanted,
        failure: null,
      }),
    );
    expect(verdict).toEqual({ action: 'show', probabilities: { speak: 0.1, show: 0.9 }, confidence: 0.8 });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body);
    expect(Object.keys(body.questions)).toEqual(['still_wanted']);
    expect(Object.keys(body.questions.still_wanted.criteria).sort()).toEqual(['show', 'speak']);
    expect(body.state).toMatchObject({ reply: 'Lima.', trigger: recheckState.trigger, since: recheckState.since });
  });

  it('is null on a failure or a malformed distribution', async () => {
    respond({}, { ok: false, status: 503 });
    expect((await askStillWanted(recheckState)).verdict).toBeNull();
    expect(
      parseStillWanted({ answers: { still_wanted: { ...stillWanted, probabilities: { show: 0.9 } } } }),
    ).toBeNull();
    expect(
      parseStillWanted({ answers: { still_wanted: { ...stillWanted, probabilities: { speak: 0.5, show: 0.9 } } } }),
    ).toBeNull();
    expect(parseStillWanted({ answers: { action: stillWanted } })).toBeNull();
  });
});

// Captured from the request on main before the judge went through a DecisionModel: the body must stay byte-equal.
const pinnedActionQuestions = {
  action: {
    type: 'choice',
    instructions:
      'A live call. `latest` is the utterance just finished, the one to decide on; `window` is the conversation up to and including it, oldest first, for context (`t` = seconds ago; `agent` lines are what Dan said; `cut_off` marks where Dan was interrupted; `partial` lines are still being spoken). `policy` says when Dan speaks and `facts` what Dan is doing now; `facts.addressed_by_name` says `latest` calls Dan by name, which makes it addressed to Dan but not necessarily a request to answer now. What should Dan do about `latest`?',
    criteria: {
      answer: {
        what: "The latest utterance is for Dan and needs a reply now: a question or request to Dan by name (facts.addressed_by_name); an answer or information the speaker gives right after Dan asked them something (Dan's last line in `window` is a question to them); or, as the policy allows, a question or request that nobody else is taking up; and the speaker has finished the thought. facts.latest_is_question and facts.latest_to_you are computed from the words of latest; people speak Ukrainian and English, often mixed.",
        not_for:
          'A remark to another person, a thought still being finished (also after Dan\'s name, "Dan, I was wondering..."), small talk, or something already answered; Dan merely mentioned in the third person; Dan told by name not to answer or to wait ("Dan, don\'t answer that", "Dan, wait for Anna").',
      },
      stay_silent: {
        what: 'Dan should not speak: the utterance is addressed to a person, is small talk or a reaction, is unfinished, was already answered, people are talking among themselves, or Dan is told by name to hold back ("Dan, don\'t answer that", "Dan, wait for Anna", an unfinished "Dan, I was wondering").',
        not_for:
          'A finished question or request to Dan, an answer to a question Dan just asked, or an instruction about what Dan is saying or about to say.',
      },
      stop: {
        what: 'Someone tells Dan to stop or be quiet, or says the answer Dan is giving or preparing is no longer needed.',
        not_for:
          'Anything said while Dan is neither speaking nor preparing an answer (facts.agent_speaking and facts.pending_answer both false); "stop" said to a person.',
      },
      continue: {
        what: 'Someone asks Dan to go on with what Dan was saying when cut off (facts.cut_off_after).',
        not_for: 'Any request when Dan was not cut off (facts.cut_off_after is null); a new question.',
      },
    },
  },
  wants_reply_now: {
    type: 'noul',
    instructions:
      'Does `latest` ask Dan something or ask it to do or say something, with the thought finished? Use `window` for context.',
    criteria: {
      true: 'A finished question or request for Dan, in English ("Dan, explain that") or Ukrainian ("Dan, poyasny tse").',
      false:
        "Small talk, a third-person mention, a request to wait or not answer, or a thought still being finished, even after Dan's name.",
    },
  },
  for_someone_else: {
    type: 'noul',
    instructions: 'Is `latest` said to a person other than Dan? Use `window` to resolve who is addressed.',
    criteria: {
      true: 'A remark or request to another person, in English ("Anna, what do you think?") or Ukrainian ("Anno, shcho ty dumayesh?").',
      false: 'An utterance for Dan, or an open question without another person as its addressee.',
    },
  },
  unfinished: {
    type: 'noul',
    instructions:
      'Is the speaker still finishing the thought in `latest`? Use `window` for context, including partial lines still being spoken.',
    criteria: {
      true: 'An incomplete thought, in English ("Dan, I was wondering...") or Ukrainian ("Dan, ya khotiv zapytaty..."). Saying the agent\'s name alone does not finish a request.',
      false: 'A complete thought or request that can be understood without the speaker adding more.',
    },
  },
  already_answered: {
    type: 'noul',
    instructions: 'Was what `latest` asks already answered in `window`, by Dan or another person?',
    criteria: {
      true: 'The requested information was already supplied in the conversation, in English ("It is Lima") or Ukrainian ("Tse Lima").',
      false:
        'No answer in the window, or latest asks a new question, clarification, or further detail the earlier answer did not cover.',
    },
  },
};
const pinnedStillWantedQuestions = {
  still_wanted: {
    type: 'choice',
    instructions:
      'A live call. Dan was asked `trigger` and has just prepared `reply`, not yet spoken. `since` is what people said after `trigger` (`t` = seconds ago); `window` is the whole conversation, oldest first, and `facts` what Dan is doing now. Should Dan still say `reply` aloud, or only show it in the chat?',
    criteria: {
      speak: {
        what: 'The reply is still wanted: nobody answered `trigger` meanwhile, it was not withdrawn, and what people said since leaves room for it (also a follow-up to Dan, or small talk while waiting).',
        not_for:
          '`trigger` already answered by a person, withdrawn ("never mind", "forget it"), or the conversation clearly moved on.',
      },
      show: {
        what: 'Saying the reply now would talk past the room: a person already answered `trigger`, it was withdrawn, or the conversation moved on to something else.',
        not_for: 'Anything that still leaves the reply useful; when unsure, speak.',
      },
    },
  },
};

describe('the request to Jev', () => {
  it.each([
    ['action', () => askAction(state), { state, model: 'jev-1.14', questions: pinnedActionQuestions }],
    [
      'still_wanted',
      () => askStillWanted(recheckState),
      { state: recheckState, model: 'jev-1.14', questions: pinnedStillWantedQuestions },
    ],
  ])('is byte-identical to the pinned %s request', async (_question, ask, expected) => {
    const fetchMock = respond({});
    await ask();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, { signal, ...init }] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://jev.test/v1/systemone');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(init).toStrictEqual({
      method: 'POST',
      headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: JSON.stringify(expected),
    });
  });

  it('names every question it can ask, as Jev gets them', () => {
    expect(judgeQuestions('Dan')).toStrictEqual({ ...pinnedActionQuestions, ...pinnedStillWantedQuestions });
  });
});
