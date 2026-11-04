import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { HttpServedAgentMailbox } from '../../mailbox/http/index.js';
import { getAgentMailbox } from '../../mailbox/index.js';

// Adopted containers need the endpoint before any new spawn.
onHostStart(async () => {
  const mailbox = getAgentMailbox();
  if (mailbox instanceof HttpServedAgentMailbox) await mailbox.listen();
});
onHostShutdown(async () => {
  const mailbox = getAgentMailbox();
  if (mailbox instanceof HttpServedAgentMailbox) await mailbox.close();
});
