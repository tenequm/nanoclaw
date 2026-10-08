/**
 * Reply threading on the outbound path: `reply_parameters` rides only the
 * first send, only when the host marked the message `threadReply`, and a
 * quote Telegram rejects is retried once without it.
 */
import { Effect, Layer } from 'effect';
import { GrammyError } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';

import type { OutboundMessage } from '../adapter.js';
import { _clearSentKindsForTest, dispatchOutbound } from './outbound.js';
import { BotService, type HydratedBot } from './services.js';
import { TELEGRAM_TEXT_LIMIT } from './formatter.js';

type Call = { method: string; args: unknown[]; other: Record<string, unknown> };

/** Where each Bot API method takes its options object. */
const OTHER_ARG: Record<string, number> = { editMessageText: 3, editMessageCaption: 2 };
const METHODS = [
  'sendMessage',
  'sendDocument',
  'sendPhoto',
  'sendVideo',
  'sendAnimation',
  'sendMediaGroup',
  'sendRichMessage',
  'editMessageText',
  'editMessageCaption',
];

function fakeBot(fail?: (call: Call) => unknown) {
  const calls: Call[] = [];
  let nextId = 100;
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      const call = { method, args, other: (args[OTHER_ARG[method] ?? 2] ?? {}) as Record<string, unknown> };
      calls.push(call);
      const err = fail?.(call);
      if (err) return Promise.reject(err);
      if (method === 'sendMediaGroup')
        return Promise.resolve((args[1] as unknown[]).map(() => ({ message_id: nextId++ })));
      return Promise.resolve({ message_id: nextId++ });
    };
  const layer = Layer.succeed(BotService, {
    bot: { api: Object.fromEntries(METHODS.map((m) => [m, record(m)])) } as unknown as HydratedBot,
    me: { id: 1, is_bot: true, first_name: 'Dan', username: 'dan_bot' } as UserFromGetMe,
    start: () => Effect.void,
    stop: () => Effect.void,
  });
  return {
    calls,
    run: (msg: OutboundMessage) =>
      Effect.runPromise(dispatchOutbound('telegram:42', null, msg).pipe(Effect.provide(layer))),
  };
}

// Every fakeBot numbers from 100, so a kind remembered by one test must not leak into the next.
beforeEach(() => _clearSentKindsForTest());

const file = (filename: string) => ({ filename, data: Buffer.from('x') });

const badRequest = (what: string, method = 'sendMessage', code = 400) =>
  new GrammyError(
    `Call to '${method}' failed!`,
    { ok: false, error_code: code, description: `Bad Request: ${what}` },
    method,
    {},
  );

