import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR } from '../../config.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { inboundStagingRoot } from '../../inbound-staging.js';
import type { DbDriver } from '../../db/driver.js';
import type { DeviceRow } from '../../modules/device-auth/db.js';
import { readSignedBody } from '../../modules/device-auth/verify.js';
import type { OutboundFile } from '../adapter.js';
import { readAppConfig } from './config.js';
import { mintTicket, readTicket, parseAuthorization, type FileAttachment } from './contract.js';
import type { FileRow, ConversationRow } from './db.js';
import { json, type AppHandler, type AppRequest } from './routes.js';

const MAX_BYTES = 26_214_400;
const DAY = 86_400_000;
type StoredFile = FileRow & { sha256: string };
type Claim = { userId: string; conversationId: string; messageId: string; fileIds: string[] };
type Outbound = { userId: string; conversationId: string; messageId: string; files: OutboundFile[] };
export interface FileDeps {
  db: () => DbDriver;
  getLiveDevice(id: string): Promise<DeviceRow | undefined>;
  onDeviceRevoked(listener: (id: string) => void): () => void;
  getConversation(id: string): Promise<ConversationRow | undefined>;
  root?: string;
  stagingRoot?: string;
  ticketKey?: () => Buffer | null;
  readBody?: typeof readSignedBody;
}

function cleanName(value: string): string {
  const name = path.posix
    .basename(value.replaceAll('\\', '/'))
    .split('')
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join('');
  if (!isSafeAttachmentName(name) || Buffer.byteLength(name) > 255)
    throw new FileError(400, 'bad_request', 'Invalid attachment name.');
  return name;
}
class FileError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra = {},
  ) {
    super(message);
  }
}
function refuse(status: number, code: string, message: string): never {
  throw new FileError(status, code, message);
}
function reference(row: StoredFile): FileAttachment {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    kind: row.kind as 'image' | 'file',
    width: row.width,
    height: row.height,
  };
}

export function fileMetadata(data: Buffer, name: string) {
  let mimeType =
    (
      {
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json',
        '.csv': 'text/csv',
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.zip': 'application/zip',
      } as Record<string, string>
    )[path.extname(name).toLowerCase()] || 'application/octet-stream';
  let width: number | null = null,
    height: number | null = null;
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    data.toString('ascii', 12, 16) === 'IHDR'
  ) {
    mimeType = 'image/png';
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
  } else if (data.length >= 10 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) {
    mimeType = 'image/gif';
    width = data.readUInt16LE(6);
    height = data.readUInt16LE(8);
  } else if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) {
    mimeType = 'image/jpeg';
    for (let i = 2; i + 4 <= data.length; ) {
      if (data[i++] !== 255) break;
      while (data[i] === 255) i++;
      const marker = data[i++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (i + 2 > data.length) break;
      const length = data.readUInt16BE(i);
      if (length < 2 || i + length > data.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = data.readUInt16BE(i + 3);
        width = data.readUInt16BE(i + 5);
        break;
      }
      i += length;
    }
  } else if (data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    mimeType = 'image/webp';
    const chunk = data.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && data.length >= 30) {
      width = data.readUIntLE(24, 3) + 1;
      height = data.readUIntLE(27, 3) + 1;
    }
    if (chunk === 'VP8 ' && data.length >= 30 && data.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = data.readUInt16LE(26) & 16383;
      height = data.readUInt16LE(28) & 16383;
    }
    if (chunk === 'VP8L' && data.length >= 25 && data[20] === 47) {
      const bits = data.readUInt32LE(21);
      width = (bits & 16383) + 1;
      height = ((bits >>> 14) & 16383) + 1;
    }
  } else if (data.subarray(0, 5).toString() === '%PDF-') mimeType = 'application/pdf';
  if (!width || !height) {
    width = null;
    height = null;
  }
  return {
    mimeType,
    kind: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)
      ? ('image' as const)
      : ('file' as const),
    width,
    height,
  };
}

async function* boundedBody(req: IncomingMessage, size: number) {
  let count = 0;
  for await (const chunk of req) {
    count += chunk.length;
    if (count > size) refuse(400, 'bad_body', 'Upload exceeds its declared size.');
    yield chunk as Buffer;
  }
}

