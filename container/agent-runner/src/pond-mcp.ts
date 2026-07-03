/**
 * Pond MCP registration — skill-owned logic behind the single `index.ts`
 * reach-in (.claude/skills/add-pond).
 *
 * The host decides which pond stores this container may see by mounting them
 * under /workspace/extra/pond (src/pond-mounts.ts); this side only turns each
 * mounted store into a stdio MCP server entry. No mount → no server → the
 * agent never sees a pond tool, so unconfigured groups are unaffected.
 *
 * Store directories and the server name each maps to:
 * - `own`      → `pond`          — this group's past sessions
 * - `shared`   → `pond_shared`   — all groups' sessions (operator-granted)
 * - `operator` → `pond_operator` — an external pond, e.g. the operator's own
 */
import fs from 'fs';
import path from 'path';

const POND_ROOT = '/workspace/extra/pond';

const STORE_SERVERS: Array<[dir: string, server: string]> = [
  ['own', 'pond'],
  ['shared', 'pond_shared'],
  ['operator', 'pond_operator'],
];

export function pondMcpServers(
  root = POND_ROOT,
): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  for (const [dir, name] of STORE_SERVERS) {
    const storePath = path.join(root, dir);
    if (!fs.existsSync(storePath)) continue;
    servers[name] = {
      // Absolute path: stdio-server spawn env is not guaranteed to carry PATH.
      command: '/usr/local/bin/pond',
      args: ['mcp'],
      env: {
        POND_STORAGE_PATH: storePath,
        // Isolate from any config file and keep pond's state writes (sync
        // lock, last-sync record) off the read-only store mount.
        POND_CONFIG_FILE: '/tmp/pond-unused-config.toml',
        XDG_STATE_HOME: '/tmp/pond-state',
        // pond resolves its embedding-model cache relative to $HOME; the
        // host mounts the model at /home/node/.cache/huggingface.
        HOME: '/home/node',
      },
    };
  }
  return servers;
}
