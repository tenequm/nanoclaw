/**
 * Jev (api.typesafe.ai `systemone`) client, rubric, and the decision math.
 *
 * Jev answers typed questions about a blob of state. We ask four Nouls
 * (probability-of-yes, 0..1) about the chat so far plus the new message, then
 * turn them into wake/silent with thresholds from the per-wiring config.
 *
 * FAIL-SILENT is the contract: a missing key, a non-200, a malformed body, or
 * the 2s timeout all resolve to an error result, and the caller treats that as
 * `silent` — today's behavior for a non-mention message. Failing open would
 * mean one container wake per message on a pattern-everything wiring.
 */
import { JEV_API_KEY } from '../../config.js';
import { log } from '../../log.js';
import type { JevThresholds } from './config.js';

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 2000;

export type JevQuestionId = 'direct_invitation' | 'unresolved' | 'already_answered' | 'human_pingpong';

export type JevScores = Record<JevQuestionId, number>;

export type JevResult = { ok: true; scores: JevScores } | { ok: false; reason: string };

/**
 * The rubric. Wording lives in code and thresholds in config, so a
 * recalibration from logged annotations is a config edit; a change of what we
 * ask is a code change with a commit behind it.
 */
export const JEV_QUESTIONS: Record<JevQuestionId, string> = {
  direct_invitation:
    'Does the NEW MESSAGE invite Dan (the AI assistant in this chat) to speak, or ask for something Dan is uniquely placed to help with — a question about the system, a request for a lookup, research, code, a decision, or an explicit hand-off to him? Answer no when the message is small talk, an acknowledgement, a reaction, or addressed to a specific human.',
  unresolved:
    'Does the NEW MESSAGE leave an open question or request that nobody in the conversation has answered yet?',
  already_answered:
    'Has the substance of the NEW MESSAGE already been answered or handled earlier in this conversation, so that replying again would repeat what was said?',
  human_pingpong:
    'Are two humans in a personal back-and-forth here — a conversation between them where a third party joining in would interrupt rather than help?',
};

function buildQuestions(): Record<string, { type: 'noul'; instructions: string }> {
  const out: Record<string, { type: 'noul'; instructions: string }> = {};
  for (const [id, instructions] of Object.entries(JEV_QUESTIONS)) {
    out[id] = { type: 'noul', instructions };
  }
  return out;
}

function readNoul(answers: unknown, id: JevQuestionId): number | null {
  if (!answers || typeof answers !== 'object') return null;
  const answer = (answers as Record<string, unknown>)[id];
  if (!answer || typeof answer !== 'object') return null;
  const noul = (answer as { noul?: unknown }).noul;
  return typeof noul === 'number' && Number.isFinite(noul) ? Math.min(1, Math.max(0, noul)) : null;
}

/** Ask Jev the rubric about `state`. Never throws. */
export async function askJev(state: string): Promise<JevResult> {
  if (!JEV_API_KEY) return { ok: false, reason: 'no_key' };

  let response: Response;
  try {
    response = await fetch(JEV_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${JEV_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state, model: JEV_MODEL, questions: buildQuestions() }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    log.debug('Jev request failed', { err });
    return { ok: false, reason: timedOut ? 'timeout' : 'request' };
  }

  if (!response.ok) {
    log.debug('Jev returned non-200', { status: response.status });
    return { ok: false, reason: `http_${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    log.debug('Jev returned an unparseable body', { err });
    return { ok: false, reason: 'bad_body' };
  }

  const answers = (body as { answers?: unknown } | null)?.answers;
  const scores: Partial<JevScores> = {};
  for (const id of Object.keys(JEV_QUESTIONS) as JevQuestionId[]) {
    const value = readNoul(answers, id);
    if (value === null) return { ok: false, reason: `missing_${id}` };
    scores[id] = value;
  }
  return { ok: true, scores: scores as JevScores };
}

export interface JevDecision {
  wake: boolean;
  /** max of the two wake signals — the headline number in the annotation. */
  value: number;
  /** max of the two veto signals. */
  veto: number;
  /** Why we stayed silent: the tripped veto, or `below_threshold`. Null on a wake. */
  reason: JevQuestionId | 'below_threshold' | null;
}

/**
 * Wake when either wake signal clears its threshold and neither veto has.
 * Deliberately flat arithmetic: every input lands in the stored annotation, so
 * the thresholds can be refitted from logged decisions without re-deriving a
 * formula.
 */
export function decide(scores: JevScores, thresholds: JevThresholds): JevDecision {
  const value = Math.max(scores.direct_invitation, scores.unresolved);
  const veto = Math.max(scores.already_answered, scores.human_pingpong);
  const vetoed: JevQuestionId | null =
    scores.already_answered >= thresholds.already_answered
      ? 'already_answered'
      : scores.human_pingpong >= thresholds.human_pingpong
        ? 'human_pingpong'
        : null;
  const invited =
    scores.direct_invitation >= thresholds.direct_invitation || scores.unresolved >= thresholds.unresolved;
  return { wake: invited && vetoed === null, value, veto, reason: vetoed ?? (invited ? null : 'below_threshold') };
}
