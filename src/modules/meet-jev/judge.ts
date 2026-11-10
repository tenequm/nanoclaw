/**
 * The jev call loop's judge: the Choice `action` about the call window, and the answer-ready Choice
 * `still_wanted`, asked through a `DecisionModel` whose one implementation is the Jev client (JSON state,
 * the pinned `JEV_MODEL`). Any error, timeout or malformed answer is a null verdict: silence for `action`
 * (fail-silent like the chat gate) unless the agent was called by name, which still wakes it; speech for
 * `still_wanted` (the answer was wanted a moment ago).
 */
import { log } from '../../log.js';
import { postSystemOne, type JevFailure } from '../jev-gate/jev.js';
import {
  ACTIONS,
  RECHECK_ACTIONS,
  type Choice,
  type JevState,
  type RecheckState,
  type RecheckVerdict,
  type Verdict,
} from './core/types.js';

/*
 * The shape of LiveKit's `llm.DecisionModel`, without its dependency (the host process does not load
 * agents-js), so another judge plugs in with a small adapter. Unlike LiveKit's, the input stays a JSON
 * object and a Choice's options keep `{what, not_for}`: as strings they move Jev's answers and flip
 * real decisions.
 */

export interface ChoiceDecision {
  kind: 'choice';
  prompt: string;
  options: Record<string, { what: string; not_for: string }>;
}

export interface ProbabilityDecision {
  kind: 'probability';
  prompt: string;
  criteria: { true: string; false: string };
}

export type Decision = ChoiceDecision | ProbabilityDecision;

