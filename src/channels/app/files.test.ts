import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest, createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import type { DbDriver } from '../../db/driver.js';
import type { DeviceRow } from '../../modules/device-auth/db.js';
import type { AppHandler } from './routes.js';
import './db.js';
import { configureFiles, createFileService, fileMetadata } from './files.js';
import { ensureConversation, history } from './conversations.js';
import { sendMessage, drainRoutingJobs } from './send.js';
import { deliver } from './deliver.js';
import { readTicket } from './contract.js';
import { getHostStartCallbacks, getHostShutdownCallbacks } from '../../host-lifecycle.js';
import fixtures from './app-contract.fixtures.json' with { type: 'json' };

let directory: string, db: DbDriver, service: ReturnType<typeof createFileService>;
let revoked: (id: string) => void;
const secret = Buffer.alloc(32, 1);
const device = { id: 'dev', user_id: 'user' } as DeviceRow;
const content = Buffer.from('attachment');
const sha256 = createHash('sha256').update(content).digest('hex');
const auth = `HeyDan-Sig v=1,p=1,d=dev,t=1,n=${Buffer.alloc(16).toString('base64url')},bh=${sha256},s=MEQCIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'app-files-'));
  db = await initDb(path.join(directory, 'test.db'), { role: 'test' });
  await runMigrations(db);
  revoked = undefined!;
  service = createFileService({
    db: () => db,
    root: path.join(directory, 'files'),
    stagingRoot: path.join(directory, 'staging'),
    ticketKey: () => secret,
    getLiveDevice: async () => device,
    onDeviceRevoked: (listener) => {
      revoked = listener;
      return () => {};
    },
    getConversation: async (id) => ({
      id,
      user_id: 'user',
      agent_group_id: 'agent',
      messaging_group_id: 'mg',
      seq: 1,
      last_message_json: null,
      created_at: 1,
    }),
    readBody: async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    },
  });
});
afterEach(async () => {
  configureFiles();
  await closeDb();
  await rm(directory, { recursive: true, force: true });
});
async function request(
  handler: AppHandler,
  body = Buffer.alloc(0),
  options: {
    id?: string;
    ticket?: string;
    length?: string | null;
    user?: string;
    agents?: string[];
    beforeEnd?: () => void;
  } = {},
) {
  const req = new IncomingMessage(new Socket());
  req.headers.authorization = options.ticket
    ? `HeyDan-Ticket ${options.ticket}`
    : auth.replace(sha256, createHash('sha256').update(body).digest('hex'));
  if (options.length !== null) req.headers['content-length'] = options.length ?? String(body.length);
  const res = new ServerResponse(req);
  let output = '';
  vi.spyOn(res, 'end').mockImplementation(((value?: string) => {
    output = value ?? '';
    return res;
  }) as typeof res.end);
  const promise = handler({
    req,
    res,
    params: { id: options.id ?? '' },
    identity: { deviceId: 'dev', userId: options.user ?? 'user', agentIds: options.agents ?? ['agent'] },
  });
  req.push(body);
  if (options.beforeEnd) {
    // The upload subscribes after its asynchronous ticket and storage checks.
    await vi.waitFor(() => expect(revoked).toBeTypeOf('function'));
    options.beforeEnd();
  }
  req.push(null);
  await promise;
  return { status: res.statusCode, body: output ? JSON.parse(output) : null };
}
async function mint(extra = {}) {
  return request(
    service.mintFile,
    Buffer.from(
      JSON.stringify({
        uploadKey: randomUUID(),
        name: 'test.txt',
        mimeType: 'text/plain',
        size: content.length,
        sha256,
        ...extra,
      }),
    ),
  );
}
it('fileInitResponse and fileTicketRenewResponse: lost mint and upload answers are retryable', async () => {
  const uploadKey = randomUUID();
  const first = await mint({ uploadKey });
  expect(first.status).toBe(200);
  expect(first.body.uploaded).toBe(false);
  expect(Object.keys(first.body).sort()).toEqual(Object.keys(fixtures.fileInitResponse).sort());
  expect((await mint({ uploadKey })).body.fileId).toBe(first.body.fileId);
  for (let i = 0; i < 2; i++)
    expect(
      (await request(service.uploadFile, content, { id: first.body.fileId, ticket: first.body.ticket })).status,
    ).toBe(204);
  expect((await mint({ uploadKey })).body.uploaded).toBe(true);
  const renewed = await request(service.renewFileTicket, Buffer.alloc(0), { id: first.body.fileId });
  expect(renewed.status).toBe(200);
  expect(readTicket(renewed.body.ticket, secret)?.fileId).toBe(first.body.fileId);
  expect(await mint({ uploadKey, name: 'other.txt' })).toEqual(fixtures.errors.uploadKeyConflict);
});
it('tooLarge, lengthRequired, badBody, forged tickets and uploadConflict', async () => {
  expect(await mint({ size: 26_214_401 })).toEqual(fixtures.errors.tooLarge);
  const { body } = await mint();
  const options = { id: body.fileId, ticket: body.ticket };
  const other = await mint();
  expect(await request(service.uploadFile, content, { ...options, id: other.body.fileId })).toMatchObject({
    status: 401,
    body: { error: 'bad_signature' },
  });
  expect(await request(service.uploadFile, content, { ...options, length: null })).toEqual(
    fixtures.errors.lengthRequired,
  );
  expect((await request(service.uploadFile, content, { ...options, length: '1' })).body.error).toBe('bad_request');
  expect(await request(service.uploadFile, Buffer.alloc(content.length), options)).toEqual(fixtures.errors.badBody);
  expect(
    (
      await request(service.uploadFile, Buffer.concat([content, content]), {
        ...options,
        length: String(content.length),
      })
    ).body.error,
  ).toBe('bad_body');
  expect((await request(service.uploadFile, content, { ...options, ticket: 'forged' })).body.error).toBe(
    'bad_signature',
  );
  await request(service.uploadFile, content, options);
  await writeFile(path.join(directory, 'files', body.fileId), 'different');
  expect(await request(service.uploadFile, content, options)).toEqual(fixtures.errors.uploadConflict);
  expect(await readdir(path.join(directory, 'files', 'tmp'))).toEqual([]);
});
it('ticketExpired and device revoked during upload never publish', async () => {
  const { body } = await mint();
  const now = vi.spyOn(Date, 'now').mockReturnValue(body.expiresAt);
  expect((await request(service.uploadFile, content, { id: body.fileId, ticket: body.ticket })).body.error).toBe(
    'ticket_expired',
  );
  now.mockRestore();
  const result = await request(service.uploadFile, content, {
    id: body.fileId,
    ticket: body.ticket,
    beforeEnd: () => {
      revoked('dev');
    },
  });
  expect(result).toMatchObject({ status: 401, body: { error: 'device_revoked' } });
  expect(await readdir(path.join(directory, 'files'))).toEqual(['tmp']);
  expect(await readdir(path.join(directory, 'files', 'tmp'))).toEqual([]);
});
it('userWithFile: rejects badFile, claims atomically and stages independent copies', async () => {
  const { body } = await mint();
  const claim = { userId: 'user', conversationId: 'conv', messageId: 'msg', fileIds: [body.fileId] };
  expect(await db.transaction(() => service.claimFiles(db, claim))).toEqual({ ok: false, fileId: body.fileId });
  await request(service.uploadFile, content, { id: body.fileId, ticket: body.ticket });
  expect((await service.claimFiles(db, { ...claim, userId: 'other' })).ok).toBe(false);
  expect((await db.transaction(() => service.claimFiles(db, { ...claim, fileIds: [body.fileId, 'absent'] }))).ok).toBe(
    false,
  );
  expect(
    (await db.get<{ message_id: string | null }>('SELECT message_id FROM app_files WHERE id=?', body.fileId))
      ?.message_id,
  ).toBeNull();
  expect(await db.transaction(() => service.claimFiles(db, claim))).toEqual({
    ok: true,
    files: [
      {
        id: body.fileId,
        name: 'test.txt',
        mimeType: 'text/plain',
        size: content.length,
        kind: 'file',
        width: null,
        height: null,
      },
    ],
  });
  expect((await db.transaction(() => service.claimFiles(db, claim))).ok).toBe(true);
  expect((await service.claimFiles(db, { ...claim, messageId: 'different' })).ok).toBe(false);
  const staged = await service.stageFiles('msg');
  expect(await readFile(staged[0].stagedPath)).toEqual(content);
  await writeFile(staged[0].stagedPath, 'changed');
  expect(await readFile(path.join(directory, 'files', body.fileId))).toEqual(content);
  expect((await request(service.downloadFile, Buffer.alloc(0), { id: body.fileId, agents: ['other'] })).status).toBe(
    404,
  );
  expect((await request(service.downloadFile, Buffer.alloc(0), { id: body.fileId, user: 'other' })).status).toBe(404);
});
it('agentWithFiles: detects PNG and PDF bytes and retains sent files during cleanup', async () => {
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.write('IHDR', 12);
  png.writeUInt32BE(17, 16);
  png.writeUInt32BE(23, 20);
  const files = await service.storeOutboundFiles({
    userId: 'user',
    conversationId: 'conv',
    messageId: 'msg',
    files: [
      { filename: 'picture.bin', data: png },
      { filename: 'paper.bin', data: Buffer.from('%PDF-1.7') },
    ],
  });
  expect(files[0]).toMatchObject({ mimeType: 'image/png', kind: 'image', width: 17, height: 23 });
  expect(files[1]).toMatchObject({ mimeType: 'application/pdf', kind: 'file', width: null, height: null });
  await db.run(
    "INSERT INTO app_messages (id,conversation_id,user_id,item_order,seq,role,text,files_json,reactions_json,created_at) VALUES ('msg','conv','user',1,1,'agent','','[]','[]',1)",
  );
  await mint();
  await service.cleanup(Date.now() + 86_400_001);
  expect(await db.all('SELECT id FROM app_files')).toHaveLength(2);
});
it('parses GIF, JPEG and WebP dimensions and tolerates truncated headers', () => {
  const gif = Buffer.from('47494638396102000300', 'hex');
  expect(fileMetadata(gif, 'x')).toMatchObject({ width: 2, height: 3, mimeType: 'image/gif' });
  const jpeg = Buffer.from('ffd8ffc00008080003000200', 'hex');
  expect(fileMetadata(jpeg, 'x')).toMatchObject({ width: 2, height: 3, mimeType: 'image/jpeg' });
  const webp = Buffer.alloc(30);
  webp.write('RIFF');
  webp.write('WEBP', 8);
  webp.write('VP8X', 12);
  webp.writeUIntLE(1, 24, 3);
  webp.writeUIntLE(2, 27, 3);
  expect(fileMetadata(webp, 'x')).toMatchObject({ width: 2, height: 3, mimeType: 'image/webp' });
  for (let i = 0; i < 30; i++) expect(() => fileMetadata(webp.subarray(0, i), 'x')).not.toThrow();
});

it('another device of the same user downloads with safe response headers', async () => {
  const [file] = await service.storeOutboundFiles({
    userId: 'user',
    conversationId: 'conv',
    messageId: 'msg',
    files: [{ filename: "a'b.txt", data: content }],
  });
  await db.run('UPDATE app_files SET mime_type=? WHERE id=?', 'text/html', file.id);
  const server = createServer((req, res) => {
    void service
      .downloadFile({
        req,
        res,
        params: { id: file.id },
        identity: { userId: 'user', deviceId: 'second', agentIds: ['agent'] },
      })
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = (server.address() as import('node:net').AddressInfo).port;
    const response = await fetch('http://127.0.0.1:' + port + '/app/files/' + file.id, {
      headers: { Authorization: auth },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
    expect(response.headers.get('content-length')).toBe(String(content.length));
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''a%27b.txt");
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
it('uploads delayed segments over HTTP beyond 64 KiB without blocking timers', async () => {
  const bytes = Buffer.alloc(200_000, 7);
  const { body } = await mint({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const server = createServer((req, res) => {
    void service.uploadFile({ req, res, params: { id: body.fileId } }).catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as import('node:net').AddressInfo;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          method: 'PUT',
          headers: { authorization: 'HeyDan-Ticket ' + body.ticket, 'content-length': bytes.length },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.write(bytes.subarray(0, 1000));
      setTimeout(() => {
        req.write(bytes.subarray(1000, 100_000));
        setTimeout(() => req.end(bytes.subarray(100_000)), 20);
      }, 20);
    });
    expect(status).toBe(204);
    expect(await readFile(path.join(directory, 'files', body.fileId))).toEqual(bytes);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('renewal hides outbound files and files outside the device agent set', async () => {
  const { body } = await mint();
  await db.run('UPDATE app_files SET conversation_id=? WHERE id=?', 'conv', body.fileId);
  expect(await request(service.renewFileTicket, Buffer.alloc(0), { id: body.fileId, agents: ['other'] })).toMatchObject(
    { status: 404, body: { error: 'not_found' } },
  );
  expect((await request(service.renewFileTicket, Buffer.alloc(0), { id: body.fileId })).status).toBe(200);
  const [file] = await service.storeOutboundFiles({
    userId: 'user',
    conversationId: 'conv',
    messageId: 'missing',
    files: [{ filename: 'ok.txt', data: content }],
  });
  expect((await request(service.renewFileTicket, Buffer.alloc(0), { id: file.id })).status).toBe(404);
});

it('boot sweeps interrupted uploads and cleanup removes orphan outbound files with safe substitute names', async () => {
  const files = await service.storeOutboundFiles({
    userId: 'user',
    conversationId: 'conv',
    messageId: 'missing',
    files: [
      { filename: 'ok.txt', data: content },
      { filename: 'x'.repeat(300), data: content },
      { filename: '..', data: content },
    ],
  });
  expect(files.map((file) => file.name)).toEqual(['ok.txt', 'attachment', 'attachment']);
  await import('node:fs/promises').then((fs) => fs.mkdir(path.join(directory, 'files', 'tmp')));
  await writeFile(path.join(directory, 'files', 'tmp', 'interrupted'), content);
  const stop = await service.startCleanup(() => {});
  stop();
  await expect(readdir(path.join(directory, 'files', 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  await service.cleanup(Date.now() + 86_400_001);
  expect(await db.all('SELECT id FROM app_files')).toEqual([]);
  expect(await readdir(path.join(directory, 'files'))).toEqual([]);
});

it('expired fixture authorization reaches the upload handler', async () => {
  const fixtureService = createFileService({
    db: () => db,
    getLiveDevice: async () => device,
    onDeviceRevoked: () => () => {},
    getConversation: async () => undefined,
    ticketKey: () => Buffer.from(fixtures.fileUpload.ticketSecretForTests),
  });
  expect(
    await request(fixtureService.uploadFile, content, {
      id: fixtures.fileUpload.ticketClaims.fileId,
      ticket: fixtures.fileUpload.expiredAuthorization.slice(14),
    }),
  ).toEqual(fixtures.errors.ticketExpired);
});

it('production wiring registers hooks and catches boot cleanup failures', async () => {
  const wired = configureFiles();
  const failed = vi.spyOn(wired, 'startCleanup').mockRejectedValue(new Error('test failure'));
  const start = getHostStartCallbacks().at(-1)!;
  await expect(
    start({ db, signal: new AbortController().signal, deliveryAdapter: {} as never }),
  ).resolves.toBeUndefined();
  failed.mockRestore();
  const stop = vi.fn();
  vi.spyOn(wired, 'startCleanup').mockResolvedValue(stop);
  await start({ db, signal: new AbortController().signal, deliveryAdapter: {} as never });
  await getHostShutdownCallbacks().at(-1)!();
  expect(stop).toHaveBeenCalledOnce();
});

it.each(['abort', 'revoke'] as const)('HTTP %s mid-body removes temporary bytes without publishing', async (action) => {
  const { body } = await mint({ size: 200_000 });
  let complete!: () => void;
  const handled = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const server = createServer((req, res) => {
    void service
      .uploadFile({ req, res, params: { id: body.fileId } })
      .catch(() => res.destroy())
      .finally(complete);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const req = httpRequest(
    {
      hostname: '127.0.0.1',
      port,
      method: 'PUT',
      headers: { authorization: 'HeyDan-Ticket ' + body.ticket, 'content-length': 200_000 },
    },
    (res) => res.resume(),
  );
  req.on('error', () => {});
  try {
    req.write(Buffer.alloc(1000));
    await vi.waitFor(() => expect(revoked).toBeTypeOf('function'));
    if (action === 'abort') req.destroy();
    else revoked('dev');
    await handled;
    expect(await readdir(path.join(directory, 'files'))).toEqual(['tmp']);
    expect(await readdir(path.join(directory, 'files', 'tmp'))).toEqual([]);
  } finally {
    req.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('real module hooks claim a sent file, stage it and deliver an agent file into history', async () => {
  configureFiles({ root: path.join(directory, 'files'), stagingRoot: path.join(directory, 'staging') });
  await db.run("INSERT INTO agent_groups (id,name,folder,created_at) VALUES ('agent','Taylor','taylor','2026-11-17')");
  const conversation = await ensureConversation('user', 'agent');
  const { body: upload } = await mint();
  expect((await request(service.uploadFile, content, { id: upload.fileId, ticket: upload.ticket })).status).toBe(204);
  const body = Buffer.from(JSON.stringify({ clientId: randomUUID(), text: '', fileIds: [upload.fileId] }));
  const sent = await request(sendMessage, body, { id: conversation.id });
  expect(sent.status).toBe(200);
  expect(sent.body.message.files).toMatchObject([{ id: upload.fileId }]);
  expect(await db.get('SELECT message_id,conversation_id FROM app_files WHERE id=?', upload.fileId)).toEqual({
    message_id: sent.body.message.id,
    conversation_id: conversation.id,
  });
  expect(await request(sendMessage, body, { id: conversation.id })).toEqual(sent);
  const route = vi.fn(async (input) => {
    const { attachments } = JSON.parse(input.message.content);
    expect(attachments).toHaveLength(1);
    expect(await readFile(attachments[0].stagedPath)).toEqual(content);
    input.onStored();
  });
  await drainRoutingJobs(route);
  expect(route).toHaveBeenCalledOnce();
  expect(await db.get('SELECT delivery FROM app_messages WHERE id=?', sent.body.message.id)).toEqual({
    delivery: 'reached',
  });
  const id = await deliver(conversation.id, null, {
    kind: 'chat-sdk',
    sourceId: randomUUID(),
    content: { text: '' },
    files: [{ filename: 'reply.pdf', data: Buffer.from('%PDF-1.7') }],
  });
  const result = await request(history, Buffer.alloc(0), { id: conversation.id });
  expect(result.status).toBe(200);
  expect(result.body.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id,
        role: 'agent',
        files: [expect.objectContaining({ mimeType: 'application/pdf', kind: 'file' })],
      }),
    ]),
  );
  const row = await db.get<{ storage_path: string }>('SELECT storage_path FROM app_files WHERE message_id=?', id);
  expect(await readFile(row!.storage_path)).toEqual(Buffer.from('%PDF-1.7'));
});

it('refuses an upload whose device was revoked before it started', async () => {
  const { body } = await mint();
  const revokedService = createFileService({
    db: () => db,
    root: path.join(directory, 'files'),
    stagingRoot: path.join(directory, 'staging'),
    ticketKey: () => secret,
    getLiveDevice: async () => undefined,
    onDeviceRevoked: () => () => {},
    getConversation: async () => undefined,
  });
  expect(await request(revokedService.uploadFile, content, { id: body.fileId, ticket: body.ticket })).toEqual({
    status: 401,
    body: { error: 'device_revoked', message: 'This device is no longer paired.' },
  });
  expect(await db.get('SELECT uploaded_at, storage_path FROM app_files WHERE id=?', body.fileId)).toEqual({
    uploaded_at: null,
    storage_path: null,
  });
});
