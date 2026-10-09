import { beforeEach } from 'vitest';

import type { GatewayProviderDefinition } from './gateway-providers/gateway-provider-registry.js';
import { allocateFreePort } from './test-utils/free-port.js';

// Host-start callbacks bind the composed mailbox endpoint, whose fixed default port collides with
// EADDRINUSE across parallel test files; each file gets its own free loopback port instead.
process.env.NANOCLAW_MAILBOX_HTTP_BIND = '127.0.0.1';
process.env.NANOCLAW_MAILBOX_HTTP_PORT = String(await allocateFreePort('127.0.0.1'));

const gateway: GatewayProviderDefinition = {
  kind: 'test-gateway',
  agentSkills: [],
  sessions: {
    async ensure() {
      return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
    },
  },
  approvals: {
    async subscribe(_decide, signal) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  },
};

beforeEach(async () => {
  await import('./mailbox/compose.js');
  (await import('./gateway-providers/index.js')).resetGatewayProvider(gateway);
});
