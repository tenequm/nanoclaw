// Keep synchronous SQLite reads and transcript parsing off the host event loop.
import { MessageChannel, type MessagePort, parentPort, Worker, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { access, open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export interface TranscriptStats {
  contextTokens: number | null;
  outputTokens: number;
  turns: number;
}

interface Snapshot {
  ino: number;
  size: number;
  mtimeMs: number;
  completeLine: boolean;
  stats: TranscriptStats | null;
  outputs?: Map<string, number>;
}

const snapshots = new Map<string, Snapshot>();
const reading = new Map<string, Promise<TranscriptStats | null>>();
const BLOCK_SIZE = 64 * 1024;
const MAX_INCREMENTAL_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

async function* newestLines(file: FileHandle, start: number, end: number) {
  let fragments: Buffer[] = [];
  while (end > start) {
    const size = Math.min(end - start, BLOCK_SIZE);
    end -= size;
    const buf = Buffer.allocUnsafe(size);
    if ((await file.read(buf, 0, size, end)).bytesRead !== size) throw new Error('Transcript changed during read');
    let right = size;
    for (let i = size - 1; i >= 0; i--) {
      if (buf[i] !== 10) continue;
      fragments.push(buf.subarray(i + 1, right));
      yield Buffer.concat(fragments.reverse()).toString('utf8');
      fragments = [];
      right = i;
    }
    fragments.push(buf.subarray(0, right));
  }
  if (fragments.length) yield Buffer.concat(fragments.reverse()).toString('utf8');
}

async function parseTranscript(filePath: string): Promise<TranscriptStats | null> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) return null;
    const { ino, size, mtimeMs } = info;
    const cached = snapshots.get(filePath);
    if (cached?.ino === ino && cached.size === size && cached.mtimeMs === mtimeMs) return cached.stats;
    // SDK transcripts append complete JSONL records. A replaced, truncated or
    // unterminated snapshot must be counted again from the beginning.
    const base =
      cached?.outputs && cached.ino === ino && cached.completeLine && cached.size < size ? cached : undefined;
    const outputs = base?.outputs ?? new Map<string, number>();
    const latest = new Map<string, number>();
    let turns = base?.stats?.turns ?? 0;
    let outputTokens = base?.stats?.outputTokens ?? 0;
    let context: number | null | undefined;
    let completeLine = false;
    let first = true;
    for await (const line of newestLines(file, base?.size ?? 0, size)) {
      if (first) {
        completeLine = line.length === 0;
        first = false;
      }
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type === 'system' && obj.subtype === 'compact_boundary') {
        if (context === undefined) {
          const post = obj.compactMetadata?.postTokens;
          context = Number.isSafeInteger(post) && post >= 0 ? post : null;
        }
        continue;
      }
      const usage = obj?.message?.usage;
      if (obj?.type !== 'assistant' || !usage) continue;
      if (context === undefined)
        context =
          (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      const id = obj.message.id;
      const output = usage.output_tokens ?? 0;
      if (id) {
        if (latest.has(id)) continue;
        latest.set(id, output);
        if (outputs.has(id)) {
          outputTokens += output - outputs.get(id)!;
          continue;
        }
      }
      turns++;
      outputTokens += output;
    }
    // Large transcripts retain only their totals. Recount on append so older duplicate IDs stay accurate.
    const keepOutputs = size <= MAX_INCREMENTAL_TRANSCRIPT_BYTES;
    if (keepOutputs) for (const [id, output] of latest) outputs.set(id, output);
    const contextTokens = context === undefined ? (base?.stats?.contextTokens ?? null) : context;
    const stats = turns || contextTokens !== null ? { turns, outputTokens, contextTokens } : null;
    snapshots.delete(filePath);
    if (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value!);
    snapshots.set(filePath, { ino, size, mtimeMs, completeLine, stats, outputs: keepOutputs ? outputs : undefined });
    return stats;
  } finally {
    await file.close();
  }
}

