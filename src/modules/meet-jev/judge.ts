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
    instructions: `A live call: \`window\` is what was said, oldest first (\`t\` = seconds ago; \`agent\` lines are what ${agent} said; \`cut_off\` marks where ${agent} was interrupted; \`partial\` lines are still being spoken). \`policy\` says when ${agent} speaks and \`facts\` what ${agent} is doing now. What should ${agent} do about the latest thing a person said?`,
    criteria: {
      answer: {
        what: `The latest utterance is for ${agent} and needs a reply now: it addresses ${agent} by name, or, as the policy allows, asks a question or makes a request that nobody else is taking up, and the speaker has finished the thought.`,
        not_for: `A remark to another person, a thought still being finished, small talk, or something already answered; ${agent} merely mentioned in the third person.`,
      },
      stay_silent: {
        what: `${agent} should not speak: the utterance is addressed to a person, is small talk or a reaction, is unfinished, was already answered, or people are talking among themselves.`,
        not_for: `A request addressed to ${agent}, or an instruction about what ${agent} is saying or about to say.`,
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

const unit = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;

/** Read the `action` answer; null unless it is a well-formed Choice over our four options. */
export function parseAction(body: unknown): Verdict | null {
  const answer = (body as { answers?: { action?: unknown } } | null)?.answers?.action;
  if (!answer || typeof answer !== 'object') return null;
  const { choice, confidence, probabilities } = answer as Record<string, unknown>;
  if (!ACTIONS.includes(choice as Action) || !probabilities || typeof probabilities !== 'object') return null;
  const conf = unit(confidence);
  if (conf === null) return null;
  const probs = {} as Record<Action, number>;
  for (const action of ACTIONS) probs[action] = unit((probabilities as Record<string, unknown>)[action]) ?? 0;
  return { action: choice as Action, probabilities: probs, confidence: conf };
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
