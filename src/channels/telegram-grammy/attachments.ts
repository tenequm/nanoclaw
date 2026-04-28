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
 * Runs before the pairing + router handoff so the agent-runner sees the
 * `localPath` + `transcript` fields already populated on
 * `message.content.attachments[]`.
 */
import fs from 'fs/promises';
import path from 'path';

import { Effect } from 'effect';

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

const VOICE_EXTS = new Set(['.ogg', '.oga', '.m4a', '.mp3', '.wav', '.webm']);

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'file';
}

function extFromMime(mime: string | null): string {
  if (!mime) return '';
  const m = mime.toLowerCase();
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('mpeg') && m.startsWith('audio/')) return '.mp3';
  if (m.includes('mp4') && m.startsWith('video/')) return '.mp4';
  if (m.includes('webm')) return '.webm';
  if (m.includes('jpeg')) return '.jpg';
  if (m.includes('png')) return '.png';
  if (m.includes('gif')) return '.gif';
  if (m.includes('webp')) return '.webp';
  return '';
}

/** Deterministic filename from the attachment's semantics + message context. */
function destFilename(att: InboundAttachment, msgId: string, index: number, remotePath: string): string {
  const raw = att.name ?? `${att.type}_${msgId}_${index}`;
  const base = sanitizeName(raw);
  const hasExt = !!path.extname(base);
  if (hasExt) return base;
  const guess = extFromMime(att.mimeType) || path.extname(remotePath) || '';
  return `${base}${guess}`;
}

/**
 * Download one attachment's bytes. Mutates `att` in place with `localPath`
 * + optional `transcript` on success. Returns tagged errors on failure.
 */
export const materialize = Effect.fn('telegram-grammy.materialize')(function* (
  att: InboundAttachment,
  msgId: string,
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
    return yield* Effect.fail(
      new AttachmentTooLarge({ fileId: att.fileId, size, maxBytes: config.maxFileSizeBytes }),
    );
  }

  const remotePath = file.file_path;
  if (!remotePath) {
    return yield* Effect.fail(
      new AttachmentFetchFailed({ fileId: att.fileId, cause: new Error('getFile returned no file_path') }),
    );
  }

  const attachDir = path.join(groupDir, 'attachments');
  yield* Effect.tryPromise({
    try: () => fs.mkdir(attachDir, { recursive: true }),
    catch: (cause) => new AttachmentFetchFailed({ fileId: att.fileId, cause }),
  });

  const fileName = destFilename(att, msgId, index, remotePath);
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

  att.localPath = `agent/attachments/${fileName}`;

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
  msgId: string,
  platformId: string,
) {
  yield* Effect.forEach(
    attachments,
    (att, i) =>
      materialize(att, msgId, i, platformId).pipe(
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
