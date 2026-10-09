/**
 * Outbound dispatch for the telegram-grammy adapter.
 *
 * Every outbound call goes through grammY's typed Bot API using the
 * `entities[]` parameter (not `parse_mode`) — Telegram's server never
 * invokes a parser when entities are provided, so the GrammyEntityError
 * bug class vanishes by construction. `sendWithFallback` catches the
 * one-in-a-thousand case where our own mdast walker produces entity
 * offsets Telegram rejects anyway, and retries as plain text.
 *
 * Ops supported:
 *   - default message  (text + optional files; `rich: true` sends a Rich Message)
 *   - edit             ({ operation: 'edit', messageId, text/markdown })
 *   - reaction         ({ operation: 'reaction', messageId, emoji })
 *   - send_media_group ({ operation: 'send_media_group', items })
 *   - ask_question     ({ type: 'ask_question', questionId, title, question?, options })
 *
 * A default message or media group carries `reply_parameters` on its first
 * send when the host marked it `threadReply` (see delivery.ts).
 */
import path from 'path';

import { Effect } from 'effect';
import { FormattedString } from '@grammyjs/parse-mode';
import { InputFile } from 'grammy';
import type {
  InputMediaAudio,
  InputMediaDocument,
  InputMediaPhoto,
  InputMediaVideo,
  ReplyParameters,
} from 'grammy/types';

import type { OutboundFile, OutboundMessage } from '../adapter.js';
import { normalizeOptions, type NormalizedOption, type RawOption } from '../ask-question.js';

import { buildAskQuestionKeyboard } from './ask-question.js';
import type { GrammyDeliveryError } from './errors.js';
import { mapGrammyError } from './errors.js';
import { renderFS, splitCaption, splitForBody, TELEGRAM_RICH_TEXT_LIMIT } from './formatter.js';
import { extractTelegramMessageId, parseChatId, parseTopicId, resolveMessageThreadId } from './inbound.js';
import { createMessageMap, rememberTopicMessage } from './topic-map.js';
import { resolveReactionEmoji, type TelegramReactionEmoji } from './reactions.js';
import { BotService } from './services.js';
import { probeMediaMeta } from './media-meta.js';

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.flac']);
const VOICE_EXTS = new Set(['.ogg', '.oga']);
const ANIMATION_EXTS = new Set(['.gif']);

type MediaKind = 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'document';

function mediaKindFromFilename(filename: string): MediaKind {
  const ext = path.extname(filename).toLowerCase();
  if (PHOTO_EXTS.has(ext)) return 'photo';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VOICE_EXTS.has(ext)) return 'voice';
  if (ANIMATION_EXTS.has(ext)) return 'animation';
  return 'document';
}

interface ContentView {
  text: string;
  /** The host allowed a Rich Message (see `richAllowed` in src/delivery.ts). */
  rich: boolean;
  isEdit: boolean;
  editMessageId?: string;
  isReaction: boolean;
  reactionMessageId?: string;
  reactionEmoji?: string;
  isMediaGroup: boolean;
  mediaGroupItems?: ReadonlyArray<{ path: string; caption?: string }>;
  isAskQuestion: boolean;
  askQuestionId?: string;
  askTitle?: string;
  askQuestion?: string;
  askOptions?: ReadonlyArray<RawOption>;
  isCard: boolean;
  cardFallbackText?: string;
}

function viewContent(message: OutboundMessage): ContentView {
  const c = (message.content as Record<string, unknown> | null | undefined) ?? {};
  const text = typeof c.markdown === 'string' ? c.markdown : typeof c.text === 'string' ? c.text : '';

  const isEdit = c.operation === 'edit' && typeof c.messageId === 'string';
  const isReaction = c.operation === 'reaction' && typeof c.messageId === 'string';
  const isMediaGroup = c.operation === 'send_media_group' && Array.isArray(c.items);
  const isAskQuestion = c.type === 'ask_question' && typeof c.questionId === 'string' && Array.isArray(c.options);
  // Telegram has no card primitive — fall back to the caller-provided text
  // body so the content arrives as a plain message rather than raw JSON.
  const isCard = c.type === 'card' && typeof c.fallbackText === 'string';

  return {
    text,
    rich: c.rich === true,
    isEdit,
    editMessageId: isEdit ? (c.messageId as string) : undefined,
    isReaction,
    reactionMessageId: isReaction ? (c.messageId as string) : undefined,
    reactionEmoji: isReaction ? (typeof c.emoji === 'string' ? c.emoji : undefined) : undefined,
    isMediaGroup,
    mediaGroupItems: isMediaGroup ? (c.items as ReadonlyArray<{ path: string; caption?: string }>) : undefined,
    isAskQuestion,
    askQuestionId: isAskQuestion ? (c.questionId as string) : undefined,
    askTitle: isAskQuestion ? (typeof c.title === 'string' ? c.title : '') : undefined,
    askQuestion: isAskQuestion ? (typeof c.question === 'string' ? c.question : '') : undefined,
    askOptions: isAskQuestion ? (c.options as ReadonlyArray<RawOption>) : undefined,
    isCard,
    cardFallbackText: isCard ? (c.fallbackText as string) : undefined,
  };
}

