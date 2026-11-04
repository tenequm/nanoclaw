import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeEach } from 'vitest';

import type { GatewayProviderDefinition } from './gateway-providers/gateway-provider-registry.js';

// No test may read the checkout's own .env: its keys would leak into config.ts and
// every reader. Guarded at the fs layer because many readers bypass readEnvFile;
// a .env in any other directory (a test's temp dir) reads normally.
const repoRoot = path.resolve(import.meta.dirname, '..');
const repoEnvPaths = new Set([path.join(repoRoot, '.env'), path.join(fs.realpathSync(repoRoot), '.env')]);
const GUARD = Symbol.for('nanoclaw.test.repoEnvGuard');

function isRepoEnv(file: unknown): boolean {
  if (typeof file !== 'string' && !(file instanceof URL) && !Buffer.isBuffer(file)) return false;
  return repoEnvPaths.has(path.resolve(file instanceof URL ? fileURLToPath(file) : String(file)));
}

function enoent(file: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${String(file)}'`), {
    code: 'ENOENT',
    errno: -2,
    syscall: 'open',
    path: String(file),
  });
}

const guarded = globalThis as { [GUARD]?: true };
if (!guarded[GUARD]) {
  guarded[GUARD] = true;
  const { readFileSync, existsSync } = fs;
  const readFile = fs.promises.readFile;
  fs.readFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (isRepoEnv(file)) throw enoent(file);
    return (readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  fs.existsSync = (file) => !isRepoEnv(file) && existsSync(file);
  fs.promises.readFile = ((file: unknown, ...rest: unknown[]) =>
    isRepoEnv(file)
      ? Promise.reject(enoent(file))
      : (readFile as (...a: unknown[]) => Promise<unknown>)(file, ...rest)) as typeof fs.promises.readFile;
  syncBuiltinESMExports(); // named imports (`import { readFileSync } from 'fs'`) see the guard too
}

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
