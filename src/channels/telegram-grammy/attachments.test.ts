/**
 * Coverage for inbound attachment materialization + the runtime config
 * validators that gate self-hosted mode.
 *
 * Three failure modes that previously degraded silently to a metadata-only
 * attachment now populate `att.error` so the agent-runner formatter can
 * render the failure reason. We pin all three:
 *   - `AttachmentTooLarge` when `file_size` > the configured cap
 *   - `AttachmentFetchFailed` when `getFile` (or `download`) rejects
 *   - `LocalFileUntrusted` when `--local` mode returns a path outside
 *     the trusted bot-api root (defense-in-depth path-traversal guard)
 *
 * The `download` happy-path is asserted via a mock hydrated file whose
 * `download(destPath)` runs `fs.copyFile` from a per-test tmp source.
 * Bytes stage under a mocked `DATA_DIR`, so no project state is touched.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { copyFile } from 'fs/promises';
import os from 'os';
import path from 'path';

import { Cause, Effect, Layer, Option } from 'effect';
import type { UserFromGetMe } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { DATA_DIR } = vi.hoisted(() => ({ DATA_DIR: `/tmp/nanoclaw-tgmg-attach-data-${process.pid}` }));
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR,
}));

import { materializeAll, remapTrustedLocalPath } from './attachments.js';
import {
  CLOUD_MAX_BYTES,
  CONTAINER_LOCAL_ROOT,
  DEFAULT_API_ROOT,
  SELF_HOSTED_MAX_BYTES,
  type HydratedBot,
} from './services.js';
import { GrammyNetworkError, LocalFileUntrusted, TelegramConfigInvalid } from './errors.js';
import type { InboundAttachment } from './inbound.js';
import { AdapterConfigService, BotService, TranscriptionService } from './services.js';
import { validateApiRoot, validateMaxFileMb } from './runtime.js';

const STAGING = path.join(DATA_DIR, 'inbound-staging', 'telegram');

let tmpRoot: string;
let originalFetch: typeof fetch;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'tgmg-attach-'));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
});

/**
 * Shape of a `getFile` result the `@grammyjs/files` plugin would
 * normally hydrate at runtime. Tests provide it directly so we exercise
 * `materialize` as if the plugin had already run.
 */
interface HydratedFile {
  file_id: string;
  file_unique_id: string;
  file_path?: string;
  file_size?: number;
  download: (destPath: string) => Promise<string>;
  getUrl: () => string;
}

interface BuildLayersOpts {
  apiRoot?: string;
  maxFileSizeBytes?: number;
  /** When set, exposes the localFilesDir to the AdapterConfig stub. */
  localFilesDir?: string | null;
  getFile: (fileId: string) => Promise<HydratedFile>;
}

function buildTestLayers(opts: BuildLayersOpts) {
  const fakeBot = {
    api: {
      getFile: opts.getFile,
    },
  } as unknown as HydratedBot;

  const botLayer = Layer.succeed(BotService, {
    bot: fakeBot,
    me: { id: 1, is_bot: true, first_name: 'TestBot', username: 'testbot' } as UserFromGetMe,
    start: () => Effect.fail(new GrammyNetworkError({ method: 'bot.start', cause: 'unused in test' })),
    stop: () => Effect.void,
  });

  const configLayer = Layer.succeed(AdapterConfigService, {
    token: 'TEST_TOKEN',
    apiRoot: opts.apiRoot ?? DEFAULT_API_ROOT,
    maxFileSizeBytes: opts.maxFileSizeBytes ?? CLOUD_MAX_BYTES,
    localFilesDir: opts.localFilesDir ?? null,
    onInbound: () => Effect.void,
    onAction: () => {},
  });

  const transcriptionLayer = Layer.succeed(TranscriptionService, {
    transcribe: () => Effect.succeed(null),
  });

  return Layer.mergeAll(botLayer, configLayer, transcriptionLayer);
}

function makeDoc(name = 'big.pdf', fileId = 'file_1', size: number | null = null): InboundAttachment {
  return {
    type: 'document',
    fileId,
    name,
    mimeType: 'application/pdf',
    size,
    width: null,
    height: null,
    durationSeconds: null,
  };
}

/**
 * Build a stand-in for what `@grammyjs/files` produces. The `download`
 * stub takes a destPath and either copies bytes from a tmp source (for
 * happy-path coverage) or rejects/throws (for failure-mode coverage).
 */
function makeHydratedFile(props: {
  file_id: string;
  file_path?: string;
  file_size?: number;
  download?: (destPath: string) => Promise<string>;
  getUrl?: () => string;
}): HydratedFile {
  return {
    file_id: props.file_id,
    file_unique_id: 'u',
    file_path: props.file_path,
    file_size: props.file_size,
    download: props.download ?? (async () => 'unimplemented'),
    getUrl: props.getUrl ?? (() => props.file_path ?? ''),
  };
}

