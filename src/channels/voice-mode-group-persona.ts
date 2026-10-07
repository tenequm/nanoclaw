import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

/** Per-group standing instructions prepended to every provider's project document. */
export const PERSONA_PREPEND_FILE = 'instructions.prepend.md';

/** Standing instructions are a few kilobytes; anything past this is not read. */
export const MAX_PERSONA_READ_BYTES = 64 * 1024;

/**
 * Read a group's standing instructions without following symlinks. O_NONBLOCK
 * because the group folder is writable from the agent container: a FIFO planted
 * at this path would otherwise block the open, and with it the host event loop.
 */
export function readGroupPersona(groupDir: string, fileName: string = PERSONA_PREPEND_FILE): string | null {
  const file = path.join(groupDir, fileName);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    // Bounded: the file is agent-writable and a huge one would stall the host's synchronous read.
    if (stat.size > MAX_PERSONA_READ_BYTES) {
      log.warn('Group standing instructions are oversized; reading only the start', { file, bytes: stat.size });
    }
    const buf = Buffer.alloc(Math.min(stat.size, MAX_PERSONA_READ_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const content = buf.toString('utf-8', 0, n).trim();
    return content || null;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null;
    log.warn('Could not read group standing instructions; omitting persona', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