describe('telegram outbound reply threading', () => {
  it('sets reply_parameters on the first chunk only', async () => {
    const bot = fakeBot();
    const long = `${'a'.repeat(TELEGRAM_TEXT_LIMIT - 10)}\n\n${'b'.repeat(200)}`;
    await bot.run({ kind: 'chat', content: { text: long, threadReply: {} }, inReplyTo: '42:7' });
    expect(bot.calls.length).toBeGreaterThan(1);
    expect(bot.calls[0].other.reply_parameters).toEqual({ message_id: 7, allow_sending_without_reply: true });
    expect(bot.calls.slice(1).every((c) => c.other.reply_parameters === undefined)).toBe(true);
  });

  it('sends plain when the host did not mark the message threadReply', async () => {
    const bot = fakeBot();
    await bot.run({ kind: 'chat', content: { text: 'hi' }, inReplyTo: '42:7' });
    expect(bot.calls[0].other.reply_parameters).toBeUndefined();
  });

  it('never threads to a message from another chat', async () => {
    const bot = fakeBot();
    await bot.run({ kind: 'chat', content: { text: 'hi', threadReply: {} }, inReplyTo: '99:7' });
    expect(bot.calls[0].other.reply_parameters).toBeUndefined();
  });

  it('threads the caption send and only the first of several files', async () => {
    const single = fakeBot();
    await single.run({
      kind: 'chat',
      content: { text: 'pic', threadReply: {} },
      files: [file('a.jpg')],
      inReplyTo: '7',
    });
    expect(single.calls[0]).toMatchObject({ method: 'sendPhoto', other: { reply_parameters: { message_id: 7 } } });

    const many = fakeBot();
    await many.run({
      kind: 'chat',
      content: { text: 'docs', threadReply: {} },
      files: [file('a.pdf'), file('b.pdf')],
      inReplyTo: '7',
    });
    expect(
      many.calls.map((c) => (c.other.reply_parameters as { message_id?: number } | undefined)?.message_id),
    ).toEqual([7, undefined]);
  });

  it('passes the quote and retries once without it when Telegram rejects it', async () => {
    const bot = fakeBot((call) =>
      (call.other.reply_parameters as { quote?: string } | undefined)?.quote
        ? new GrammyError(
            "Call to 'sendMessage' failed!",
            { ok: false, error_code: 400, description: 'Bad Request: QUOTE_TEXT_INVALID' },
            'sendMessage',
            {},
          )
        : undefined,
    );
    const id = await bot.run({
      kind: 'chat',
      content: { text: 'yes', threadReply: { quote: 'at noon' } },
      inReplyTo: '42:7',
    });
    expect(bot.calls.map((c) => c.other.reply_parameters)).toEqual([
      { message_id: 7, allow_sending_without_reply: true, quote: 'at noon' },
      { message_id: 7, allow_sending_without_reply: true },
    ]);
    expect(id).toBe('100');
  });

  it('retries only the first chunk without the quote, sending every chunk once', async () => {
    const bot = fakeBot((call) =>
      (call.other.reply_parameters as { quote?: string } | undefined)?.quote
        ? badRequest('QUOTE_TEXT_INVALID')
        : undefined,
    );
    const long = `${'a'.repeat(TELEGRAM_TEXT_LIMIT - 10)}\n\n${'b'.repeat(200)}`;
    await bot.run({ kind: 'chat', content: { text: long, threadReply: { quote: 'aaa' } }, inReplyTo: '42:7' });
    expect(bot.calls.map((c) => c.other.reply_parameters)).toEqual([
      { message_id: 7, allow_sending_without_reply: true, quote: 'aaa' },
      { message_id: 7, allow_sending_without_reply: true },
      undefined,
    ]);
  });

  it('does not retry an error that is not about the quote', async () => {
    const bot = fakeBot(() => badRequest('chat not found'));
    await expect(
      bot.run({ kind: 'chat', content: { text: 'yes', threadReply: { quote: 'at noon' } }, inReplyTo: '42:7' }),
    ).rejects.toBeDefined();
    expect(bot.calls).toHaveLength(1);
  });

  it('never resends a delivered chunk when a later one fails', async () => {
    const bot = fakeBot((call) => (call.other.reply_parameters ? undefined : badRequest('quote not found')));
    const long = `${'a'.repeat(TELEGRAM_TEXT_LIMIT - 10)}\n\n${'b'.repeat(200)}`;
    await expect(
      bot.run({ kind: 'chat', content: { text: long, threadReply: { quote: 'aaa' } }, inReplyTo: '42:7' }),
    ).rejects.toBeDefined();
    expect(bot.calls).toHaveLength(2);
  });

  it('sends an agent mention as a tg://user text_link', async () => {
    const bot = fakeBot();
    await bot.run({ kind: 'chat', content: { text: 'ping [Misha](tg://user?id=350751696)' } });
    expect(bot.calls[0].other.entities).toEqual([
      { type: 'text_link', offset: 5, length: 5, url: 'tg://user?id=350751696' },
    ]);
  });
});

