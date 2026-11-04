/** Singular mailbox composition slot. See docs/agent-mailbox-seam-migration.md. */
import { HttpServedAgentMailbox } from './http/index.js';
import { registerAgentMailbox } from './index.js';

registerAgentMailbox(() => new HttpServedAgentMailbox());
