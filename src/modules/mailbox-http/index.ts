import { getSession } from '../../db/sessions.js';
import { deliverSessionMessages } from '../../delivery.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { HttpServedAgentMailbox } from '../../mailbox/http/index.js';
import type { RunnerOpCall } from '../../mailbox/http/runner-ops.js';
import { getAgentMailbox, type MailboxSessionKey } from '../../mailbox/index.js';
import { notePresence } from '../typing/index.js';

/** Deliver a runner's message and follow its turn the moment the write commits, not on the next poll. */
export function onRunnerCommit(key: MailboxSessionKey, calls: readonly RunnerOpCall[]): void {
  const turn = calls.findLast((call) => call.op === 'markContainerTurn')?.args[0];
  if (turn === 'working' || turn === 'idle') notePresence(key.sessionId, { turn, updatedAtMs: Date.now() });
  if (!calls.some((call) => call.op === 'writeMessageOut')) return;
  void getSession(key.sessionId)
    .then((session) => (session ? deliverSessionMessages(session) : undefined))
    .catch((err: unknown) => log.error('Push delivery failed', { sessionId: key.sessionId, err }));
}

// Adopted containers need the endpoint before any new spawn.
onHostStart(async () => {
  const mailbox = getAgentMailbox();
  if (mailbox instanceof HttpServedAgentMailbox) await mailbox.listen(onRunnerCommit);
});
onHostShutdown(async () => {
  const mailbox = getAgentMailbox();
  if (mailbox instanceof HttpServedAgentMailbox) await mailbox.close();
});
