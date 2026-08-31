/**
 * Pond MCP registration: skill-owned logic behind the single `index.ts`
 * reach-in (.claude/skills/add-pond).
 *
 * The host decides which pond stores this container may see by mounting them
 * under /workspace/extra/pond (src/pond-stores.ts); this side only turns each
 * mounted store into a stdio MCP server entry. No mount means no server: the
 * agent never sees a pond tool, and unconfigured groups are unaffected.
 *
 * Naming: with exactly one mounted store the server is plainly `pond` (the
 * common case: a group reading only its own history). With several, each is
 * `pond_<store>` so the agent can tell them apart.
 */
import fs from 'fs';
import path from 'path';

const POND_ROOT = '/workspace/extra/pond';

export function pondMcpServers(
  root = POND_ROOT,
): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return {};
  }

  const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  for (const dir of dirs) {
    const name = dirs.length === 1 ? 'pond' : `pond_${dir}`;
    servers[name] = {
      // Absolute path: stdio-server spawn env is not guaranteed to carry PATH.
      command: '/usr/local/bin/pond',
      args: ['mcp'],
      env: {
        POND_STORAGE_PATH: path.join(root, dir),
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
