/** What differs between `/voice jev` and `/meet <link> jev`: the policy paragraph and the numbers. */
import type { CallKind, CallPolicy } from './core/types.js';

export function policyFor(kind: CallKind, agentName: string, agentAliases: string[]): CallPolicy {
  const paragraph =
    kind === 'voice'
      ? `${agentName} is an AI assistant on a live voice call with one caller. ${agentName} answers what the caller says, unless the caller is clearly talking to someone else in the room or has not finished the thought.`
      : `${agentName} is an AI assistant in a live meeting with several people. ${agentName} speaks only when someone addresses it by name or invites it to answer, and nobody else is taking it up; otherwise it stays silent.`;
  return {
    kind,
    agentName,
    agentAliases,
    paragraph,
    boundaryFallbackMs: 700,
    windowMs: 90_000,
    windowBytes: 12_000,
    thresholds: {
      answer: { p: 0.7, confidence: 0.5 },
      stop: { p: 0.7, confidence: 0.5 },
      continue: { p: 0.7, confidence: 0.5 },
    },
    recheckShow: { p: 0.7, confidence: 0.5 },
  };
}