async function newestTranscript(root: string): Promise<string | undefined> {
  let newest: { file: string; time: number } | undefined;
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, entry.name);
      const info = await stat(file).catch(() => undefined);
      if (info && (!newest || newest.time < info.mtimeMs)) newest = { file, time: info.mtimeMs };
    }
  }
  return newest?.file;
}

async function readFileStats(file: string) {
  const pending = reading.get(file);
  if (pending) return pending;
  const result = parseTranscript(file).finally(() => reading.delete(file));
  reading.set(file, result);
  return result;
}

async function readSdkTranscriptStats(
  root: string,
  sdkId: string | null,
  scope: 'session' | 'group' = 'group',
): Promise<TranscriptStats | null> {
  try {
    if (sdkId && /^[A-Za-z0-9_-]+$/.test(sdkId)) {
      const file = path.join(root, '-workspace-agent', sdkId + '.jsonl');
      try {
        return await readFileStats(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
      if (scope === 'group') {
        for (const project of await readdir(root, { withFileTypes: true })) {
          if (!project.isDirectory() || project.name === '-workspace-agent') continue;
          try {
            return await readFileStats(path.join(root, project.name, sdkId + '.jsonl'));
          } catch {
            continue;
          }
        }
      }
    }
    if (scope === 'session') return null;
    const newest = await newestTranscript(root);
    return newest ? await readFileStats(newest) : null;
  } catch {
    return null;
  }
}

interface MailboxRead {
  root: string;
  scope: 'session' | 'group';
  inbound: string | null;
  outbound: string | null;
  queueSql: string;
  claude: boolean;
}
export interface MailboxStatus {
  queueDepth: number | null;
  stats: TranscriptStats | null;
}

async function readExisting<T>(path: string, query: string): Promise<T | undefined> {
  try {
    await access(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const db = new Database(path, { readonly: true, timeout: 0 });
  try {
    return db.prepare(query).get() as T | undefined;
  } finally {
    db.close();
  }
}

async function mailboxStatus(input: MailboxRead): Promise<MailboxStatus> {
  const queueDepth = input.inbound
    ? ((await readExisting<{ count: number }>(input.inbound, input.queueSql).catch(() => undefined))?.count ?? null)
    : 0;
  if (!input.claude) return { queueDepth, stats: null };
  try {
    const continuation = input.outbound
      ? await readExisting<{ value: string }>(
          input.outbound,
          `SELECT value FROM session_state WHERE key IN ('continuation:claude', 'sdk_session_id')
       ORDER BY CASE key WHEN 'continuation:claude' THEN 0 ELSE 1 END LIMIT 1`,
        )
      : undefined;
    return { queueDepth, stats: await readSdkTranscriptStats(input.root, continuation?.value ?? null, input.scope) };
  } catch {
    return { queueDepth, stats: null };
  }
}

if (workerData === 'session-status' && parentPort) {
  parentPort.on('message', ({ input, port }: { input: MailboxRead; port: MessagePort }) => {
    void mailboxStatus(input)
      .then(
        (result) => port.postMessage(result),
        () => port.postMessage(null),
      )
      .finally(() => port.close());
  });
}

let reader: Worker | undefined;
export async function readStatusMailbox(input: MailboxRead): Promise<MailboxStatus> {
  if (!reader) {
    const worker = new Worker(new URL(import.meta.url), { workerData: 'session-status' });
    worker.on('error', () => {
      if (reader === worker) reader = undefined;
    });
    worker.once('exit', () => {
      if (reader === worker) reader = undefined;
    });
    worker.unref();
    reader = worker;
  }
  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve, reject) => {
    port1.once('message', (result: MailboxStatus | null) => {
      if (result) resolve(result);
      else reject(new Error('Session queue read failed'));
    });
    port1.once('close', () => reject(new Error('Session mailbox reader closed')));
    reader!.postMessage({ input, port: port2 }, [port2]);
  });
}
