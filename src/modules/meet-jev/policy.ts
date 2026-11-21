/** What differs between `/voice jev` and `/meet <link> jev`: the policy paragraph and the numbers. */
import { CALL_COMMAND_WORDS } from '../../channels/voice-mode-protocol.js';
import { commandPhrases } from './core/spoken.js';
import type { CallKind, CallPolicy } from './core/types.js';

export function policyFor(kind: CallKind, agentName: string, agentAliases: string[]): CallPolicy {
  const oneCaller = `${agentName} is an AI assistant in a live conversation with one person. ${agentName} answers what the person says, unless they are clearly talking to someone else or have not finished the thought.`;
  const paragraph =
    kind === 'voice'
      ? oneCaller
      : `${agentName} is an AI assistant in a live meeting with several people. ${agentName} speaks only when someone addresses it by name or invites it to answer, and nobody else is taking it up; otherwise it stays silent. A finished question from the person in \`facts.in_exchange_with\` is usually a follow-up to ${agentName}, even without the name.`;
  return {
    kind,
    // The caller's spoken commands, by their rules: a send word releases a listen-until-over draft, a discard drops it.
    ...(kind === 'voice' ? { commands: commandPhrases(CALL_COMMAND_WORDS) } : {}),
    agentName,
    agentAliases,
    paragraph,
    oneCaller: {
      paragraph: oneCaller,
      answer: { p: 0.5 },
      speak: { p: 0.3 },
      continue: { p: 0.5 },
      joinGapMs: 10_000,
    },
    boundaryFallbackMs: 700,
    windowMs: 300_000,
    windowBytes: 24_000,
    thresholds: {
      answer: { p: 0.7 },
      stop: { p: 0.6 },
      continue: { p: 0.7 },
      // A meeting's Choice offers no spoken commands.
      ...(kind === 'voice' ? { send: { p: 0.6 }, discard: { p: 0.6 } } : {}),
    },
    // Live, 6 runs each: a lead-in alone ("Dan, scratch that.") 0.01-0.53, real words before the phrase 0.96-0.99.
    ...(kind === 'voice' ? { newWords: { p: 0.75 } } : {}),
    recheckShow: { p: 0.75 },
  };
}
