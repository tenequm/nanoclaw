import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
export function inboundStagingRoot(): string {
  return path.join(DATA_DIR, 'inbound-staging');
}

// Routing copies a staged file into every session within one inbound pass,
// so anything this old has been consumed or abandoned.
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remove staged entries (`<root>/<adapter>/<entry>`) past their routing
 * window. Best-effort: an entry that fails to go stays for the next sweep.
 */
export async function sweepInboundStaging(now = Date.now()): Promise<void> {
  const root = inboundStagingRoot();
  let adapters: string[];
  try {
    adapters = await fs.promises.readdir(root);
  } catch {
    return;
  }
  for (const adapter of adapters) {
    const dir = path.join(root, adapter);
    let entries: string[];
    try {
      if (!(await fs.promises.lstat(dir)).isDirectory()) continue;
      entries = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry);
        try {
          if (now - (await fs.promises.lstat(full)).mtimeMs > STAGING_MAX_AGE_MS) {
            await fs.promises.rm(full, { recursive: true, force: true });
          }
        } catch {
          // Raced with another sweep or unreadable: the next sweep retries.
        }
      }),
    );
  }
}

/** True if `child` is `parent` itself or nested within it (no traversal/escape). */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