/**
 * `reply_parameters` for a message the host decided to show as a reply:
 * `content.threadReply` is set and `inReplyTo` names a message in this chat.
 */
function replyParametersFor(message: OutboundMessage, chatId: number): ReplyParameters | undefined {
  const thread = (message.content as Record<string, unknown> | null | undefined)?.threadReply;
  if (!message.inReplyTo || typeof thread !== 'object' || thread === null) return undefined;
  const parsed = extractTelegramMessageId(message.inReplyTo, chatId);
  if (!parsed || parsed.chatId !== chatId) return undefined;
  const quote = (thread as { quote?: unknown }).quote;
  return {
    message_id: parsed.messageId,
    allow_sending_without_reply: true,
    ...(typeof quote === 'string' && quote ? { quote } : {}),
  };
}

/**
 * One send of a possibly multi-message delivery: only the first (`index` 0)
 * carries `reply_parameters`. A quote Telegram cannot find in the original
 * fails that send, so it is retried once without the quote - the reply still
 * threads, the highlight is lost, and nothing already sent goes out again.
 */
const sendReplying = <A, R>(
  index: number,
  reply: ReplyParameters | undefined,
  send: (reply: ReplyParameters | undefined) => Effect.Effect<A, GrammyDeliveryError, R>,
): Effect.Effect<A, GrammyDeliveryError, R> => {
  if (index !== 0 || !reply?.quote) return send(index === 0 ? reply : undefined);
  const { quote: _quote, ...unquoted } = reply;
  return send(reply).pipe(
    Effect.catchTag('GrammyQuoteError', (err) =>
      Effect.logWarning('telegram-grammy: quote rejected, replying without it', err).pipe(
        Effect.andThen(send(unquoted)),
      ),
    ),
  );
};

/**
 * Retry-once helper: if the send fails with GrammyEntityError (malformed
 * entities - our mdast walker produced offsets Telegram's validator
 * rejected), retry it with entities stripped, as plain text.
 */
const sendWithFallback = <A>(
  send: (plain: boolean) => Effect.Effect<A, GrammyDeliveryError, BotService>,
): Effect.Effect<A, GrammyDeliveryError, BotService> =>
  send(false).pipe(
    Effect.catchTag('GrammyEntityError', (err) =>
      Effect.logWarning('telegram-grammy: entity error, retrying as plain text', err).pipe(Effect.andThen(send(true))),
    ),
  );

/**
 * Whatever goes out after a delivery's first message has landed: failing it
 * would make the host retry the whole delivery and send that first message
 * again, so a failure here is logged instead.
 */
const afterFirstSend = <R>(
  what: string,
  send: Effect.Effect<unknown, GrammyDeliveryError, R>,
): Effect.Effect<void, never, R> =>
  send.pipe(
    Effect.asVoid,
    Effect.catch((err) => Effect.logError(`telegram-grammy: ${what} failed after the message was sent`, err)),
  );

/**
 * Send text chunks in order; returns the last sent chunk's id. Only the first
 * chunk can fail the delivery. The plain-text retry is per chunk, so a chunk
 * that already went out is never sent again.
 */
