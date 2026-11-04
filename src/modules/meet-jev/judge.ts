/**
 * The jev call loop's Jev client (JSON state, the pinned `JEV_MODEL`): the Choice `action` about the call
 * window, and the answer-ready Choice `still_wanted`. Any error, timeout or malformed answer is a null
 * verdict: silence for `action` (fail-silent like the chat gate) unless the agent was called by name, which
 * still wakes it; speech for `still_wanted` (the answer was wanted a moment ago).
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

function actionQuestion(agent: string) {
  return {
    type: 'choice',
    instructions: `A live call. \`latest\` is the utterance just finished, the one to decide on; \`window\` is the conversation up to and including it, oldest first, for context (\`t\` = seconds ago; \`agent\` lines are what ${agent} said; \`cut_off\` marks where ${agent} was interrupted; \`partial\` lines are still being spoken). \`policy\` says when ${agent} speaks and \`facts\` what ${agent} is doing now; \`facts.addressed_by_name\` says \`latest\` calls ${agent} by name, which makes it addressed to ${agent} but not necessarily a request to answer now. What should ${agent} do about \`latest\`?`,
    criteria: {
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

function shadowQuestions(agent: string) {
  return {
    wants_reply_now: {
      type: 'noul',
      instructions: `Does \`latest\` ask ${agent} something or ask it to do or say something, with the thought finished? Use \`window\` for context.`,
      criteria: {
        true: `A finished question or request for ${agent}, in English ("${agent}, explain that") or Ukrainian ("${agent}, poyasny tse").`,
        false: `Small talk, a third-person mention, a request to wait or not answer, or a thought still being finished, even after ${agent}'s name.`,
      },
    },
    for_someone_else: {
      type: 'noul',
      instructions: `Is \`latest\` said to a person other than ${agent}? Use \`window\` to resolve who is addressed.`,
      criteria: {
        true: `A remark or request to another person, in English ("Anna, what do you think?") or Ukrainian ("Anno, shcho ty dumayesh?").`,
        false: `An utterance for ${agent}, or an open question without another person as its addressee.`,
      },
    },
    unfinished: {
      type: 'noul',
      instructions: `Is the speaker still finishing the thought in \`latest\`? Use \`window\` for context, including partial lines still being spoken.`,
      criteria: {
        true: `An incomplete thought, in English ("${agent}, I was wondering...") or Ukrainian ("${agent}, ya khotiv zapytaty..."). Saying the agent's name alone does not finish a request.`,
        false: `A complete thought or request that can be understood without the speaker adding more.`,
      },
    },
    already_answered: {
      type: 'noul',
      instructions: `Was what \`latest\` asks already answered in \`window\`, by ${agent} or another person?`,
      criteria: {
        true: `The requested information was already supplied in the conversation, in English ("It is Lima") or Ukrainian ("Tse Lima").`,
        false: `No answer in the window, or latest asks a new question, clarification, or further detail the earlier answer did not cover.`,
      },
    },
  };
}

/** How far a distribution's sum may be from 1 (rounding in Jev's answer) before it is malformed. */
const SUM_TOLERANCE = 0.02;

const unit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function shadowLog(body: unknown) {
  const answers = (body as { answers?: Record<string, unknown> } | null)?.answers;
  const probability = (key: string): number | null => {
    const answer = answers?.[key];
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
    const { type, noul } = answer as Record<string, unknown>;
    return type === 'noul' && unit(noul) ? noul : null;
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

/**
 * Read the answer to Choice `question`; null unless it is well-formed over `options`: every option's
 * probability in 0..1, summing to 1, and a confidence in 0..1. A partly valid answer is not acted on.
 */
function parseChoice<A extends string>(body: unknown, question: string, options: readonly A[]): Choice<A> | null {
  const answer = (body as { answers?: Record<string, unknown> } | null)?.answers?.[question];
  if (!answer || typeof answer !== 'object') return null;
  const { choice, confidence, probabilities } = answer as Record<string, unknown>;
  if (!options.includes(choice as A) || !probabilities || typeof probabilities !== 'object') return null;
  if (!unit(confidence)) return null;
  const probs = {} as Record<A, number>;
  for (const option of options) {
    const p = (probabilities as Record<string, unknown>)[option];
    if (!unit(p)) return null;
    probs[option] = p;
  }
  const sum = options.reduce((total, option) => total + probs[option], 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return null;
  return { action: choice as A, probabilities: probs, confidence };
}

export const parseAction = (body: unknown): Verdict | null => parseChoice(body, 'action', ACTIONS);
export const parseStillWanted = (body: unknown): RecheckVerdict | null =>
  parseChoice(body, 'still_wanted', RECHECK_ACTIONS);

function stillWantedQuestion(agent: string) {
  return {
    type: 'choice',
    instructions: `A live call. ${agent} was asked \`trigger\` and has just prepared \`reply\`, not yet spoken. \`since\` is what people said after \`trigger\` (\`t\` = seconds ago); \`window\` is the whole conversation, oldest first, and \`facts\` what ${agent} is doing now. Should ${agent} still say \`reply\` aloud, or only show it in the chat?`,
    criteria: {
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

export const judgeQuestions = (agent: string) => ({
  action: actionQuestion(agent),
  ...shadowQuestions(agent),
  still_wanted: stillWantedQuestion(agent),
});

interface JudgeOptions {
  signal?: AbortSignal;
  callId?: string;
  windowVersion?: number;
}

async function ask<V>(
  state: unknown,
  questions: Record<string, unknown>,
  parse: (body: unknown) => V | null,
  opts: JudgeOptions,
): Promise<{ verdict: V | null; ms: number }> {
  const started = Date.now();
  const question = Object.keys(questions)[0];
  let verdict: V | null = null;
  let model: unknown = null;
  let usage: unknown = null;
  let answer: unknown = null;
  let responseBody: unknown = null;
  let failure: JevFailure | null = null;
  try {
    const result = await postSystemOne({ state, questions }, opts.signal);
    if (result.ok) {
      responseBody = result.body;
      const body = result.body as { model?: unknown; usage?: unknown; answers?: Record<string, unknown> } | null;
      model = body?.model ?? null;
      usage = body?.usage ?? null;
      answer = body?.answers?.[question] ?? null;
      verdict = parse(result.body);
      if (verdict === null) failure = { category: 'parse', message: `Invalid Choice answer for ${question}` };
    } else {
      failure = result.failure;
    }
  } catch {
    failure = { category: 'request', message: 'Unexpected Jev judge failure' };
  }
  const ms = Date.now() - started;
  log.info('meet-jev: judge', {
    callId: opts.callId ?? null,
    windowVersion: opts.windowVersion ?? null,
    question,
    state,
    model,
    usage,
    answer,
    ms,
    failure,
    ...(question === 'action' ? shadowLog(responseBody) : {}),
  });
  return { verdict, ms };
}

/** Ask Jev what the agent should do about the window. Never throws; null on any failure. */
export const askAction = (state: JevState, opts: JudgeOptions = {}): Promise<{ verdict: Verdict | null; ms: number }> =>
  ask(state, { action: actionQuestion(state.agent_name), ...shadowQuestions(state.agent_name) }, parseAction, opts);

/** Ask Jev whether a landed answer is still wanted. Never throws; null on any failure. */
export const askStillWanted = (
  state: RecheckState,
  opts: JudgeOptions = {},
): Promise<{ verdict: RecheckVerdict | null; ms: number }> =>
  ask(state, { still_wanted: stillWantedQuestion(state.agent_name) }, parseStillWanted, opts);
