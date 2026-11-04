---
name: add-mailbox-http
description: Install the HTTP session mailbox transport for runners that cannot share host SQLite files, or restore its payload after an update.
---

# HTTP mailbox

Requires the message-id reply lookup, container turn-state operations, and mailbox
start/stop around PreCompact reads. HTTP becomes the default transport; set
NANOCLAW_MAILBOX_TRANSPORT=sqlite for a configuration-only rollback.

Copy each payload file to the same path at the repository root, replacing both
mailbox compose slots. Keep exactly one mailbox registration in each slot.

```nc:copy
payload/src/mailbox/http/index.ts -> src/mailbox/http/index.ts
payload/src/mailbox/http/server.ts -> src/mailbox/http/server.ts
payload/src/mailbox/http/runner-ops.ts -> src/mailbox/http/runner-ops.ts
payload/src/mailbox/http/index.test.ts -> src/mailbox/http/index.test.ts
payload/src/mailbox/http/server.test.ts -> src/mailbox/http/server.test.ts
payload/container/agent-runner/src/mailbox/http/index.ts -> container/agent-runner/src/mailbox/http/index.ts
payload/container/agent-runner/src/mailbox/http/select.ts -> container/agent-runner/src/mailbox/http/select.ts
payload/container/agent-runner/src/mailbox/http/http.test.ts -> container/agent-runner/src/mailbox/http/http.test.ts
payload/container/mailbox-http.test.ts -> container/mailbox-http.test.ts
payload/src/mailbox/compose.ts -> src/mailbox/compose.ts
payload/container/agent-runner/src/mailbox/compose.ts -> container/agent-runner/src/mailbox/compose.ts
payload/src/modules/mailbox-http/index.ts -> src/modules/mailbox-http/index.ts
```

Append the host lifecycle module import once to src/modules/index.ts.

```nc:append to:src/modules/index.ts
import './mailbox-http/index.js';
```

In container/agent-runner/src/mcp-tools/index.ts, keep the mailbox started after
startMcpServer returns: stop only in catch, then rethrow the error. Tool calls
continue to commit through mailbox.run().

In container/agent-runner/src/poll-loop.ts, directly after markCompleted at the
result door, await getAgentMailbox().run(() => undefined) through a fail-open
refreshMailbox helper that logs failures. This refreshes reply rows written by
the separate MCP process before the nudge decision. Preserve unrelated turn logic.

The host reads process environment before .env. NANOCLAW_MAILBOX_HTTP_BIND defaults
to docker0 on Linux and loopback elsewhere; it never defaults to a wildcard.
NANOCLAW_MAILBOX_HTTP_PORT defaults to 3010. NANOCLAW_MAILBOX_HTTP_URL overrides the
container-facing URL. Choose a bind and URL reachable from the runner network,
including when egress lockdown uses an internal Docker network. Tokens remain
host-only outside the session mounts and rotate at each spawn.

Verify with pnpm exec vitest run src/mailbox/http container/mailbox-http.test.ts
setup/mailbox-compatibility.test.ts src/startup-order.test.ts, then run
bun test src/mailbox src/poll-loop from container/agent-runner. Typecheck both trees.
Keep payload files byte-identical to their applied copies.

See [REMOVE.md](REMOVE.md) for full removal. The local Kubernetes dev kit is separate
from this skill and is not installed or removed by it.