const sendTextChunks = Effect.fn('telegram-grammy.sendTextChunks')(function* (
  chatId: number,
  messageThreadId: number | undefined,
  chunks: readonly FormattedString[],
  reply: ReplyParameters | undefined,
) {
  const { bot } = yield* BotService;
  let lastId: string | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const send = sendWithFallback((plain) =>
      sendReplying(index, reply, (replyParameters) =>
        Effect.tryPromise({
          try: () =>
            bot.api.sendMessage(chatId, chunk.text, {
              entities: plain ? undefined : chunk.entities,
              message_thread_id: messageThreadId,
              link_preview_options: { is_disabled: true },
              reply_parameters: replyParameters,
            }),
          catch: (err) => mapGrammyError(err, plain ? 'sendMessage-plain' : 'sendMessage', String(chatId)),
        }),
      ),
    ).pipe(
      Effect.tap((sent) =>
        Effect.sync(() => {
          lastId = String(sent.message_id);
        }),
      ),
    );
    if (index === 0) yield* send;
    else yield* afterFirstSend(`chunk ${index + 1} of ${chunks.length}`, send);
  }
  return lastId;
});

/**
 * Text that did not fit where it was meant to go (a caption's overflow, the
 * tail of a long edit), sent as follow-up messages so nothing is lost.
 */
const sendFollowUp = (
  chatId: number,
  messageThreadId: number | undefined,
  chunks: readonly FormattedString[],
): Effect.Effect<void, never, BotService> =>
  chunks.length === 0
    ? Effect.void
    : afterFirstSend('overflow follow-up', sendTextChunks(chatId, messageThreadId, chunks, undefined));

/**
 * What the bot sent as (chatId, messageId), for edits: a media message takes
 * `editMessageCaption`, a Rich Message the rich edit form. Wiped by a host
 * restart; an edit of an unremembered media message still lands through the
 * "no text" retry, one of a Rich Message as a normal edit.
 */
type SentKind = 'media' | 'rich';
const sentKinds = createMessageMap<SentKind>();

function rememberSentKind(chatId: number, messageId: string | number | undefined, kind: SentKind): void {
  if (messageId !== undefined) sentKinds.remember(chatId, messageId, kind);
}

export function _clearSentKindsForTest(): void {
  sentKinds.clear();
}

/** Kind-dispatched single-file send. Extracted so each branch has a unique inferred `A`. */
const sendSingleFile = (
  bot: { api: import('grammy').Api },
  chatId: number,
  kind: MediaKind,
  file: OutboundFile,
  caption: FormattedString | undefined,
  messageThreadId: number | undefined,
  reply: ReplyParameters | undefined,
): Effect.Effect<string, GrammyDeliveryError> => {
  const input = new InputFile(file.data, file.filename);
  const baseOpts = {
    caption: caption?.text,
    caption_entities: caption?.entities,
    message_thread_id: messageThreadId,
    reply_parameters: reply,
  };
  const method = `send-${kind}`;
  const mapId = (messageId: number): string => String(messageId);
  switch (kind) {
    case 'photo':
      return Effect.tryPromise({
        try: () => bot.api.sendPhoto(chatId, input, baseOpts),
        catch: (err) => mapGrammyError(err, method, String(chatId)),
      }).pipe(Effect.map((m) => mapId(m.message_id)));
    case 'video':
      // Probe width/height/duration so Telegram renders the correct
      // aspect ratio (and not a square placeholder for portrait clips).
      // Probe failure → send without dimensions; delivery still works.
      return Effect.promise(() => probeMediaMeta(file.data)).pipe(
        Effect.flatMap((meta) =>
          Effect.tryPromise({
            try: () =>
              bot.api.sendVideo(chatId, input, {
                ...baseOpts,
                supports_streaming: true,
                ...(meta ?? {}),
              }),
            catch: (err) => mapGrammyError(err, method, String(chatId)),
          }),
        ),
        Effect.map((m) => mapId(m.message_id)),
      );
    case 'audio':
      // Probe duration so the player chrome shows the right length
      // immediately — without it Telegram displays "0:00" until the
      // client finishes downloading + parsing the file.
      return Effect.promise(() => probeMediaMeta(file.data)).pipe(
        Effect.flatMap((meta) =>
          Effect.tryPromise({
            try: () =>
              bot.api.sendAudio(chatId, input, {
                ...baseOpts,
                ...(meta?.duration != null ? { duration: meta.duration } : {}),
              }),
            catch: (err) => mapGrammyError(err, method, String(chatId)),
          }),
        ),
        Effect.map((m) => mapId(m.message_id)),
      );
    case 'voice':
      return Effect.promise(() => probeMediaMeta(file.data)).pipe(
        Effect.flatMap((meta) =>
          Effect.tryPromise({
            try: () =>
              bot.api.sendVoice(chatId, input, {
                ...baseOpts,
                ...(meta?.duration != null ? { duration: meta.duration } : {}),
              }),
            catch: (err) => mapGrammyError(err, method, String(chatId)),
          }),
        ),
        Effect.map((m) => mapId(m.message_id)),
      );
    case 'animation':
      return Effect.promise(() => probeMediaMeta(file.data)).pipe(
        Effect.flatMap((meta) =>
          Effect.tryPromise({
            try: () =>
              bot.api.sendAnimation(chatId, input, {
                ...baseOpts,
                ...(meta ?? {}),
              }),
            catch: (err) => mapGrammyError(err, method, String(chatId)),
          }),
        ),
        Effect.map((m) => mapId(m.message_id)),
      );
    case 'document':
    default:
      return Effect.tryPromise({
        try: () => bot.api.sendDocument(chatId, input, baseOpts),
        catch: (err) => mapGrammyError(err, method, String(chatId)),
      }).pipe(Effect.map((m) => mapId(m.message_id)));
  }
};

