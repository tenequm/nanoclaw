# Remove HTTP mailbox

Set NANOCLAW_MAILBOX_TRANSPORT=sqlite and restart the host and its runners before
removing the transport. This retains existing session storage.

Remove import './mailbox-http/index.js'; from src/modules/index.ts.
Delete the following installed files:

- src/mailbox/http/index.ts
- src/mailbox/http/server.ts
- src/mailbox/http/runner-ops.ts
- src/mailbox/http/index.test.ts
- src/mailbox/http/server.test.ts
- container/agent-runner/src/mailbox/http/index.ts
- container/agent-runner/src/mailbox/http/select.ts
- container/agent-runner/src/mailbox/http/http.test.ts
- container/mailbox-http.test.ts
- src/modules/mailbox-http/index.ts

Restore both src/mailbox/compose.ts and
container/agent-runner/src/mailbox/compose.ts to:

```ts
/** Singular mailbox composition slot. See docs/agent-mailbox-seam-migration.md. */
import { registerAgentMailbox } from './index.js';
import { SqliteAgentMailbox } from './sqlite/index.js';

registerAgentMailbox(() => new SqliteAgentMailbox());
```

For a complete reversal, remove refreshMailbox and its result-door call from
container/agent-runner/src/poll-loop.ts, and restore the try/finally stop in
container/agent-runner/src/mcp-tools/index.ts. Those two changes are harmless if
retained with SQLite. Preserve any unrelated changes to these files.

Remove this skill folder when it is no longer needed. Do not delete session DBs.
Verify both typechecks and the SQLite mailbox tests.
