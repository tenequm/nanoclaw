/** What differs between `/voice jev` and `/meet <link> jev`: the policy paragraph and the numbers. */
import type { CallKind, CallPolicy } from './core/types.js';

export function policyFor(kind: CallKind, agentName: string, agentAliases: string[]): CallPolicy {
  const oneCaller = `${agentName} is an AI assistant in a live conversation with one person. ${agentName} answers what the person says, unless they are clearly talking to someone else or have not finished the thought.`;
  const paragraph =
    kind === 'voice'
      ? oneCaller
      : `${agentName} is an AI assistant in a live meeting with several people. ${agentName} speaks only when someone addresses it by name or invites it to answer, and nobody else is taking it up; otherwise it stays silent. A finished question from the person in \`facts.in_exchange_with\` is usually a follow-up to ${agentName}, even without the name.`;
  return {
    kind,
    agentName,
    agentAliases,
    paragraph,
    oneCaller: {
      paragraph: oneCaller,
      answer: { p: 0.5 },
    },
    boundaryFallbackMs: 700,
    windowMs: 300_000,
    windowBytes: 24_000,
    thresholds: {
      answer: { p: 0.7 },
      stop: { p: 0.6 },
      continue: { p: 0.7 },
    },
    recheckShow: { p: 0.75 },
  };
}