/**
 * Send a default text+files message. Returns the last chunk's message id, or
 * for files the last file's id. Text longer than a caption follows the
 * file(s) as its own messages.
 */
const sendDefault = Effect.fn('telegram-grammy.sendDefault')(function* (
  chatId: number,
  messageThreadId: number | undefined,
  text: string,
  files: ReadonlyArray<OutboundFile>,
  reply: ReplyParameters | undefined,
) {
  const { bot } = yield* BotService;

  if (files.length === 0) {
    if (!text) return undefined;
    return yield* sendTextChunks(chatId, messageThreadId, splitForBody(renderFS(text)), reply);
  }

  const { caption, rest } = text ? splitCaption(renderFS(text)) : { caption: undefined, rest: [] };

  // One file goes out as its own kind. Several go as sequential documents:
  // Telegram's media group API requires 2-10 items AND forbids mixing
  // photos/videos with documents/audios, so sequential docs is the most
  // permissive path for arbitrary attachment bundles. For an opinionated
  // media group callers should use the `send_media_group` operation.
  let lastId: string | undefined;
  for (const [index, file] of files.entries()) {
    const kind = files.length === 1 ? mediaKindFromFilename(file.filename) : 'document';
    const send = sendReplying(index, reply, (replyParameters) =>
      sendSingleFile(bot, chatId, kind, file, index === 0 ? caption : undefined, messageThreadId, replyParameters),
    ).pipe(
      Effect.tap((id) =>
        Effect.sync(() => {
          lastId = id;
          rememberSentKind(chatId, id, 'media');
        }),
      ),
    );
    if (index === 0) yield* send;
    else yield* afterFirstSend(`file ${index + 1} of ${files.length}`, send);
  }
  yield* sendFollowUp(chatId, messageThreadId, rest);
  return lastId;
});

/** Telegram's answer to `editMessageText` on a message that has a caption instead of text. */
const NO_TEXT_TO_EDIT_RE = /no text in the message/i;

/** Telegram's answer to an edit that changes nothing: the edit already holds. */
const NOT_MODIFIED_RE = /message is not modified/i;

/** An edit that already holds (a repeat, or a host retry after it landed) is a success. */
const tolerateNotModified = <R>(
  edit: Effect.Effect<unknown, GrammyDeliveryError, R>,
): Effect.Effect<void, GrammyDeliveryError, R> =>
  edit.pipe(
    Effect.asVoid,
    Effect.catchTag('GrammyApiError', (err) =>
      NOT_MODIFIED_RE.test(err.description) ? Effect.void : Effect.fail(err),
    ),
  );

const editTextBody = (
  chatId: number,
  messageId: number,
  fs: FormattedString,
): Effect.Effect<FormattedString[], GrammyDeliveryError, BotService> =>
  Effect.gen(function* () {
    const { bot } = yield* BotService;
    const [head, ...rest] = splitForBody(fs);
    if (!head) return [];
    yield* sendWithFallback((plain) =>
      tolerateNotModified(
        Effect.tryPromise({
          try: () => bot.api.editMessageText(chatId, messageId, head.text, plain ? {} : { entities: head.entities }),
          catch: (err) => mapGrammyError(err, plain ? 'editMessageText-plain' : 'editMessageText', String(chatId)),
        }),
      ),
    );
    return rest;
  });