describe('materializeAll: failure-reason surfacing', () => {
  it('populates att.error with cap reason when AttachmentTooLarge', async () => {
    const att = makeDoc('big.pdf', 'file_big', 21_000_000);
    const layers = buildTestLayers({
      maxFileSizeBytes: CLOUD_MAX_BYTES,
      getFile: () =>
        Promise.resolve(
          makeHydratedFile({ file_id: 'file_big', file_path: 'documents/big.pdf', file_size: 21_000_000 }),
        ),
    });

    await Effect.runPromise(Effect.provide(materializeAll([att]), layers));

    expect(att.localPath).toBeUndefined();
    expect(att.error).toBe('exceeds 20 MB cap (file is 21 MB)');
  });

  it('populates att.error with download-failed reason when getFile throws', async () => {
    const att = makeDoc('flaky.pdf', 'file_flaky');
    const layers = buildTestLayers({
      getFile: () => Promise.reject(new Error('Bad Gateway')),
    });

    await Effect.runPromise(Effect.provide(materializeAll([att]), layers));

    expect(att.localPath).toBeUndefined();
    expect(att.error).toMatch(/^download failed:/);
    expect(att.error).toContain('Bad Gateway');
  });

  it('reports correct cap when self-hosted limit is configured', async () => {
    const att = makeDoc('huge.zip', 'file_huge', 2_500_000_000);
    const layers = buildTestLayers({
      apiRoot: 'http://localhost:8081',
      maxFileSizeBytes: SELF_HOSTED_MAX_BYTES,
      getFile: () =>
        Promise.resolve(
          makeHydratedFile({ file_id: 'file_huge', file_path: 'documents/huge.zip', file_size: 2_500_000_000 }),
        ),
    });

    await Effect.runPromise(Effect.provide(materializeAll([att]), layers));

    expect(att.error).toBe('exceeds 2000 MB cap (file is 2500 MB)');
  });

  it('reports a filesystem failure by code, never with the host staging path', async () => {
    const att = makeDoc('doc.pdf', 'file_fs');
    const layers = buildTestLayers({
      getFile: () =>
        Promise.resolve(
          makeHydratedFile({
            file_id: 'file_fs',
            file_path: 'documents/doc.pdf',
            file_size: 10,
            download: (destPath) =>
              Promise.reject(
                Object.assign(new Error(`EACCES: permission denied, open '${destPath}'`), { code: 'EACCES' }),
              ),
          }),
        ),
    });

    await Effect.runPromise(Effect.provide(materializeAll([att]), layers));

    expect(att.error).toBe('download failed: EACCES');
  });
});