describe('telegram outbound never drops text', () => {
  const longCaption = `${'c'.repeat(1000)}\n\n${'tail '.repeat(60)}end`;

  it('sends caption overflow as a follow-up message after a single file', async () => {
    const bot = fakeBot();
    await bot.run({ kind: 'chat', content: { text: longCaption }, files: [file('a.jpg')] });
    expect(bot.calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect(bot.calls[0].other.caption).toBe('c'.repeat(1000));
    expect(bot.calls[1].args[1]).toBe(`${'tail '.repeat(60)}end`);
  });

  it('sends caption overflow after the last of several files', async () => {
    const bot = fakeBot();
    await bot.run({ kind: 'chat', content: { text: longCaption }, files: [file('a.pdf'), file('b.pdf')] });
    expect(bot.calls.map((c) => c.method)).toEqual(['sendDocument', 'sendDocument', 'sendMessage']);
    expect(bot.calls[1].other.caption).toBeUndefined();
  });

  it('keeps every caption when a mixed album falls back to sequential documents', async () => {
    const bot = fakeBot();
    await bot.run({
      kind: 'chat',
      content: {
        operation: 'send_media_group',
        items: [
          { path: 'a.jpg', caption: 'photo caption' },
          { path: 'b.pdf', caption: '**doc** caption' },
        ],
      },
      files: [file('a.jpg'), file('b.pdf')],
    });
    expect(bot.calls.map((c) => [c.method, c.other.caption])).toEqual([
      ['sendDocument', 'photo caption'],
      ['sendDocument', 'doc caption'],
    ]);
    expect(bot.calls[1].other.caption_entities).toEqual([{ type: 'bold', offset: 0, length: 3 }]);
  });

  it('sends a gif in an album as an animation and keeps the rest an album', async () => {
    const bot = fakeBot();
    const id = await bot.run({
      kind: 'chat',
      content: {
        operation: 'send_media_group',
        items: [{ path: 'a.jpg' }, { path: 'b.gif', caption: 'loop' }, { path: 'c.jpg' }],
      },
      files: [file('a.jpg'), file('b.gif'), file('c.jpg')],
    });
    expect(bot.calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendAnimation']);
    expect((bot.calls[0].args[1] as Array<{ type: string }>).map((m) => m.type)).toEqual(['photo', 'photo']);
    expect(bot.calls[1].other.caption).toBe('loop');
    expect(id).toBe('100');
  });

  it('sends album caption overflow after the album', async () => {
    const bot = fakeBot();
    await bot.run({
      kind: 'chat',
      content: { operation: 'send_media_group', items: [{ path: 'a.jpg', caption: longCaption }, { path: 'b.jpg' }] },
      files: [file('a.jpg'), file('b.jpg')],
    });
    expect(bot.calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendMessage']);
  });

  it('splits a long edit: edits the first part and sends the rest', async () => {
    const bot = fakeBot();
    const long = `${'a'.repeat(TELEGRAM_TEXT_LIMIT - 10)}\n\n${'b'.repeat(200)}`;
    await bot.run({ kind: 'chat', content: { operation: 'edit', messageId: '42:7', text: long } });
    expect(bot.calls.map((c) => c.method)).toEqual(['editMessageText', 'sendMessage']);
    expect(bot.calls[0].args.slice(0, 3)).toEqual([42, 7, 'a'.repeat(TELEGRAM_TEXT_LIMIT - 10)]);
    expect(bot.calls[1].args[1]).toBe('b'.repeat(200));
  });

  it('edits the caption of a media message the bot sent', async () => {
    const bot = fakeBot();
    const id = await bot.run({ kind: 'chat', content: { text: 'pic' }, files: [file('a.jpg')] });
    await bot.run({ kind: 'chat', content: { operation: 'edit', messageId: `42:${id}`, text: '**new** caption' } });
    expect(bot.calls[1]).toMatchObject({
      method: 'editMessageCaption',
      other: { caption: 'new caption', caption_entities: [{ type: 'bold', offset: 0, length: 3 }] },
    });
  });

  it('falls back to editMessageCaption when Telegram says the message has no text', async () => {
    const bot = fakeBot((call) =>
      call.method === 'editMessageText'
        ? badRequest('there is no text in the message to edit', call.method)
        : undefined,
    );
    await bot.run({ kind: 'chat', content: { operation: 'edit', messageId: '42:900', text: 'fixed' } });
    expect(bot.calls.map((c) => c.method)).toEqual(['editMessageText', 'editMessageCaption']);
    // Remembered: the next edit goes straight to the caption.
    await bot.run({ kind: 'chat', content: { operation: 'edit', messageId: '42:900', text: 'again' } });
    expect(bot.calls.map((c) => c.method).slice(2)).toEqual(['editMessageCaption']);
  });
});

describe('telegram outbound rich messages', () => {
  const table = '| host | state |\n| --- | --- |\n| bl | up |';

  it('sends rich content through sendRichMessage with its reply parameters', async () => {
    const bot = fakeBot();
    const id = await bot.run({
      kind: 'chat',
      content: { text: table, rich: true, threadReply: { quote: 'status?' } },
      inReplyTo: '42:7',
    });
    expect(bot.calls).toHaveLength(1);
    expect(bot.calls[0]).toMatchObject({
      method: 'sendRichMessage',
      other: { reply_parameters: { message_id: 7, allow_sending_without_reply: true, quote: 'status?' } },
    });
    expect(bot.calls[0].args.slice(0, 2)).toEqual([42, { markdown: table }]);
    expect(id).toBe('100');
  });

  it('resends a rejected rich message as a normal one', async () => {
    const bot = fakeBot((call) =>
      call.method === 'sendRichMessage' ? badRequest('RICH_MESSAGE_INVALID', call.method) : undefined,
    );
    const id = await bot.run({ kind: 'chat', content: { text: '**hi**', rich: true } });
    expect(bot.calls.map((c) => c.method)).toEqual(['sendRichMessage', 'sendMessage']);
    expect(bot.calls[1].args[1]).toBe('hi');
    expect(id).toBe('100');
  });

  it('sends an over-limit rich message as normal split messages', async () => {
    const bot = fakeBot();
    await bot.run({ kind: 'chat', content: { text: 'x '.repeat(17000), rich: true } });
    expect(new Set(bot.calls.map((c) => c.method))).toEqual(new Set(['sendMessage']));
    expect(bot.calls.length).toBeGreaterThan(1);
  });

  it('ignores rich for files and when the host did not set it', async () => {
    const bot = fakeBot();
    await bot.run({ kind: 'chat', content: { text: table, rich: true }, files: [file('a.pdf')] });
    await bot.run({ kind: 'chat', content: { text: table } });
    expect(bot.calls.map((c) => c.method)).toEqual(['sendDocument', 'sendMessage']);
  });

  it('edits a rich message in the rich form, and falls back to a normal edit when rejected', async () => {
    const bot = fakeBot((call) =>
      call.method === 'editMessageText' && (call.args[2] as { markdown?: string }).markdown === 'bad'
        ? badRequest('RICH_MESSAGE_INVALID', call.method)
        : undefined,
    );
    const id = await bot.run({ kind: 'chat', content: { text: table, rich: true } });
    await bot.run({ kind: 'chat', content: { operation: 'edit', messageId: `42:${id}`, text: '# new' } });
    expect(bot.calls[1].method).toBe('editMessageText');
    expect(bot.calls[1].args.slice(0, 3)).toEqual([42, Number(id), { markdown: '# new' }]);

    await bot.run({ kind: 'chat', content: { operation: 'edit', messageId: `42:${id}`, text: 'bad' } });
    expect(bot.calls.slice(2).map((c) => [c.method, c.args[2]])).toEqual([
      ['editMessageText', { markdown: 'bad' }],
      ['editMessageText', 'bad'],
    ]);
  });
});

describe('telegram outbound never sends twice', () => {
  const entityCount = (call: Call): number => (call.other.entities as unknown[] | undefined)?.length ?? 0;
  const long = `${'a'.repeat(TELEGRAM_TEXT_LIMIT - 10)}\n\n**${'b'.repeat(200)}**`;

  it('retries only the chunk Telegram rejected for its entities as plain text', async () => {
    const bot = fakeBot((call) =>
      call.method === 'sendMessage' && (call.args[1] as string).startsWith('b') && entityCount(call) > 0
        ? badRequest("can't parse entities")
        : undefined,
    );
    await bot.run({ kind: 'chat', content: { text: long } });
    expect(bot.calls.map((c) => [(c.args[1] as string)[0], entityCount(c)])).toEqual([
      ['a', 0],
      ['b', 1],
      ['b', 0],
    ]);
  });

  it('keeps a delivered file delivered when its caption follow-up fails', async () => {
    const bot = fakeBot((call) => (call.method === 'sendMessage' ? badRequest('chat not found') : undefined));
    const id = await bot.run({
      kind: 'chat',
      content: { text: `${'c'.repeat(1000)}\n\n${'tail '.repeat(60)}` },
      files: [file('a.jpg')],
    });
    expect(id).toBe('100');
    expect(bot.calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
  });

  it('treats an edit Telegram reports as not modified as done, rich or not', async () => {
    const bot = fakeBot((call) =>
      call.method === 'editMessageText' ? badRequest('message is not modified') : undefined,
    );
    await bot.run({ kind: 'chat', content: { operation: 'edit', messageId: '42:7', text: 'same' } });
    const id = await bot.run({ kind: 'chat', content: { text: '| a |', rich: true } });
    await bot.run({ kind: 'chat', content: { operation: 'edit', messageId: `42:${id}`, text: '| a |' } });
    expect(bot.calls.map((c) => c.method)).toEqual(['editMessageText', 'sendRichMessage', 'editMessageText']);
  });

  it('leaves a rate-limited or failed rich send to the host retry instead of resending it plain', async () => {
    for (const code of [429, 500]) {
      const bot = fakeBot((call) =>
        call.method === 'sendRichMessage' ? badRequest('Too Many Requests', call.method, code) : undefined,
      );
      await expect(bot.run({ kind: 'chat', content: { text: '| a |', rich: true } })).rejects.toBeDefined();
      expect(bot.calls.map((c) => c.method)).toEqual(['sendRichMessage']);
    }
  });

  it("sends nothing and reports it when none of an album's files are in the outbox", async () => {
    const bot = fakeBot();
    const id = await bot.run({
      kind: 'chat',
      content: { operation: 'send_media_group', items: [{ path: 'x.jpg' }, { path: 'y.jpg' }] },
      files: [],
    });
    expect(id).toBeUndefined();
    expect(bot.calls).toEqual([]);
  });
});