export function createFileService(deps: FileDeps) {
  const root = deps.root ?? path.join(DATA_DIR, 'app-files');
  const tempRoot = path.join(root, 'tmp');
  const key = () =>
    (deps.ticketKey ?? (() => readAppConfig().ticketKey))() ?? refuse(503, 'unavailable', 'Files are unavailable.');
  const get = (id: string, db = deps.db()) => db.get<StoredFile>('SELECT * FROM app_files WHERE id = ?', id);
  const signedBody = async (ctx: AppRequest) => {
    const auth = parseAuthorization(ctx.req.headers.authorization);
    if (!auth || !ctx.identity) refuse(401, 'bad_signature', 'A signed request is required.');
    return (deps.readBody ?? readSignedBody)(ctx.req, auth.bodyHash, 16_384);
  };
  const own = async (ctx: AppRequest) => {
    if (!ctx.identity) refuse(401, 'bad_signature', 'A signed request is required.');
    const row = await get(ctx.params.id);
    if (!row || row.user_id !== ctx.identity.userId) refuse(404, 'not_found', 'File not found.');
    return row;
  };
  const ticket = async (row: StoredFile, deviceId: string) => {
    const expiresAt = Date.now() + 3_600_000;
    const value = mintTicket(
      {
        v: 1,
        purpose: 'upload',
        fileId: row.id,
        deviceId,
        userId: row.user_id,
        size: row.size,
        sha256: row.sha256,
        exp: expiresAt,
      },
      key(),
    );
    await deps
      .db()
      .run(
        'INSERT INTO app_file_tickets (id, file_id, device_id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        randomUUID(),
        row.id,
        deviceId,
        row.user_id,
        expiresAt,
        Date.now(),
      );
    return {
      fileId: row.id,
      ticket: value,
      expiresAt,
      uploadPath: `/app/files/${row.id}`,
      uploaded: row.uploaded_at !== null,
    };
  };
  const wrap =
    (handler: AppHandler): AppHandler =>
    async (ctx) => {
      try {
        await handler(ctx);
      } catch (error) {
        if (!(error instanceof FileError)) throw error;
        json(ctx.res, error.status, { error: error.code, message: error.message, ...error.extra });
      }
    };
  const mintFile = wrap(async (ctx) => {
    key();
    const body = await signedBody(ctx);
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(body.toString());
    } catch (_error) {
      refuse(400, 'bad_request', 'Invalid JSON.');
    }
    if (!input || typeof input !== 'object') refuse(400, 'bad_request', 'Invalid file metadata.');
    const { uploadKey, size, sha256, mimeType } = input;
    if (!Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > MAX_BYTES)
      throw new FileError(413, 'too_large', 'Files must be between 1 byte and 25 MiB.', { maxBytes: MAX_BYTES });
    if (
      typeof uploadKey !== 'string' ||
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(uploadKey) ||
      typeof sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      typeof input.name !== 'string' ||
      typeof mimeType !== 'string' ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)
    )
      refuse(400, 'bad_request', 'Invalid file metadata.');
    const name = cleanName(input.name);
    const identity = ctx.identity!;
    const row = await deps.db().transaction(async () => {
      await deps
        .db()
        .run(
          'INSERT INTO app_files (id,user_id,device_id,upload_key,name,mime_type,size,sha256,kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (user_id,upload_key) DO NOTHING',
          `file_${randomUUID()}`,
          identity.userId,
          identity.deviceId,
          uploadKey,
          name,
          mimeType,
          size,
          sha256,
          'file',
          Date.now(),
        );
      const existing = (await deps
        .db()
        .get<StoredFile>('SELECT * FROM app_files WHERE user_id = ? AND upload_key = ?', identity.userId, uploadKey))!;
      if (
        existing.name !== name ||
        existing.mime_type !== mimeType ||
        existing.size !== size ||
        existing.sha256 !== sha256
      )
        refuse(409, 'upload_key_conflict', 'That upload key has different file metadata.');
      return existing;
    });
    json(ctx.res, 200, await ticket(row, identity.deviceId));
  });
  const renewFileTicket = wrap(async (ctx) => {
    await signedBody(ctx);
    const row = await own(ctx);
    json(ctx.res, 200, await ticket(row, ctx.identity!.deviceId));
  });
  const uploadFile = wrap(async (ctx) => {
    const secret = key();
    const authorization = ctx.req.headers.authorization ?? '';
    const value = authorization.startsWith('HeyDan-Ticket ') ? authorization.slice(14) : '';
    const claims = readTicket(value, secret);
    if (!claims)
      refuse(
        401,
        readTicket(value, secret, 0) ? 'ticket_expired' : 'bad_signature',
        'The upload ticket is invalid or expired.',
      );
    if (claims.fileId !== ctx.params.id) refuse(401, 'bad_signature', 'The ticket is for another file.');
    const live = async () => {
      const device = await deps.getLiveDevice(claims.deviceId);
      if (!device || device.user_id !== claims.userId)
        refuse(401, 'device_revoked', 'This device is no longer paired.');
    };
    await live();
    const row = await get(claims.fileId);
    if (!row || row.user_id !== claims.userId) refuse(404, 'not_found', 'File not found.');
    if (row.size !== claims.size || row.sha256 !== claims.sha256)
      refuse(409, 'conflict', 'The file has different bytes.');
    const length = ctx.req.headers['content-length'];
    if (length === undefined) refuse(411, 'length_required', 'Content-Length is required.');
    if (!/^\d+$/.test(length) || Number(length) !== claims.size)
      refuse(400, 'bad_request', 'Content-Length does not match the ticket.');
    await fs.mkdir(tempRoot, { recursive: true });
    const temporary = path.join(tempRoot, randomUUID());
    const handle = await fs.open(temporary, 'wx', 0o600);
    let revoked = false;
    const unsubscribe = deps.onDeviceRevoked((id) => {
      if (id === claims.deviceId) {
        revoked = true;
        ctx.req.destroy(new FileError(401, 'device_revoked', 'This device is no longer paired.'));
      }
    });
    const target = path.join(root, row.id);
    let published = false;
    try {
      const hash = createHash('sha256');
      let count = 0;
      for await (const bytes of boundedBody(ctx.req, claims.size)) {
        if (revoked) refuse(401, 'device_revoked', 'This device is no longer paired.');
        hash.update(bytes);
        await handle.writeFile(bytes);
        count += bytes.length;
      }
      if (count !== claims.size || hash.digest('hex') !== claims.sha256)
        refuse(400, 'bad_body', 'Upload does not match its declared hash.');
      await handle.close();
      await live();
      if (revoked) refuse(401, 'device_revoked', 'This device is no longer paired.');
      try {
        await fs.link(temporary, target);
        published = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(target)) hash.update(chunk);
        if (hash.digest('hex') !== claims.sha256) refuse(409, 'conflict', 'The file has different bytes.');
      }
      await live();
      if (revoked) refuse(401, 'device_revoked', 'This device is no longer paired.');
      const metadata = fileMetadata(await fs.readFile(target), row.name);
      const result = await deps
        .db()
        .run(
          'UPDATE app_files SET storage_path=?,uploaded_at=COALESCE(uploaded_at,?),kind=?,width=?,height=? WHERE id=?',
          target,
          Date.now(),
          metadata.kind,
          metadata.width,
          metadata.height,
          row.id,
        );
      if (!result.changes) refuse(404, 'not_found', 'File no longer exists.');
      published = false;
      ctx.res.writeHead(204);
      ctx.res.end();
    } finally {
      unsubscribe();
      await handle.close();
      await fs.rm(temporary, { force: true });
      if (published) await fs.rm(target, { force: true });
    }
  });
  const downloadFile = wrap(async (ctx) => {
    await signedBody(ctx);
    const row = await own(ctx);
    const conversation = row.conversation_id ? await deps.getConversation(row.conversation_id) : undefined;
    if (
      !conversation ||
      conversation.user_id !== ctx.identity!.userId ||
      !ctx.identity!.agentIds.includes(conversation.agent_group_id) ||
      !row.storage_path ||
      row.uploaded_at === null
    )
      refuse(404, 'not_found', 'File not found.');
    ctx.res.writeHead(200, {
      'Content-Type': row.mime_type,
      'Content-Length': row.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      'Cache-Control': 'private, no-store',
    });
    await pipeline(createReadStream(row.storage_path), ctx.res);
  });
  async function claimFiles(
    db: DbDriver,
    claim: Claim,
  ): Promise<{ ok: true; files: FileAttachment[] } | { ok: false; fileId: string }> {
    const rows: StoredFile[] = [];
    for (const id of claim.fileIds) {
      const row = await get(id, db);
      if (
        !row ||
        row.user_id !== claim.userId ||
        row.uploaded_at === null ||
        !row.storage_path ||
        (row.message_id !== null &&
          (row.message_id !== claim.messageId || row.conversation_id !== claim.conversationId))
      )
        return { ok: false, fileId: id };
      rows.push(row);
    }
    for (const row of rows)
      await db.run(
        'UPDATE app_files SET message_id=?,conversation_id=? WHERE id=?',
        claim.messageId,
        claim.conversationId,
        row.id,
      );
    return { ok: true, files: rows.map(reference) };
  }
  async function stageFiles(messageId: string) {
    const rows = await deps.db().all<StoredFile>('SELECT * FROM app_files WHERE message_id = ?', messageId);
    const result = [];
    for (const row of rows) {
      const directory = path.join(deps.stagingRoot ?? inboundStagingRoot(), 'app', randomUUID());
      await fs.mkdir(directory, { recursive: true });
      const stagedPath = path.join(directory, cleanName(row.name));
      await fs.copyFile(row.storage_path!, stagedPath);
      result.push({ name: row.name, mimeType: row.mime_type, size: row.size, stagedPath });
    }
    return result;
  }
  async function storeOutboundFiles(input: Outbound): Promise<FileAttachment[]> {
    await fs.mkdir(root, { recursive: true });
    const result: FileAttachment[] = [];
    for (const file of input.files) {
      const id = `file_${randomUUID()}`,
        name = cleanName(file.filename),
        target = path.join(root, id);
      const metadata = fileMetadata(file.data, name);
      await fs.writeFile(target, file.data, { flag: 'wx', mode: 0o600 });
      try {
        await deps
          .db()
          .run(
            'INSERT INTO app_files (id,user_id,name,mime_type,size,sha256,kind,width,height,storage_path,uploaded_at,message_id,conversation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            id,
            input.userId,
            name,
            metadata.mimeType,
            file.data.length,
            createHash('sha256').update(file.data).digest('hex'),
            metadata.kind,
            metadata.width,
            metadata.height,
            target,
            Date.now(),
            input.messageId,
            input.conversationId,
            Date.now(),
          );
      } catch (error) {
        await fs.rm(target, { force: true });
        throw error;
      }
      result.push({ id, name, size: file.data.length, ...metadata });
    }
    return result;
  }
  async function cleanup(now = Date.now()) {
    // Claiming and pruning share the DB transaction so a just-sent file cannot be deleted.
    await deps.db().transaction(async () => {
      const rows = await deps
        .db()
        .all<StoredFile>('SELECT * FROM app_files WHERE message_id IS NULL AND created_at < ?', now - DAY);
      for (const row of rows) {
        await fs.rm(path.join(root, row.id), { force: true });
        await deps.db().run('DELETE FROM app_file_tickets WHERE file_id=?', row.id);
        await deps.db().run('DELETE FROM app_files WHERE id=?', row.id);
      }
      await deps.db().run('DELETE FROM app_file_tickets WHERE expires_at <= ?', now);
    });
  }
  async function startCleanup(onError: (error: unknown) => void) {
    await cleanup();
    const timer = setInterval(() => {
      void cleanup().catch(onError);
    }, 3_600_000);
    timer.unref();
    return () => clearInterval(timer);
  }
  return {
    mintFile,
    renewFileTicket,
    uploadFile,
    downloadFile,
    claimFiles,
    stageFiles,
    storeOutboundFiles,
    cleanup,
    startCleanup,
  };
}

let service: ReturnType<typeof createFileService> | undefined;
export function configureFiles(deps: FileDeps) {
  service = createFileService(deps);
  return service;
}
const handler =
  (name: 'mintFile' | 'renewFileTicket' | 'uploadFile' | 'downloadFile'): AppHandler =>
  async (ctx) => {
    if (!service) {
      json(ctx.res, 503, { error: 'unavailable', message: 'Files are unavailable.' });
      return;
    }
    await service[name](ctx);
  };
export const mintFile = handler('mintFile');
export const renewFileTicket = handler('renewFileTicket');
export const uploadFile = handler('uploadFile');
export const downloadFile = handler('downloadFile');
