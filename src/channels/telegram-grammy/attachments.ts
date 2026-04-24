/**
 * Inbound attachment materialization.
 *
 * grammY hands us `file_id`s, not bytes. This module resolves each id via
 * `bot.api.getFile`, streams the payload to `<groupFolder>/attachments/`
 * via `Effect.acquireRelease` (guaranteed cleanup of the write stream
 * even on interrupt), and — for voice/audio — transcribes it through the
 * optional TranscriptionService.
 *
 * Runs before the pairing + router handoff so the agent-runner sees the
 * `localPath` + `transcript` fields already populated on
 * `message.content.attachments[]`.
 */
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';

import { Effect } from 'effect';

import { resolveGroupFolderPath } from '../../group-folder.js';
import { AttachmentFetchFailed, AttachmentTooLarge } from './errors.js';
import type { InboundAttachment } from './inbound.js';
import { AdapterConfigService, BotService, GroupFolderService, TranscriptionService } from './services.js';

const MAX_FILE_SIZE_BYTES = 20_000_000;

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

  const folder = yield* folderSvc.resolveForPlatformId(platformId);
  if (!folder) {
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
  if (size > MAX_FILE_SIZE_BYTES) {
    yield* Effect.logWarning('telegram-grammy: attachment exceeds 20MB, keeping metadata only', {
      fileId: att.fileId,
      size,
    });
    return yield* Effect.fail(new AttachmentTooLarge({ fileId: att.fileId, size }));
  }

  const remotePath = file.file_path;
  if (!remotePath) {
    return yield* Effect.fail(
      new AttachmentFetchFailed({ fileId: att.fileId, cause: new Error('getFile returned no file_path') }),
    );
  }

  const groupDir = resolveGroupFolderPath(folder);
  const attachDir = path.join(groupDir, 'attachments');
  yield* Effect.tryPromise({
    try: () => fs.mkdir(attachDir, { recursive: true }),
    catch: (cause) => new AttachmentFetchFailed({ fileId: att.fileId, cause }),
  });

  const fileName = destFilename(att, msgId, index, remotePath);
  const destPath = path.join(attachDir, fileName);
  const url = `https://api.telegram.org/file/bot${config.token}/${remotePath}`;

  yield* Effect.acquireUseRelease(
    Effect.sync(() => createWriteStream(destPath)),
    (stream) =>
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(url);
          if (!res.ok || !res.body) {
            throw new Error(`Telegram file download ${res.status}`);
          }
          // Node types ReadableStream differently than the web API; the
          // Readable.fromWeb cast is the standard way to bridge.
          await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), stream);
        },
        catch: (cause) => new AttachmentFetchFailed({ fileId: att.fileId, cause }),
      }),
    (stream) =>
      Effect.sync(() => {
        if (!stream.destroyed) stream.destroy();
      }),
  );

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
 * logged and the attachment kept with metadata only — one bad file
 * shouldn't sink the whole inbound.
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
        Effect.catch((err) => Effect.logWarning('telegram-grammy: attachment materialization failed', err)),
      ),
    { concurrency: 3, discard: true },
  );
});
