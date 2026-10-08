/**
 * Reply threading on the outbound path: `reply_parameters` rides only the
 * first send, only when the host marked the message `threadReply`, and a
 * quote Telegram rejects is retried once without it.
 */
import { Effect, Layer } from 'effect';
import { GrammyError } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import type { OutboundMessage } from '../adapter.js';
import { dispatchOutbound } from './outbound.js';
import { BotService, type HydratedBot } from './services.js';
import { TELEGRAM_TEXT_LIMIT } from './formatter.js';

type Call = { method: string; other: Record<string, unknown> };

function fakeBot(fail?: (call: Call) => unknown) {
  const calls: Call[] = [];
  let nextId = 100;
  const record =
    (method: string) =>
    (_chatId: number, _payload: unknown, other: Record<string, unknown> = {}) => {
      const call = { method, other };
      calls.push(call);
      const err = fail?.(call);
      return err ? Promise.reject(err) : Promise.resolve({ message_id: nextId++ });
    };
  const layer = Layer.succeed(BotService, {
    bot: {
      api: { sendMessage: record('sendMessage'), sendDocument: record('sendDocument'), sendPhoto: record('sendPhoto') },
    } as unknown as HydratedBot,
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

const file = (filename: string) => ({ filename, data: Buffer.from('x') });

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

  it('sends an agent mention as a tg://user text_link', async () => {
    const bot = fakeBot();
    await bot.run({ kind: 'chat', content: { text: 'ping [Misha](tg://user?id=350751696)' } });
    expect(bot.calls[0].other.entities).toEqual([
      { type: 'text_link', offset: 5, length: 5, url: 'tg://user?id=350751696' },
    ]);
  });
});