const editCaptionBody = (
  chatId: number,
  messageId: number,
  fs: FormattedString,
): Effect.Effect<FormattedString[], GrammyDeliveryError, BotService> =>
  Effect.gen(function* () {
    const { bot } = yield* BotService;
    const { caption, rest } = splitCaption(fs);
    yield* sendWithFallback((plain) =>
      tolerateNotModified(
        Effect.tryPromise({
          try: () =>
            bot.api.editMessageCaption(chatId, messageId, {
              caption: caption?.text ?? '',
              ...(plain ? {} : { caption_entities: caption?.entities }),
            }),
          catch: (err) =>
            mapGrammyError(err, plain ? 'editMessageCaption-plain' : 'editMessageCaption', String(chatId)),
        }),
      ),
    );
    return rest;
  });

/**
 * Whether Telegram refused the content itself (a 400, or 404 from a Bot API
 * server without the method), so the normal path must carry it. A rate limit
 * or server error is left to the host's retry: a 5xx does not prove the Rich
 * Message was not created, and resending it plain could duplicate it.
 */
const isTelegramRejection = (err: GrammyDeliveryError): boolean =>
  err._tag === 'GrammyEntityError' ||
  (err._tag === 'GrammyApiError' && (err.errorCode === 400 || err.errorCode === 404));

const onRejection =
  <B, R2>(what: string, fallback: Effect.Effect<B, GrammyDeliveryError, R2>) =>
  <A, R>(rich: Effect.Effect<A, GrammyDeliveryError, R>): Effect.Effect<A | B, GrammyDeliveryError, R | R2> =>
    rich.pipe(
      Effect.catch((err) =>
        isTelegramRejection(err)
          ? Effect.logWarning(`telegram-grammy: ${what} rejected, using a normal message`, err).pipe(
              Effect.andThen(fallback),
            )
          : Effect.fail(err),
      ),
    );

/**
 * Send the agent's markdown as a Rich Message (Bot API 10.1+): real tables,
 * headings, task lists. Too long for one, or rejected by Telegram, it goes out
 * as a normal message instead, so the text always arrives.
 */
const sendRich = Effect.fn('telegram-grammy.sendRich')(function* (
  chatId: number,
  messageThreadId: number | undefined,
  markdown: string,
  reply: ReplyParameters | undefined,
) {
  if (markdown.length > TELEGRAM_RICH_TEXT_LIMIT) {
    yield* Effect.logWarning('telegram-grammy: rich message over the limit, sending it as a normal message', {
      chatId,
      length: markdown.length,
    });
    return yield* sendDefault(chatId, messageThreadId, markdown, [], reply);
  }
  const { bot } = yield* BotService;
  return yield* sendReplying(0, reply, (replyParameters) =>
    Effect.tryPromise({
      try: () =>
        bot.api.sendRichMessage(
          chatId,
          { markdown },
          { message_thread_id: messageThreadId, reply_parameters: replyParameters },
        ),
      catch: (err) => mapGrammyError(err, 'sendRichMessage', String(chatId)),
    }),
  ).pipe(
    Effect.map((sent) => {
      rememberSentKind(chatId, sent.message_id, 'rich');
      return String(sent.message_id);
    }),
    onRejection('rich message', sendDefault(chatId, messageThreadId, markdown, [], reply)),
  );
});

/**
 * Edit a Rich Message in the rich form. Returns false when it did not take
 * (too long, or rejected) so the caller edits it as a normal message.
 */
const editRich = (
  chatId: number,
  messageId: number,
  markdown: string,
): Effect.Effect<boolean, GrammyDeliveryError, BotService> =>
  Effect.gen(function* () {
    if (markdown.length > TELEGRAM_RICH_TEXT_LIMIT) return false;
    const { bot } = yield* BotService;
    return yield* tolerateNotModified(
      Effect.tryPromise({
        try: () => bot.api.editMessageText(chatId, messageId, { markdown }),
        catch: (err) => mapGrammyError(err, 'editMessageText-rich', String(chatId)),
      }),
    ).pipe(Effect.as(true), onRejection('rich edit', Effect.succeed(false)));
  });

