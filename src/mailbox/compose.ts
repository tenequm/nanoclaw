/** Singular mailbox composition slot. See docs/agent-mailbox-seam-migration.md. */
import { onHostShutdown, onHostStart } from '../host-lifecycle.js';
import { HttpServedAgentMailbox } from './http/index.js';
import { registerAgentMailbox } from './index.js';

// SQLite storage, reached by containers over the host's mailbox endpoint
// (NANOCLAW_MAILBOX_TRANSPORT=sqlite reverts them to the shared files).
const mailbox = new HttpServedAgentMailbox();
registerAgentMailbox(() => mailbox);
onHostStart(() => mailbox.listen());
onHostShutdown(() => mailbox.close());
