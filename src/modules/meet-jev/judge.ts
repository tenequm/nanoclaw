/**
 * The jev call loop's Jev client: one Choice `action` about the call window (JSON state, the
 * pinned `JEV_MODEL`). Fail-silent like the chat gate: any error, timeout or malformed answer is a
 * null verdict, which the core treats as silence.
 */
import { postSystemOne } from '../jev-gate/jev.js';
import { ACTIONS, type Action, type JevState, type Verdict } from './core/types.js';

function actionQuestion(agent: string) {
  return {
    type: 'choice',
    instructions: `A live call. \`latest\` is the utterance just finished, the one to decide on; \`window\` is the conversation up to and including it, oldest first, for context (\`t\` = seconds ago; \`agent\` lines are what ${agent} said; \`cut_off\` marks where ${agent} was interrupted; \`partial\` lines are still being spoken). \`policy\` says when ${agent} speaks and \`facts\` what ${agent} is doing now; \`facts.addressed_by_name\` says \`latest\` calls ${agent} by name, which makes it addressed to ${agent} but not necessarily a request to answer now. What should ${agent} do about \`latest\`?`,
    criteria: {
      answer: {
        what: `The latest utterance is for ${agent} and needs a reply now: a question or request to ${agent} by name (facts.addressed_by_name), or, as the policy allows, a question or request that nobody else is taking up; and the speaker has finished the thought.`,
        not_for: `A remark to another person, a thought still being finished (also after ${agent}'s name, "${agent}, I was wondering..."), small talk, or something already answered; ${agent} merely mentioned in the third person; ${agent} told by name not to answer or to wait ("${agent}, don't answer that", "${agent}, wait for Anna").`,
      },
      stay_silent: {
        what: `${agent} should not speak: the utterance is addressed to a person, is small talk or a reaction, is unfinished, was already answered, people are talking among themselves, or ${agent} is told by name to hold back ("${agent}, don't answer that", "${agent}, wait for Anna", an unfinished "${agent}, I was wondering").`,
        not_for: `A finished question or request to ${agent}, or an instruction about what ${agent} is saying or about to say.`,
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

/** How far a distribution's sum may be from 1 (rounding in Jev's answer) before it is malformed. */
const SUM_TOLERANCE = 0.02;

const unit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Read the `action` answer; null unless it is a well-formed Choice over our four options: every option's
 * probability in 0..1, summing to 1, and a confidence in 0..1. A partly valid answer is not acted on.
 */
export function parseAction(body: unknown): Verdict | null {
  const answer = (body as { answers?: { action?: unknown } } | null)?.answers?.action;
  if (!answer || typeof answer !== 'object') return null;
  const { choice, confidence, probabilities } = answer as Record<string, unknown>;
  if (!ACTIONS.includes(choice as Action) || !probabilities || typeof probabilities !== 'object') return null;
  if (!unit(confidence)) return null;
  const probs = {} as Record<Action, number>;
  for (const action of ACTIONS) {
    const p = (probabilities as Record<string, unknown>)[action];
    if (!unit(p)) return null;
    probs[action] = p;
  }
  const sum = ACTIONS.reduce((total, action) => total + probs[action], 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return null;
  return { action: choice as Action, probabilities: probs, confidence };
}

/** Ask Jev what the agent should do about the window. Never throws; null on any failure. */
export async function askAction(
  state: JevState,
  opts: { signal?: AbortSignal } = {},
): Promise<{ verdict: Verdict | null; ms: number }> {
  const started = Date.now();
  try {
    const result = await postSystemOne({ state, questions: { action: actionQuestion(state.agent_name) } }, opts.signal);
    return { verdict: result.ok ? parseAction(result.body) : null, ms: Date.now() - started };
  } catch {
    return { verdict: null, ms: Date.now() - started };
  }
}