/**
 * Edit a message the bot sent. A Rich Message is edited in the rich form while
 * the host allows it (`rich`, the group's toggle), otherwise as a normal
 * message; a media message gets its caption edited (known from what was sent, or learned
 * from Telegram's "no text" answer). Text beyond the message's limit is sent
 * right after as new messages, so each long edit appends a fresh tail.
 */
const editMessage = Effect.fn('telegram-grammy.editMessage')(function* (
  chatId: number,
  messageThreadId: number | undefined,
  compound: string,
  text: string,
  rich: boolean,
) {
  const parsed = extractTelegramMessageId(compound, chatId);
  if (!parsed) {
    yield* Effect.logError('telegram-grammy: edit with invalid compound id', { compound });
    return undefined;
  }
  // The delivery ACL vets only the row's own chat; the compound id is the agent's to write.
  if (parsed.chatId !== chatId) {
    yield* Effect.logError('telegram-grammy: refusing an edit of a message in another chat', {
      chatId,
      targetChatId: parsed.chatId,
    });
    return undefined;
  }
  const kind = sentKinds.get(parsed.chatId, parsed.messageId);
  if (kind === 'rich' && rich && (yield* editRich(parsed.chatId, parsed.messageId, text))) return undefined;
  const fs = renderFS(text);
  const rest =
    kind === 'media'
      ? yield* editCaptionBody(parsed.chatId, parsed.messageId, fs)
      : yield* editTextBody(parsed.chatId, parsed.messageId, fs).pipe(
          Effect.catchTag('GrammyApiError', (err) =>
            NO_TEXT_TO_EDIT_RE.test(err.description)
              ? Effect.andThen(
                  Effect.sync(() => rememberSentKind(parsed.chatId, parsed.messageId, 'media')),
                  editCaptionBody(parsed.chatId, parsed.messageId, fs),
                )
              : Effect.fail(err),
          ),
        );
  yield* sendFollowUp(parsed.chatId, messageThreadId, rest);
  return undefined;
});

const reactToMessage = Effect.fn('telegram-grammy.reactToMessage')(function* (
  chatId: number,
  compound: string,
  emoji: string | undefined,
) {
  const parsed = extractTelegramMessageId(compound, chatId);
  if (!parsed) {
    yield* Effect.logError('telegram-grammy: reaction with invalid compound id', { compound });
    return undefined;
  }
  if (parsed.chatId !== chatId) {
    yield* Effect.logError('telegram-grammy: refusing a reaction on a message in another chat', {
      chatId,
      targetChatId: parsed.chatId,
    });
    return undefined;
  }
  // Translate slug-or-glyph input into Telegram's fixed allowlist before
  // shipping to the wire. Empty/missing emoji clears any existing reaction;
  // input Telegram would reject is nearest-matched, and only unmappable input
  // is dropped (the alternative is a guaranteed REACTION_INVALID 400 from the
  // Bot API). See resolveReactionEmoji for the slug map, the fallback table
  // and the rationale. Delivery resolves the same way before it gets here (so
  // it can tell the agent what happened, which this seam cannot); resolving
  // again is the last line against a future caller that reaches `deliver`
  // without going through the host's reaction guard.
  const reactions: Array<{ type: 'emoji'; emoji: TelegramReactionEmoji }> = [];
  if (emoji) {
    const { glyph } = resolveReactionEmoji(emoji);
    if (!glyph) {
      yield* Effect.logWarning('telegram-grammy: dropping reaction with unknown emoji', {
        input: emoji,
        chatId,
        compound,
      });
      return undefined;
    }
    reactions.push({ type: 'emoji', emoji: glyph });
  }
  const { bot } = yield* BotService;
  yield* Effect.tryPromise({
    try: () => bot.api.setMessageReaction(parsed.chatId, parsed.messageId, reactions),
    catch: (err) => mapGrammyError(err, 'setMessageReaction', String(chatId)),
  });
  return undefined;
});

type AlbumInput = InputMediaPhoto | InputMediaVideo | InputMediaAudio | InputMediaDocument;
type AlbumItem = { file: OutboundFile; kind: MediaKind; caption: FormattedString | undefined };

