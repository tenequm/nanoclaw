/**
 * Shared containment guards for per-message inbox directories.
 *
 * Session dirs are mounted writable into agent containers, so a compromised
 * agent can pre-place a symlink inside its own session dir and wait for the
 * host to write through it — landing attacker-influenced bytes outside the
 * sandbox (CWE-59). Both inbound paths that materialise files into a session's
 * `inbox/<messageId>/` directory route through `ensureContainedInboxDir`:
 *   - channel-inbound attachments (`extractAttachmentFiles` in session-manager),
 *     inline base64 or staged under `inboundStagingRoot()` by an adapter
 *   - agent-to-agent forwarded files (`forwardAttachedFiles` in agent-route)
 *
 * Keeping the guard in one place means both paths defend identically; the fix
 * for GHSA #2828 originally lived only in the A2A path and the channel path had
 * the same gap (a symlinked `inbox` root was followed silently).
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

/**
 * Host-only directory where a channel adapter that downloads to disk (rather
 * than passing base64 `data`) stages inbound files. `writeSessionMessage`
 * copies a staged file into the session inbox only from under this root.
 * Never mounted into a container.
 */
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

/**
 * Resolve and create `<inboxRoot>/<messageId>`, refusing pre-placed symlinks a
 * compromised container could use to redirect host writes outside the session.
 *
 * Guards, in order:
 *   1. lstat the inbox ROOT — reject if it is a symlink or a non-directory.
 *      Without this, a symlinked `inbox` is silently followed by mkdir AND the
 *      containment check in step 4 passes, because it compares against the
 *      already-followed (escaped) root. This is the gap that affected the
 *      channel-inbound path.
 *   2. lstat the per-message subdir — reject a pre-placed symlink/non-dir.
 *      lstat does not follow the final path component, so it sees the link
 *      itself even when the link target does not exist.
 *   3. mkdir the subdir (recursive).
 *   4. realpath containment — the resolved subdir must stay within the resolved
 *      inbox root (defence in depth; symlinks are already ruled out above).
 *
 * Returns the resolved, contained subdir path (write into it with an exclusive
 * flag — `COPYFILE_EXCL` / `wx` — so a pre-existing symlinked *file* can't be
 * followed either), or `null` if any guard tripped. On `null` the caller logs
 * its own context and skips; `context` is merged into the warn logs here so
 * each call site stays diagnosable.
 */
export function ensureContainedInboxDir(
  inboxRoot: string,
  messageId: string,
  context: Record<string, unknown>,
): string | null {
  const inboxDir = path.join(inboxRoot, messageId);

  for (const dir of [inboxRoot, inboxDir]) {
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        log.warn('inbox-safety: rejecting unsafe inbox path', { ...context, dir });
        return null;
      }
    } catch {
      // Does not exist yet — fine, mkdir below creates it.
    }
  }

  fs.mkdirSync(inboxDir, { recursive: true });

  try {
    const realInboxDir = fs.realpathSync(inboxDir);
    const realInboxRoot = fs.realpathSync(inboxRoot);
    if (!isPathInside(realInboxRoot, realInboxDir)) {
      log.warn('inbox-safety: inbox dir escaped inbox root', { ...context, inboxDir });
      return null;
    }
    return realInboxDir;
  } catch (err) {
    log.warn('inbox-safety: failed to resolve inbox dir', { ...context, inboxDir, err });
    return null;
  }
}