export interface ChoiceResult {
  kind: 'choice';
  value: string;
  /** Every option's probability, each in 0..1, summing to 1. */
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ProbabilityResult {
  kind: 'probability';
  value: number;
}

export type DecisionResult = ChoiceResult | ProbabilityResult;

export interface DecisionResponse {
  /** Well-formed answers by decision name; each requested name is here or in `errors`. */
  results: Record<string, DecisionResult>;
  errors: Record<string, string>;
  model: unknown;
  usage: unknown;
  /** Each decision's answer as the provider sent it, well-formed or not, for the log. */
  answers: Record<string, unknown>;
}

/** A request that got no usable response; `evaluate` rejects with it. */
export class DecisionError extends Error {
  readonly failure: JevFailure;
  constructor(failure: JevFailure) {
    super(failure.message);
    this.name = 'DecisionError';
    this.failure = failure;
  }
}

export interface DecisionModel {
  evaluate(request: {
    input: unknown;
    decisions: Readonly<Record<string, Decision>>;
    signal?: AbortSignal;
  }): Promise<DecisionResponse>;
}

function actionDecision(agent: string): ChoiceDecision {
  return {
    kind: 'choice',
    prompt: `A live call. \`latest\` is the utterance just finished, the one to decide on; \`window\` is the conversation up to and including it, oldest first, for context (\`t\` = seconds ago; \`agent\` lines are what ${agent} said; \`cut_off\` marks where ${agent} was interrupted; \`partial\` lines are still being spoken). \`policy\` says when ${agent} speaks and \`facts\` what ${agent} is doing now; \`facts.addressed_by_name\` says \`latest\` calls ${agent} by name, which makes it addressed to ${agent} but not necessarily a request to answer now. What should ${agent} do about \`latest\`?`,
    options: {
      answer: {
        what: `The latest utterance is for ${agent} and needs a reply now: a question or request to ${agent} by name (facts.addressed_by_name); an answer or information the speaker gives right after ${agent} asked them something (${agent}'s last line in \`window\` is a question to them); or, as the policy allows, a question or request that nobody else is taking up; and the speaker has finished the thought. facts.latest_is_question and facts.latest_to_you are computed from the words of latest; people speak Ukrainian and English, often mixed.`,
        not_for: `A remark to another person, a thought still being finished (also after ${agent}'s name, "${agent}, I was wondering..."), small talk, or something already answered; ${agent} merely mentioned in the third person; ${agent} told by name not to answer or to wait ("${agent}, don't answer that", "${agent}, wait for Anna").`,
      },
      stay_silent: {
        what: `${agent} should not speak: the utterance is addressed to a person, is small talk or a reaction, is unfinished, was already answered, people are talking among themselves, or ${agent} is told by name to hold back ("${agent}, don't answer that", "${agent}, wait for Anna", an unfinished "${agent}, I was wondering").`,
        not_for: `A finished question or request to ${agent}, an answer to a question ${agent} just asked, or an instruction about what ${agent} is saying or about to say.`,
      },
      stop: {
        what: `Someone tells ${agent} to stop or be quiet, or says the answer ${agent} is giving or preparing is no longer needed.`,
        not_for: `Anything said while ${agent} is neither speaking nor preparing an answer (facts.agent_speaking and facts.pending_answer both false); "stop" said to a person.`,
      },
      continue: {
        what: `Someone asks ${agent} to go on with what ${agent} was saying when cut off (facts.cut_off_after).`,
        not_for: `Any request when ${agent} was not cut off (facts.cut_off_after is null); a new question.`,
      },
    },
  };
}

function shadowDecisions(agent: string): Record<string, ProbabilityDecision> {
  return {
    wants_reply_now: {
      kind: 'probability',
      prompt: `Does \`latest\` ask ${agent} something or ask it to do or say something, with the thought finished? Use \`window\` for context.`,
      criteria: {
        true: `A finished question or request for ${agent}, in English ("${agent}, explain that") or Ukrainian ("${agent}, poyasny tse").`,
        false: `Small talk, a third-person mention, a request to wait or not answer, or a thought still being finished, even after ${agent}'s name.`,
      },
    },
    for_someone_else: {
      kind: 'probability',
      prompt: `Is \`latest\` said to a person other than ${agent}? Use \`window\` to resolve who is addressed.`,
      criteria: {
        true: `A remark or request to another person, in English ("Anna, what do you think?") or Ukrainian ("Anno, shcho ty dumayesh?").`,
        false: `An utterance for ${agent}, or an open question without another person as its addressee.`,
      },
    },
    unfinished: {
      kind: 'probability',
      prompt: `Is the speaker still finishing the thought in \`latest\`? Use \`window\` for context, including partial lines still being spoken.`,
      criteria: {
        true: `An incomplete thought, in English ("${agent}, I was wondering...") or Ukrainian ("${agent}, ya khotiv zapytaty..."). Saying the agent's name alone does not finish a request.`,
        false: `A complete thought or request that can be understood without the speaker adding more.`,
      },
    },
    already_answered: {
      kind: 'probability',
      prompt: `Was what \`latest\` asks already answered in \`window\`, by ${agent} or another person?`,
      criteria: {
        true: `The requested information was already supplied in the conversation, in English ("It is Lima") or Ukrainian ("Tse Lima").`,
        false: `No answer in the window, or latest asks a new question, clarification, or further detail the earlier answer did not cover.`,
      },
    },
  };
}

function stillWantedDecision(agent: string): ChoiceDecision {
  return {
    kind: 'choice',
    prompt: `A live call. ${agent} was asked \`trigger\` and has just prepared \`reply\`, not yet spoken. \`since\` is what people said after \`trigger\` (\`t\` = seconds ago); \`window\` is the whole conversation, oldest first, and \`facts\` what ${agent} is doing now. Should ${agent} still say \`reply\` aloud, or only show it in the chat?`,
    options: {
      speak: {
        what: `The reply is still wanted: nobody answered \`trigger\` meanwhile, it was not withdrawn, and what people said since leaves room for it (also a follow-up to ${agent}, or small talk while waiting).`,
        not_for: `\`trigger\` already answered by a person, withdrawn ("never mind", "forget it"), or the conversation clearly moved on.`,
      },
      show: {
        what: `Saying the reply now would talk past the room: a person already answered \`trigger\`, it was withdrawn, or the conversation moved on to something else.`,
        not_for: `Anything that still leaves the reply useful; when unsure, speak.`,
      },
    },
  };
}

const toJevQuestion = (decision: Decision) =>
  decision.kind === 'choice'
    ? { type: 'choice', instructions: decision.prompt, criteria: decision.options }
    : { type: 'noul', instructions: decision.prompt, criteria: decision.criteria };

export const judgeQuestions = (agent: string) =>
  Object.fromEntries(
    Object.entries({
      action: actionDecision(agent),
      ...shadowDecisions(agent),
      still_wanted: stillWantedDecision(agent),
    }).map(([name, decision]) => [name, toJevQuestion(decision)]),
  );

/** How far a distribution's sum may be from 1 (rounding in Jev's answer) before it is malformed. */
const SUM_TOLERANCE = 0.02;

const unit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const answersOf = (body: unknown) => (body as { answers?: Record<string, unknown> } | null)?.answers;

/**
 * Read a Choice answer; null unless it is well-formed over `options`: every option's probability in 0..1,
 * summing to 1, and a confidence in 0..1. A partly valid answer is not acted on.
 */
function choiceResult(answer: unknown, options: readonly string[]): ChoiceResult | null {
  if (!answer || typeof answer !== 'object') return null;
  const { choice, confidence, probabilities } = answer as Record<string, unknown>;
  if (!options.includes(choice as string) || !probabilities || typeof probabilities !== 'object') return null;
  if (!unit(confidence)) return null;
  const probs: Record<string, number> = {};
  for (const option of options) {
    const p = (probabilities as Record<string, unknown>)[option];
    if (!unit(p)) return null;
    probs[option] = p;
  }
  const sum = options.reduce((total, option) => total + probs[option], 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return null;
  return { kind: 'choice', value: choice as string, probabilities: probs, confidence };
}

function probabilityResult(answer: unknown): ProbabilityResult | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const { type, noul } = answer as Record<string, unknown>;
  return type === 'noul' && unit(noul) ? { kind: 'probability', value: noul } : null;
}

/** Jev's System One: one request, no retries, within `JEV_TIMEOUT_MS`. */
const jev: DecisionModel = {
  async evaluate({ input, decisions, signal }) {
    const questions = Object.fromEntries(
      Object.entries(decisions).map(([name, decision]) => [name, toJevQuestion(decision)]),
    );
    const result = await postSystemOne({ state: input, questions }, signal);
    if (!result.ok) throw new DecisionError(result.failure);
    const body = result.body as { model?: unknown; usage?: unknown } | null;
    const response: DecisionResponse = {
      results: {},
      errors: {},
      model: body?.model ?? null,
      usage: body?.usage ?? null,
      answers: {},
    };
    for (const [name, decision] of Object.entries(decisions)) {
      const answer = answersOf(result.body)?.[name];
      response.answers[name] = answer;
      const parsed =
        decision.kind === 'choice' ? choiceResult(answer, Object.keys(decision.options)) : probabilityResult(answer);
      if (parsed) response.results[name] = parsed;
      else response.errors[name] = `Invalid ${decision.kind} answer`;
    }
    return response;
  },
};

function verdictOf<A extends string>(result: DecisionResult | undefined, options: readonly A[]): Choice<A> | null {
  if (result?.kind !== 'choice' || !options.includes(result.value as A)) return null;
  const probabilities = {} as Record<A, number>;
  for (const option of options) {
    if (!(option in result.probabilities)) return null;
    probabilities[option] = result.probabilities[option];
  }
  return { action: result.value as A, probabilities, confidence: result.confidence };
}

export const parseAction = (body: unknown): Verdict | null =>
  verdictOf(choiceResult(answersOf(body)?.action, ACTIONS) ?? undefined, ACTIONS);
export const parseStillWanted = (body: unknown): RecheckVerdict | null =>
  verdictOf(choiceResult(answersOf(body)?.still_wanted, RECHECK_ACTIONS) ?? undefined, RECHECK_ACTIONS);

function shadowLog(response: DecisionResponse | null) {
  const probability = (name: string): number | null => {
    const result = response?.results[name];
    return result?.kind === 'probability' ? result.value : null;
  };
  const shadow = {
    wants_reply_now: probability('wants_reply_now'),
    for_someone_else: probability('for_someone_else'),
    unfinished: probability('unfinished'),
    already_answered: probability('already_answered'),
  };
  const shadow_rule =
    shadow.wants_reply_now !== null &&
    shadow.wants_reply_now >= 0.7 &&
    shadow.for_someone_else !== null &&
    shadow.for_someone_else < 0.3 &&
    shadow.unfinished !== null &&
    shadow.unfinished < 0.3 &&
    shadow.already_answered !== null &&
    shadow.already_answered < 0.5
      ? 'answer'
      : 'stay_silent';
  return { shadow, shadow_rule };
}

interface JudgeOptions {
  signal?: AbortSignal;
  callId?: string;
  windowVersion?: number;
}

/** Ask `decisions` about `state`; the verdict is read from the first decision's result. */
async function ask<V>(
  state: unknown,
  decisions: Record<string, Decision>,
  verdict: (result: DecisionResult | undefined) => V | null,
  opts: JudgeOptions,
): Promise<{ verdict: V | null; ms: number }> {
  const started = Date.now();
  const question = Object.keys(decisions)[0];
  let response: DecisionResponse | null = null;
  let answer: V | null = null;
  let failure: JevFailure | null = null;
  try {
    response = await jev.evaluate({ input: state, decisions, signal: opts.signal });
    answer = verdict(response.results[question]);
    if (answer === null) failure = { category: 'parse', message: `Invalid Choice answer for ${question}` };
  } catch (err) {
    failure =
      err instanceof DecisionError ? err.failure : { category: 'request', message: 'Unexpected Jev judge failure' };
  }
  const ms = Date.now() - started;
  log.info('meet-jev: judge', {
    callId: opts.callId ?? null,
    windowVersion: opts.windowVersion ?? null,
    question,
    state,
    model: response?.model ?? null,
    usage: response?.usage ?? null,
    answer: response?.answers[question] ?? null,
    ms,
    failure,
    ...(question === 'action' ? shadowLog(response) : {}),
  });
  return { verdict: answer, ms };
}

/** Ask Jev what the agent should do about the window. Never throws; null on any failure. */
export const askAction = (state: JevState, opts: JudgeOptions = {}): Promise<{ verdict: Verdict | null; ms: number }> =>
  ask(
    state,
    { action: actionDecision(state.agent_name), ...shadowDecisions(state.agent_name) },
    (result) => verdictOf(result, ACTIONS),
    opts,
  );

/** Ask Jev whether a landed answer is still wanted. Never throws; null on any failure. */
export const askStillWanted = (
  state: RecheckState,
  opts: JudgeOptions = {},
): Promise<{ verdict: RecheckVerdict | null; ms: number }> =>
  ask(
    state,
    { still_wanted: stillWantedDecision(state.agent_name) },
    (result) => verdictOf(result, RECHECK_ACTIONS),
    opts,
  );
