import fs from 'fs';
import path from 'path';

import { log } from './log.js';

/** Per-group standing instructions prepended to every provider's project document. */
export const PERSONA_PREPEND_FILE = 'instructions.prepend.md';

/**
 * Create a group's standing instructions without following or replacing an
 * existing path. Returns false when the content is empty or the path exists.
 */
export function stageGroupPersona(groupDir: string, instructions: string): boolean {
  const content = instructions.trimEnd();
  if (!content.trim()) return false;

  fs.mkdirSync(groupDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), `${content}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST') return false;
    throw err;
  }
}

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
    if (!fs.fstatSync(fd).isFile()) return null;
    const content = fs.readFileSync(fd, 'utf-8').trim();
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