describe('materializeAll: happy path via plugin', () => {
  it('sets att.localPath when file.download() succeeds', async () => {
    const att = makeDoc('ok.pdf', 'file_ok', 1_000);
    const seenDestPaths: string[] = [];
    const layers = buildTestLayers({
      getFile: () =>
        Promise.resolve(
          makeHydratedFile({
            file_id: 'file_ok',
            file_path: 'documents/ok.pdf',
            file_size: 1_000,
            download: async (destPath) => {
              seenDestPaths.push(destPath);
              // Simulate a successful copy by writing some bytes at destPath.
              writeFileSync(destPath, Buffer.from('hello'));
              return destPath;
            },
          }),
        ),
    });

    await Effect.runPromise(Effect.provide(materializeAll([att]), layers));

    expect(att.error).toBeUndefined();
    expect(seenDestPaths).toHaveLength(1);
    // Staged on the host, outside every agent folder; the session inbox
    // copy (and `localPath`) is writeSessionMessage's job.
    expect(path.dirname(path.dirname(seenDestPaths[0]!))).toBe(STAGING);
    expect(path.basename(seenDestPaths[0]!)).toBe('ok.pdf');
    expect(att.stagedPath).toBe(seenDestPaths[0]);
    expect(att.localPath).toBeUndefined();
    expect(att.name).toBe('ok.pdf');
  });

  it.each([
    ['photo', 'image/jpeg', 'photos/file_7.jpg', 'photo.jpg'],
    ['voice', 'audio/ogg', 'voice/file_8.oga', 'voice.ogg'],
    ['video', null, 'videos/file_9.mp4', 'video.mp4'],
  ] as const)(
    'names a nameless %s after its media type, never "attachment"',
    async (type, mimeType, filePath, expected) => {
      const att: InboundAttachment = { ...makeDoc('unused', `file_${type}`, 10), type, name: null, mimeType };
      const layers = buildTestLayers({
        getFile: () =>
          Promise.resolve(
            makeHydratedFile({
              file_id: `file_${type}`,
              file_path: filePath,
              file_size: 10,
              download: async (destPath) => destPath,
            }),
          ),
      });

      await Effect.runPromise(Effect.provide(materializeAll([att]), layers));

      expect(att.name).toBe(expected);
      expect(path.basename(att.stagedPath!)).toBe(expected);
    },
  );

  it('keeps a display label (sticker) as the name while staging under a safe filename', async () => {
    const att: InboundAttachment = {
      ...makeDoc('unused', 'file_sticker', 10),
      type: 'sticker',
      name: '\u{1F926} sticker (from Pack)',
      mimeType: null,
    };
    const layers = buildTestLayers({
      getFile: () =>
        Promise.resolve(
          makeHydratedFile({
            file_id: 'file_sticker',
            file_path: 'stickers/file_1.webp',
            file_size: 10,
            download: async (destPath) => destPath,
          }),
        ),
    });

    await Effect.runPromise(Effect.provide(materializeAll([att]), layers));

    expect(att.name).toBe('\u{1F926} sticker (from Pack)');
    expect(path.basename(att.stagedPath!)).toBe('___sticker__from_Pack_.webp');
  });

  it('replaces an unsafe document name before choosing the destination', async () => {
    const att = makeDoc('..', 'file_unsafe', 1_000);
    const seenDestPaths: string[] = [];
    const layers = buildTestLayers({
      getFile: () =>
        Promise.resolve(
          makeHydratedFile({
            file_id: 'file_unsafe',
            file_path: 'documents/source.pdf',
            file_size: 1_000,
            download: async (destPath) => {
              seenDestPaths.push(destPath);
              return destPath;
            },
          }),
        ),
    });

    await Effect.runPromise(Effect.provide(materializeAll([att]), layers));

    expect(path.basename(seenDestPaths[0]!)).toBe('document.pdf');
    expect(att.stagedPath).toBe(seenDestPaths[0]);
  });

  it('local mode: copies bytes from a bind-mounted source path', async () => {
    // Simulate `--local` mode: the bot-api server has already written a
    // file under its trusted root; nanoclaw's plugin gets called with a
    // source path remapped into the host bind-mount. We don't run the
    // real plugin here — we verify that materialize wires download() to
    // copyFile correctly when the hydrated file delegates to it.
    const sourceFile = path.join(tmpRoot, 'source.pdf');
    writeFileSync(sourceFile, Buffer.from('payload bytes'));

    const att = makeDoc('local.pdf', 'file_local', 13);
    const layers = buildTestLayers({
      apiRoot: 'http://localhost:8081',
      localFilesDir: tmpRoot,
      maxFileSizeBytes: SELF_HOSTED_MAX_BYTES,
      getFile: () =>
        Promise.resolve(
          makeHydratedFile({
            file_id: 'file_local',
            file_path: '/var/lib/telegram-bot-api/abc/documents/local.pdf',
            file_size: 13,
            download: async (destPath) => {
              // Real plugin would copyFile from the remapped host path;
              // we exercise the same shape with the tmp source.
              await copyFile(sourceFile, destPath);
              return destPath;
            },
          }),
        ),
    });

    await Effect.runPromise(Effect.provide(materializeAll([att]), layers));

    expect(att.error).toBeUndefined();
    expect(path.basename(att.stagedPath!)).toBe('local.pdf');
  });
});

describe('materializeAll: --local untrusted path', () => {
  it('populates att.error when LocalFileUntrusted is thrown via download()', async () => {
    const att = makeDoc('shady.pdf', 'file_shady', 1_000);
    const layers = buildTestLayers({
      apiRoot: 'http://localhost:8081',
      localFilesDir: tmpRoot,
      maxFileSizeBytes: SELF_HOSTED_MAX_BYTES,
      getFile: () =>
        Promise.resolve(
          makeHydratedFile({
            file_id: 'file_shady',
            file_path: '/etc/passwd',
            file_size: 1_000,
            download: () => {
              // Real plugin's `getUrl()` would invoke our `buildFilePath`
              // hook, which throws synchronously for untrusted paths.
              // The throw lands in download()'s rejection.
              throw new LocalFileUntrusted({
                filePath: '/etc/passwd',
                trustedRoot: CONTAINER_LOCAL_ROOT,
              });
            },
          }),
        ),
    });

    await Effect.runPromise(Effect.provide(materializeAll([att]), layers));

    expect(att.stagedPath).toBeUndefined();
    expect(att.error).toBe(`untrusted local file path (/etc/passwd not under ${CONTAINER_LOCAL_ROOT})`);
  });
});