/** The `sendMediaGroup` entry for one item; only here are videos probed for their dimensions. */
const albumInput = ({ file, kind, caption }: AlbumItem): Effect.Effect<AlbumInput> => {
  const base = {
    media: new InputFile(file.data, file.filename),
    caption: caption?.text,
    caption_entities: caption?.entities,
  };
  if (kind === 'video') {
    return Effect.promise(() => probeMediaMeta(file.data)).pipe(
      Effect.map((meta): AlbumInput => ({ type: 'video', supports_streaming: true, ...base, ...(meta ?? {}) })),
    );
  }
  if (kind === 'photo') return Effect.succeed({ type: 'photo', ...base });
  if (kind === 'audio') return Effect.succeed({ type: 'audio', ...base });
  return Effect.succeed({ type: 'document', ...base });
};

/**
 * Send 2-10 files as an album. Each item keeps its own caption, and caption
 * text beyond Telegram's limit follows as messages. A `.gif` cannot sit in a
 * Telegram album, so it goes out as its own animation after the album. An
 * album that would mix photos/videos with documents/audio (Telegram forbids
 * it) falls back to sequential documents, each still captioned. Returns the
 * album's first id, or the last document's on the sequential fallback.
 */
const sendMediaGroup = Effect.fn('telegram-grammy.sendMediaGroup')(function* (
  chatId: number,
  messageThreadId: number | undefined,
  items: ReadonlyArray<{ path: string; caption?: string }>,
  files: ReadonlyArray<OutboundFile>,
  reply: ReplyParameters | undefined,
) {
  if (items.length < 2 || items.length > 10) {
    yield* Effect.logWarning('telegram-grammy: send_media_group requires 2-10 items', { count: items.length });
    return undefined;
  }
  const { bot } = yield* BotService;

  const overflow: FormattedString[] = [];
  const album: AlbumItem[] = [];
  const animations: AlbumItem[] = [];
  for (const item of items) {
    const bare = path.basename(item.path);
    const file = files.find((f) => f.filename === bare);
    if (!file) {
      yield* Effect.logWarning('telegram-grammy: send_media_group file not found', { path: item.path });
      continue;
    }
    const { caption, rest } = item.caption ? splitCaption(renderFS(item.caption)) : { caption: undefined, rest: [] };
    overflow.push(...rest);
    const kind = mediaKindFromFilename(file.filename);
    (kind === 'animation' ? animations : album).push({ file, kind, caption });
  }
  if (album.length === 0 && animations.length === 0) {
    yield* Effect.logError('telegram-grammy: send_media_group found none of its files; nothing sent', { items });
    return undefined;
  }

  let sends = 0;
  let resultId: string | undefined;
  const sendOne = (item: AlbumItem, kind: MediaKind) =>
    sendReplying(sends++, reply, (replyParameters) =>
      sendSingleFile(bot, chatId, kind, item.file, item.caption, messageThreadId, replyParameters),
    ).pipe(Effect.tap((id) => Effect.sync(() => rememberSentKind(chatId, id, 'media'))));

  const kinds = new Set(album.map((a) => a.kind));
  const mixed = (kinds.has('photo') || kinds.has('video')) && (kinds.has('document') || kinds.has('audio'));
  if (album.length === 1) {
    resultId = yield* sendOne(album[0], album[0].kind);
  } else if (mixed) {
    yield* Effect.logWarning('telegram-grammy: media group would mix types, falling back to sequential');
    for (const [index, item] of album.entries()) {
      const send = sendOne(item, 'document').pipe(
        Effect.tap((id) =>
          Effect.sync(() => {
            resultId = id;
          }),
        ),
      );
      if (index === 0) yield* send;
      else yield* afterFirstSend(`album document ${index + 1} of ${album.length}`, send);
    }
  } else if (album.length > 1) {
    const inputs = yield* Effect.forEach(album, albumInput);
    const sent = yield* sendReplying(sends++, reply, (replyParameters) =>
      Effect.tryPromise({
        // grammY 1.46 types each media-group family apart; the mixed-type check above narrows only at runtime.
        try: () =>
          bot.api.sendMediaGroup(chatId, inputs as Parameters<typeof bot.api.sendMediaGroup>[1], {
            message_thread_id: messageThreadId,
            reply_parameters: replyParameters,
          }),
        catch: (err) => mapGrammyError(err, 'sendMediaGroup', String(chatId)),
      }),
    );
    for (const m of sent) rememberSentKind(chatId, m.message_id, 'media');
    resultId = sent.length > 0 ? String(sent[0].message_id) : undefined;
  }

  for (const item of animations) {
    if (resultId === undefined) resultId = yield* sendOne(item, 'animation');
    else yield* afterFirstSend('album animation', sendOne(item, 'animation'));
  }

  yield* sendFollowUp(chatId, messageThreadId, overflow);
  return resultId;
});

