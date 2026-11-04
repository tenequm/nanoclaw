/** Singular mailbox composition slot. See docs/agent-mailbox-seam-migration.md. */
import { registerAgentMailbox } from './index.js';
import { ContextSelectedAgentMailbox } from './http/select.js';
import { SqliteAgentMailbox } from './sqlite/index.js';

// SQLite files or the host's HTTP endpoint, as the host's session context selects.
registerAgentMailbox(() => new ContextSelectedAgentMailbox(() => new SqliteAgentMailbox()));