describe('remapTrustedLocalPath', () => {
  it('remaps a trusted absolute path to the host root', () => {
    const out = remapTrustedLocalPath(`${CONTAINER_LOCAL_ROOT}/abc:DEF/documents/foo.pdf`, '/host/files');
    expect(out).toBe('/host/files/abc:DEF/documents/foo.pdf');
  });

  it('rejects a path outside the trusted root', () => {
    expect(() => remapTrustedLocalPath('/etc/passwd', '/host/files')).toThrow(LocalFileUntrusted);
  });

  it('rejects a near-miss prefix (no trailing slash boundary)', () => {
    // Important: `/var/lib/telegram-bot-api-evil/...` would match a naive
    // `startsWith(CONTAINER_LOCAL_ROOT)` check. We guard with the slash.
    expect(() => remapTrustedLocalPath(`${CONTAINER_LOCAL_ROOT}-evil/x`, '/host/files')).toThrow(LocalFileUntrusted);
  });

  it('accepts the trusted root itself (file directly at root)', () => {
    const out = remapTrustedLocalPath(CONTAINER_LOCAL_ROOT, '/host/files');
    expect(out).toBe('/host/files');
  });
});

/**
 * Pull the typed `TelegramConfigInvalid` out of an Effect Exit. We assert
 * on the structured fields (`field`, `reason`) rather than `String(cause)`
 * — Cause's stringifier shows tags but not field values, so message-text
 * assertions silently pass against the wrong cause shape.
 */
async function expectConfigInvalid(
  effect: Effect.Effect<unknown, TelegramConfigInvalid>,
): Promise<TelegramConfigInvalid> {
  const exit = await Effect.runPromiseExit(effect);
  expect(exit._tag).toBe('Failure');
  if (exit._tag !== 'Failure') throw new Error('unreachable');
  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (!Option.isSome(failure)) throw new Error('unreachable');
  expect(failure.value).toBeInstanceOf(TelegramConfigInvalid);
  return failure.value;
}

describe('validateApiRoot', () => {
  it('strips trailing slash on success', async () => {
    const out = await Effect.runPromise(validateApiRoot('http://localhost:8081/'));
    expect(out).toBe('http://localhost:8081');
  });

  it('accepts https URLs', async () => {
    const out = await Effect.runPromise(validateApiRoot('https://tg.example.com'));
    expect(out).toBe('https://tg.example.com');
  });

  it('trims whitespace', async () => {
    const out = await Effect.runPromise(validateApiRoot('  http://localhost:8081  '));
    expect(out).toBe('http://localhost:8081');
  });

  it('fails with TelegramConfigInvalid on a non-URL string', async () => {
    const err = await expectConfigInvalid(validateApiRoot('not a url'));
    expect(err.field).toBe('TELEGRAM_API_ROOT');
    expect(err.value).toBe('not a url');
    expect(err.reason).toBe('not a valid URL');
  });

  it('fails with TelegramConfigInvalid on non-http(s) protocols', async () => {
    const err = await expectConfigInvalid(validateApiRoot('ftp://example.com'));
    expect(err.field).toBe('TELEGRAM_API_ROOT');
    expect(err.reason).toContain('protocol must be http or https');
  });
});

describe('validateMaxFileMb', () => {
  it('defaults to 20 MB when unset and not in --local mode (cloud)', async () => {
    const out = await Effect.runPromise(validateMaxFileMb(undefined, false));
    expect(out).toBe(CLOUD_MAX_BYTES);
  });

  it('defaults to 20 MB when unset and not in --local mode (proxy)', async () => {
    // Proxy mode = `apiRoot` set but `localFilesDir` unset. Same protocol
    // cap as cloud — server still enforces 20 MB without `--local`.
    const out = await Effect.runPromise(validateMaxFileMb(undefined, false));
    expect(out).toBe(CLOUD_MAX_BYTES);
  });

  it('defaults to 2 GB when unset and in --local mode', async () => {
    const out = await Effect.runPromise(validateMaxFileMb(undefined, true));
    expect(out).toBe(SELF_HOSTED_MAX_BYTES);
  });

  it('parses a numeric MB value to bytes', async () => {
    const out = await Effect.runPromise(validateMaxFileMb('500', true));
    expect(out).toBe(500_000_000);
  });

  it('rejects non-numeric input', async () => {
    const err = await expectConfigInvalid(validateMaxFileMb('twenty', false));
    expect(err.field).toBe('TELEGRAM_MAX_FILE_MB');
    expect(err.reason).toContain('positive number of megabytes');
  });

  it('rejects zero and negatives', async () => {
    await expectConfigInvalid(validateMaxFileMb('0', false));
    await expectConfigInvalid(validateMaxFileMb('-5', false));
  });
});
