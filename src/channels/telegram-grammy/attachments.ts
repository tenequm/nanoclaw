/**
 * Inbound attachment materialization.
 *
 * grammY hands us `file_id`s. The `@grammyjs/files` plugin (installed in
 * `BotLayer`) hydrates `bot.api.getFile` results with `download(path)` /
 * `getUrl()`. `download()` auto-dispatches: HTTP fetch when the server
 * returned a relative `file_path` (cloud or non-`--local` self-hosted),
 * `fs.copyFile` when it returned an absolute path (`--local` mode). This
 * module wraps that single call and runs voice/audio transcription
 * afterwards.
 *
 * Bytes land in a host-only staging dir, never in an agent's folder: the
 * message can be routed to several agents, and each one's copy belongs in
 * its own session inbox (`inbox/<message-id>/<filename>`, the Runtime
 * Contract's path). `writeSessionMessage` copies the staged file there per
 * session and sets `localPath`; stale staging dirs are swept here.
 *
 * Runs deferred: the adapter attaches `materializeAll` as the message's
 * `materialize` hook and the router calls it only after the engage, access
 * and scope gates pass, so a refused sender never triggers a download or a
 * transcription. The agent-runner still sees `localPath` + `transcript`
 * populated on `message.content.attachments[]` because the router awaits
 * the hook before writing the message.
 */
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { Effect } from 'effect';

import { extForMime } from '../../attachment-naming.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { inboundStagingRoot } from '../../inbox-safety.js';
import { AttachmentFetchFailed, AttachmentTooLarge, LocalFileUntrusted } from './errors.js';
import type { InboundAttachment } from './inbound.js';
import {
  AdapterConfigService,
  BotService,
  CONTAINER_LOCAL_ROOT,
  GroupFolderService,
  TranscriptionService,
} from './services.js';

/**
 * Translate a server-returned absolute `file_path` (in `--local` mode)
 * to the host-side path nanoclaw can read. The bot-api server in the
 * aiogram image always writes under `/var/lib/telegram-bot-api/...`; we
 * remap that prefix to the configured `localFilesDir` (the host bind-mount
 * target). Anything outside the trusted prefix throws `LocalFileUntrusted`
 * — defense-in-depth against a misconfigured/compromised server returning
 * traversal paths.
 *
 * Synchronous because grammY's `buildFilePath` plugin hook is sync. The
 * throw lands in `materialize`'s `Effect.tryPromise` catch handler and
 * gets re-failed as a typed error.
 */
export function remapTrustedLocalPath(filePath: string, hostRoot: string): string {
  if (filePath !== CONTAINER_LOCAL_ROOT && !filePath.startsWith(CONTAINER_LOCAL_ROOT + '/')) {
    throw new LocalFileUntrusted({ filePath, trustedRoot: CONTAINER_LOCAL_ROOT });
  }
  const tail = filePath.slice(CONTAINER_LOCAL_ROOT.length).replace(/^\/+/, '');
  return path.join(hostRoot, tail);
}

// Routing copies a staged file into every session within the same inbound
// pass, so anything this old has been consumed or abandoned.
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

const stagingDir = (): string => path.join(inboundStagingRoot(), 'telegram');

/** Best-effort removal of staging dirs past their routing window; never fails the inbound. */
async function sweepStaleStaging(dir: string, now: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry);
      try {
        if (now - (await fs.lstat(full)).mtimeMs > STAGING_MAX_AGE_MS)
          await fs.rm(full, { recursive: true, force: true });
      } catch {
        // Raced with another sweep, or unreadable: the next sweep retries.
      }
    }),
  );
}

const VOICE_EXTS = new Set(['.ogg', '.oga', '.m4a', '.mp3', '.wav', '.webm']);

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'file';
}

/**
 * Filename from the attachment's semantics: Telegram's own name when it sent
 * one, else the media type (`photo.jpg`, `voice.ogg`). Each message gets its
 * own inbox dir, so only a second attachment on one message needs a suffix.
 */
function destFilename(att: InboundAttachment, index: number, remotePath: string): string {
  const fallback = index > 0 ? `${att.type}_${index}` : att.type;
  const raw = att.name ?? fallback;
  const base = sanitizeName(isSafeAttachmentName(raw) ? raw : fallback);
  const hasExt = !!path.extname(base);
  if (hasExt) return base;
  const mimeExt = extForMime(att.mimeType);
  const guess = (mimeExt ? `.${mimeExt}` : '') || path.extname(remotePath) || '';
  return `${base}${guess}`;
}

