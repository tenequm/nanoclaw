import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { StandInProvider } from './stand-in.js';
import { createProvider } from './factory.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import type { AgentQuery, ProviderEvent } from './types.js';

let directory: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.NANOCLAW_LOCAL_STAND_IN;
  process.env.NANOCLAW_LOCAL_STAND_IN = '1';
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stand-in-test-'));
  initTestSessionDb();
  getOutboundDb()
    .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(
      'current_reply_route',
      JSON.stringify({ inReplyTo: 'input', channelType: 'test', platformId: 'stan', threadId: 'thread' }),
      new Date().toISOString(),
    );
  getInboundDb().exec(`INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
    VALUES ('local', 'Local', 'channel', 'test', 'stan');
    CREATE TABLE IF NOT EXISTS session_routing (id INTEGER PRIMARY KEY, channel_type TEXT, platform_id TEXT, thread_id TEXT);
    INSERT INTO session_routing VALUES (1, 'test', 'stan', 'thread');`);
});
afterEach(() => {
  closeSessionDb();
  fs.rmSync(directory, { recursive: true, force: true });
  if (previous === undefined) delete process.env.NANOCLAW_LOCAL_STAND_IN;
  else process.env.NANOCLAW_LOCAL_STAND_IN = previous;
});

function query(text: string): AgentQuery {
  return createProvider('stand-in').query({ prompt: text, cwd: directory });
}
async function consume(q: AgentQuery): Promise<ProviderEvent[]> {
  q.end();
  const events: ProviderEvent[] = [];
  for await (const event of q.events) events.push(event);
  return events;
}
function contents() {
  return getUndeliveredMessages().map((row) => JSON.parse(row.content));
}

it('requires the runtime opt-in', () => {
  delete process.env.NANOCLAW_LOCAL_STAND_IN;
  expect(() => new StandInProvider()).toThrow('NANOCLAW_LOCAL_STAND_IN');
});
it('replies through send_message with the bound route', async () => {
  await consume(query('reply hello'));
  expect(contents()).toEqual([{ text: 'Stand-in reply.' }]);
  expect(getUndeliveredMessages()[0]).toMatchObject({ channel_type: 'test', platform_id: 'stan', thread_id: 'thread' });
});
it('sends the markdown fixture', async () => {
  await consume(query('markdown'));
  expect(contents()[0].text).toBe(
    '# Stand-in\n\n- First\n- Second\n\n| Key | Value |\n| --- | --- |\n| State | Ready |\n\n```text\nhello\n```',
  );
});
it('waits for a real question answer and names it', async () => {
  const running = consume(query('question'));
  for (let i = 0; i < 100 && !contents().length; i++) await Bun.sleep(5);
  const card = contents()[0];
  expect(card.type).toBe('ask_question');
  expect(card.options.map((option: { label: string }) => option.label)).toEqual(['Alpha', 'Beta', 'Gamma']);
  expect(contents()).toHaveLength(1);
  getInboundDb()
    .prepare('INSERT INTO messages_in (id, kind, timestamp, content) VALUES (?, ?, ?, ?)')
    .run(
      'answer',
      'chat',
      new Date().toISOString(),
      JSON.stringify({ questionId: card.questionId, selectedOption: 'Beta' }),
    );
  await running;
  expect(contents()[1]).toEqual({ text: 'Selected: Beta' });
});
it('sends a deterministic text file and PNG through the file tool', async () => {
  const files: Record<string, Buffer> = {};
  const mkdir = spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  const copy = spyOn(fs, 'copyFileSync').mockImplementation((source, target) => {
    files[path.basename(String(target))] = fs.readFileSync(source);
  });
  try {
    await consume(query('file'));
    expect(contents().map((content) => content.files)).toEqual([['stand-in.txt'], ['stand-in.png']]);
    expect(files['stand-in.txt'].toString()).toBe('Stand-in file.\n');
    expect(files['stand-in.png'].subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const png = files['stand-in.png'];
    expect(inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))).toEqual(Buffer.from([0, 0, 0, 0, 255]));
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    mkdir.mockRestore();
    copy.mockRestore();
  }
});
it('edits the message it just sent', async () => {
  await consume(query('edit'));
  expect(contents()[0]).toEqual({ text: 'Before edit.' });
  expect(contents()[1]).toEqual({ operation: 'edit', messageId: getUndeliveredMessages()[0].id, text: 'After edit.' });
});
it('keeps a long tool visible for about twenty seconds', async () => {
  const started = Date.now();
  const q = query('long');
  q.end();
  let checked = false;
  for await (const event of q.events) {
    if (event.type === 'activity' && Date.now() - started >= 900) {
      expect(JSON.stringify(getOutboundDb().prepare('SELECT * FROM container_state').all())).toContain('stand_in_wait');
      checked = true;
    }
  }
  expect(checked).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(20_000);
  expect(contents()).toEqual([{ text: 'Long tool complete.' }]);
  expect(JSON.stringify(getOutboundDb().prepare('SELECT * FROM container_state').all())).not.toContain('stand_in_wait');
}, 30_000);
it('sends three messages in one turn', async () => {
  const events = await consume(query('multi'));
  expect(contents()).toEqual(['First message.', 'Second message.', 'Third message.'].map((text) => ({ text })));
  expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
});
it('decodes formatted input, ignores quoted commands and echoes exact text', async () => {
  await consume(
    query(
      '<message id="2" from="local"><quoted_message from="Stan">reply</quoted_message>hi &lt;x&gt; &amp; &quot;y&quot;</message>',
    ),
  );
  expect(contents()).toEqual([{ text: 'hi <x> & "y"' }]);
});
it('starts idle and drains pushed turns on end', async () => {
  const q = query('');
  q.push('echo one');
  q.push('echo one');
  await consume(q);
  expect(contents()).toEqual([{ text: 'echo one' }, { text: 'echo one' }]);
});
it('aborts an in-progress question without a reply', async () => {
  const q = query('question');
  const running = consume(q);
  for (let i = 0; i < 100 && !contents().length; i++) await Bun.sleep(5);
  q.abort();
  await running;
  expect(contents()).toHaveLength(1);
});