const sendAskQuestion = Effect.fn('telegram-grammy.sendAskQuestion')(function* (
  chatId: number,
  messageThreadId: number | undefined,
  questionId: string,
  title: string,
  question: string,
  optionsRaw: ReadonlyArray<RawOption>,
) {
  const { bot } = yield* BotService;
  const options: NormalizedOption[] = normalizeOptions(optionsRaw as RawOption[]);
  const { keyboard, skippedLabels } = buildAskQuestionKeyboard(questionId, options);
  if (skippedLabels.length > 0) {
    yield* Effect.logError('telegram-grammy: ask_question options exceed 64-byte callback limit', {
      questionId,
      skipped: skippedLabels,
    });
  }

  const body = question ? `${title}\n\n${question}` : title;
  const fs = renderFS(body);
  const chunks = splitForBody(fs);
  if (chunks.length === 0) return undefined;

  const [head, ...tail] = chunks;
  const headSent = yield* Effect.tryPromise({
    try: () =>
      bot.api.sendMessage(chatId, head.text, {
        entities: head.entities,
        reply_markup: keyboard,
        message_thread_id: messageThreadId,
        link_preview_options: { is_disabled: true },
      }),
    catch: (err) => mapGrammyError(err, 'sendMessage-askQuestion', String(chatId)),
  });

  yield* sendFollowUp(chatId, messageThreadId, tail);

  return String(headSent.message_id);
});

/**
 * Public outbound entrypoint. Switches on content shape and runs the
 * matching sub-effect.
 */
export const dispatchOutbound = Effect.fn('telegram-grammy.dispatchOutbound')(function* (
  platformId: string,
  threadId: string | null,
  message: OutboundMessage,
) {
  const chatId = parseChatId(platformId);
  const view = viewContent(message);
  // A per-topic platformId (`telegram:<chatId>:<topicId>`) carries the forum
  // topic in its 3rd segment — every send below lands in that topic.
  const messageThreadId = resolveMessageThreadId(platformId, threadId);
  const topicScoped = parseTopicId(platformId) !== undefined;
  const files = message.files ?? [];
  const reply = replyParametersFor(message, chatId);

  let result: string | undefined = undefined;

  if (view.isEdit && view.editMessageId != null) {
    result = yield* editMessage(chatId, messageThreadId, view.editMessageId, view.text, view.rich);
  } else if (view.isReaction && view.reactionMessageId != null) {
    result = yield* reactToMessage(chatId, view.reactionMessageId, view.reactionEmoji);
  } else if (view.isMediaGroup && view.mediaGroupItems) {
    result = yield* sendMediaGroup(chatId, messageThreadId, view.mediaGroupItems, files, reply);
  } else if (view.isAskQuestion && view.askQuestionId != null && view.askTitle != null && view.askOptions) {
    result = yield* sendAskQuestion(
      chatId,
      messageThreadId,
      view.askQuestionId,
      view.askTitle,
      view.askQuestion ?? '',
      view.askOptions,
    );
  } else if (view.rich && !view.isCard && files.length === 0 && view.text) {
    result = yield* sendRich(chatId, messageThreadId, view.text, reply);
  } else {
    const text = view.isCard && view.cardFallbackText != null ? view.cardFallbackText : view.text;
    result = yield* sendDefault(chatId, messageThreadId, text, files, reply);
  }

  // Remember which topic the bot's own message went to, so a user reaction
  // on it (whose update carries no topic id) can be routed back here.
  if (topicScoped && result !== undefined) {
    const sentId = Number(result);
    if (Number.isFinite(sentId)) rememberTopicMessage(chatId, sentId, platformId);
  }

  return result;
});