/**
 * Download one attachment's bytes into staging. Mutates `att` in place with
 * its file `name`, `stagedPath` and optional `transcript` on success.
 * Returns tagged errors on failure.
 */
export const materialize = Effect.fn('telegram-grammy.materialize')(function* (
  att: InboundAttachment,
  index: number,
  platformId: string,
) {
  const { bot } = yield* BotService;
  const folderSvc = yield* GroupFolderService;
  const config = yield* AdapterConfigService;
  const transcriber = yield* TranscriptionService;

  // contact / location have no Telegram file — they're pure payload
  // surfaced via the attachment metadata (name field). Skip download.
  if (!att.fileId) return att;

  const groupDir = yield* folderSvc.resolveForPlatformId(platformId);
  if (!groupDir) {
    // Pre-pairing — chat isn't wired to an agent yet. Leave the metadata
    // in place so the pairing flow can inspect it; bytes are intentionally
    // dropped because we have nowhere to put them.
    return att;
  }

  const file = yield* Effect.tryPromise({
    try: () => bot.api.getFile(att.fileId),
    catch: (cause) => new AttachmentFetchFailed({ fileId: att.fileId, cause }),
  });

  const size = file.file_size ?? att.size ?? 0;
  if (size > config.maxFileSizeBytes) {
    yield* Effect.logWarning('telegram-grammy: attachment exceeds size cap, keeping metadata only', {
      fileId: att.fileId,
      size,
      maxBytes: config.maxFileSizeBytes,
    });
    return yield* Effect.fail(new AttachmentTooLarge({ fileId: att.fileId, size, maxBytes: config.maxFileSizeBytes }));
  }

  const remotePath = file.file_path;
  if (!remotePath) {
    return yield* Effect.fail(
      new AttachmentFetchFailed({ fileId: att.fileId, cause: new Error('getFile returned no file_path') }),
    );
  }

  const attachDir = path.join(stagingDir(), randomUUID());
  yield* Effect.tryPromise({
    try: () => fs.mkdir(attachDir, { recursive: true }),
    catch: (cause) => new AttachmentFetchFailed({ fileId: att.fileId, cause }),
  });

  const fileName = destFilename(att, index, remotePath);
  const destPath = path.join(attachDir, fileName);

  // The `@grammyjs/files` plugin handles both HTTP download (cloud /
  // proxy) and local-file copy (`--local` mode) under one call. A
  // `LocalFileUntrusted` thrown synchronously from our `buildFilePath`
  // hook surfaces here as `cause`; we forward it as-is so `materializeAll`
  // can match it in `catchTags`.
  yield* Effect.tryPromise({
    try: () => file.download(destPath),
    catch: (cause) =>
      cause instanceof LocalFileUntrusted ? cause : new AttachmentFetchFailed({ fileId: att.fileId, cause }),
  });

  // Photos, voice notes and video notes carry no name of their own; show the
  // saved file's. A sticker's emoji label or a document's original name stays.
  att.name ??= fileName;
  att.stagedPath = destPath;

  const ext = path.extname(fileName).toLowerCase();
  if (att.type === 'voice' || att.type === 'audio' || VOICE_EXTS.has(ext)) {
    const transcript = yield* transcriber.transcribe(destPath);
    if (transcript) att.transcript = transcript;
  }

  return att;
});

/**
 * Materialize every attachment on a message. Per-attachment failures are
 * surfaced on `att.error` (consumed by the agent-runner formatter) and
 * logged — one bad file shouldn't sink the whole inbound. The
 * `Effect.catchTags` shape gives us exhaustive narrowing across the
 * tagged-error union from `materialize`.
 */
export const materializeAll = Effect.fn('telegram-grammy.materializeAll')(function* (
  attachments: InboundAttachment[],
  platformId: string,
) {
  yield* Effect.promise(() => sweepStaleStaging(stagingDir(), Date.now()));
  yield* Effect.forEach(
    attachments,
    (att, i) =>
      materialize(att, i, platformId).pipe(
        Effect.catchTags({
          AttachmentTooLarge: (err) =>
            Effect.sync(() => {
              const fileMb = Math.round(err.size / 1_000_000);
              const capMb = Math.round(err.maxBytes / 1_000_000);
              att.error = `exceeds ${capMb} MB cap (file is ${fileMb} MB)`;
            }),
          AttachmentFetchFailed: (err) =>
            Effect.sync(() => {
              att.error = `download failed: ${String(err.cause)}`;
            }),
          LocalFileUntrusted: (err) =>
            Effect.sync(() => {
              att.error = `untrusted local file path (${err.filePath} not under ${err.trustedRoot})`;
            }),
        }),
      ),
    { concurrency: 3, discard: true },
  );
});
