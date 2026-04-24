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
 *   - default message  (text + optional files)
 *   - edit             ({ operation: 'edit', messageId, text/markdown })
 *   - reaction         ({ operation: 'reaction', messageId, emoji })
 *   - send_media_group ({ operation: 'send_media_group', items })
 *   - ask_question     ({ type: 'ask_question', questionId, title, question?, options })
 */
import path from 'path';

import { Effect } from 'effect';
import { FormattedString } from '@grammyjs/parse-mode';
import { InputFile } from 'grammy';
import type { InputMediaAudio, InputMediaDocument, InputMediaPhoto, InputMediaVideo } from 'grammy/types';

import type { OutboundFile, OutboundMessage } from '../adapter.js';
import { normalizeOptions, type NormalizedOption, type RawOption } from '../ask-question.js';

import { buildAskQuestionKeyboard } from './ask-question.js';
import type { GrammyDeliveryError } from './errors.js';
import { mapGrammyError } from './errors.js';
import { renderFS, splitForBody, splitForCaption } from './formatter.js';
import { extractTelegramMessageId, parseChatId, parseThreadId } from './inbound.js';
import { clearPendingSeen } from './reactions.js';
import { BotService } from './services.js';

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
  const isAskQuestion =
    c.type === 'ask_question' && typeof c.questionId === 'string' && Array.isArray(c.options);
  // Telegram has no card primitive — fall back to the caller-provided text
  // body so the content arrives as a plain message rather than raw JSON.
  const isCard = c.type === 'card' && typeof c.fallbackText === 'string';

  return {
    text,
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
 * Retry-once helper: if the primary send fails with GrammyEntityError
 * (malformed entities — our mdast walker produced offsets Telegram's
 * validator rejected), retry with entities stripped and plain text.
 * Caption paths don't use this — they surface as delivery errors.
 */
const sendWithFallback = <A>(
  primary: Effect.Effect<A, GrammyDeliveryError, BotService>,
  fallbackPlainText: () => Effect.Effect<A, GrammyDeliveryError, BotService>,
): Effect.Effect<A, GrammyDeliveryError, BotService> =>
  primary.pipe(
    Effect.catchTag('GrammyEntityError', (err) =>
      Effect.logWarning('telegram-grammy: entity error, retrying as plain text', err).pipe(
        Effect.andThen(fallbackPlainText()),
      ),
    ),
  );

/** Typed sender for the default message path. */
const sendTextChunks = Effect.fn('telegram-grammy.sendTextChunks')(function* (
  chatId: number,
  messageThreadId: number | undefined,
  chunks: readonly FormattedString[],
  plain: boolean,
) {
  const { bot } = yield* BotService;
  let lastId: number | undefined;
  for (const chunk of chunks) {
    const sent = yield* Effect.tryPromise({
      try: () =>
        bot.api.sendMessage(chatId, chunk.text, {
          entities: plain ? undefined : chunk.entities,
          message_thread_id: messageThreadId,
          link_preview_options: { is_disabled: true },
        }),
      catch: (err) => mapGrammyError(err, 'sendMessage', String(chatId)),
    });
    lastId = sent.message_id;
  }
  return lastId != null ? String(lastId) : undefined;
});

/** Kind-dispatched single-file send. Extracted so each branch has a unique inferred `A`. */
const sendSingleFile = (
  bot: { api: import('grammy').Api },
  chatId: number,
  kind: MediaKind,
  input: InputFile,
  caption: FormattedString | undefined,
  messageThreadId: number | undefined,
): Effect.Effect<string, GrammyDeliveryError> => {
  const baseOpts = {
    caption: caption?.text,
    caption_entities: caption?.entities,
    message_thread_id: messageThreadId,
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
      return Effect.tryPromise({
        try: () => bot.api.sendVideo(chatId, input, { ...baseOpts, supports_streaming: true }),
        catch: (err) => mapGrammyError(err, method, String(chatId)),
      }).pipe(Effect.map((m) => mapId(m.message_id)));
    case 'audio':
      return Effect.tryPromise({
        try: () => bot.api.sendAudio(chatId, input, baseOpts),
        catch: (err) => mapGrammyError(err, method, String(chatId)),
      }).pipe(Effect.map((m) => mapId(m.message_id)));
    case 'voice':
      return Effect.tryPromise({
        try: () => bot.api.sendVoice(chatId, input, baseOpts),
        catch: (err) => mapGrammyError(err, method, String(chatId)),
      }).pipe(Effect.map((m) => mapId(m.message_id)));
    case 'animation':
      return Effect.tryPromise({
        try: () => bot.api.sendAnimation(chatId, input, baseOpts),
        catch: (err) => mapGrammyError(err, method, String(chatId)),
      }).pipe(Effect.map((m) => mapId(m.message_id)));
    case 'document':
    default:
      return Effect.tryPromise({
        try: () => bot.api.sendDocument(chatId, input, baseOpts),
        catch: (err) => mapGrammyError(err, method, String(chatId)),
      }).pipe(Effect.map((m) => mapId(m.message_id)));
  }
};

/** Send a default text+files message. Returns the first chunk's message id. */
const sendDefault = Effect.fn('telegram-grammy.sendDefault')(function* (
  chatId: number,
  threadId: string | null,
  text: string,
  files: ReadonlyArray<OutboundFile>,
) {
    const { bot } = yield* BotService;
    const messageThreadId = parseThreadId(threadId);

    if (files.length === 0) {
      if (!text) return undefined;
      const fs = renderFS(text);
      const chunks = splitForBody(fs);
      return yield* sendWithFallback(
        sendTextChunks(chatId, messageThreadId, chunks, false),
        () => sendTextChunks(chatId, messageThreadId, chunks, true),
      );
    }

    if (files.length === 1) {
      const file = files[0];
      const kind = mediaKindFromFilename(file.filename);
      const caption = text ? splitForCaption(renderFS(text))[0] : undefined;
      const input = new InputFile(file.data, file.filename);
      return yield* sendSingleFile(bot, chatId, kind, input, caption, messageThreadId);
    }

    // Multiple files → sequential sendDocument. Telegram's media group API
    // requires 2–10 items AND forbids mixing photos/videos with
    // documents/audios, so falling back to sequential docs is the most
    // permissive path for arbitrary attachment bundles. For an opinionated
    // media group callers should use the `send_media_group` operation.
    let lastId: number | undefined;
    let captionForFirst: FormattedString | undefined = text ? splitForCaption(renderFS(text))[0] : undefined;
    for (const file of files) {
      const input = new InputFile(file.data, file.filename);
      const sent = yield* Effect.tryPromise({
        try: () =>
          bot.api.sendDocument(chatId, input, {
            caption: captionForFirst?.text,
            caption_entities: captionForFirst?.entities,
            message_thread_id: messageThreadId,
          }),
        catch: (err) => mapGrammyError(err, 'sendDocument', String(chatId)),
      });
      captionForFirst = undefined;
      lastId = sent.message_id;
    }
    return lastId != null ? String(lastId) : undefined;
  });

const editMessage = Effect.fn('telegram-grammy.editMessage')(function* (
  chatId: number,
  compound: string,
  text: string,
) {
    const parsed = extractTelegramMessageId(compound, chatId);
    if (!parsed) {
      yield* Effect.logError('telegram-grammy: edit with invalid compound id', { compound });
      return undefined;
    }
    const { bot } = yield* BotService;
    const fs = renderFS(text);

    const primary: Effect.Effect<void, GrammyDeliveryError, BotService> = Effect.tryPromise({
      try: () =>
        bot.api.editMessageText(parsed.chatId, parsed.messageId, fs.text, {
          entities: fs.entities,
        }),
      catch: (err) => mapGrammyError(err, 'editMessageText', String(chatId)),
    }).pipe(Effect.asVoid);

    const fallback = (): Effect.Effect<void, GrammyDeliveryError, BotService> =>
      Effect.tryPromise({
        try: () => bot.api.editMessageText(parsed.chatId, parsed.messageId, fs.text),
        catch: (err) => mapGrammyError(err, 'editMessageText-plain', String(chatId)),
      }).pipe(Effect.asVoid);

    yield* sendWithFallback<void>(primary, fallback);
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
    const { bot } = yield* BotService;
    yield* Effect.tryPromise({
      try: () =>
        bot.api.setMessageReaction(
          parsed.chatId,
          parsed.messageId,
          emoji ? [{ type: 'emoji', emoji: emoji as never }] : [],
        ),
      catch: (err) => mapGrammyError(err, 'setMessageReaction', String(chatId)),
    });
    return undefined;
  });

const sendMediaGroup = Effect.fn('telegram-grammy.sendMediaGroup')(function* (
  chatId: number,
  threadId: string | null,
  items: ReadonlyArray<{ path: string; caption?: string }>,
  files: ReadonlyArray<OutboundFile>,
) {
    if (items.length < 2 || items.length > 10) {
      yield* Effect.logWarning('telegram-grammy: send_media_group requires 2-10 items', { count: items.length });
      return undefined;
    }
    const { bot } = yield* BotService;

    const inputs: Array<InputMediaPhoto | InputMediaVideo | InputMediaAudio | InputMediaDocument> = [];
    for (const item of items) {
      const bare = path.basename(item.path);
      const file = files.find((f) => f.filename === bare);
      if (!file) {
        yield* Effect.logWarning('telegram-grammy: send_media_group file not found', { path: item.path });
        continue;
      }
      const kind = mediaKindFromFilename(file.filename);
      const input = new InputFile(file.data, file.filename);
      const caption = item.caption ? splitForCaption(renderFS(item.caption))[0] : undefined;
      const base = { media: input, caption: caption?.text, caption_entities: caption?.entities };
      if (kind === 'video') inputs.push({ type: 'video', supports_streaming: true, ...base });
      else if (kind === 'photo') inputs.push({ type: 'photo', ...base });
      else if (kind === 'audio') inputs.push({ type: 'audio', ...base });
      else inputs.push({ type: 'document', ...base });
    }

    // Telegram forbids mixing photo/video with document/audio in a single
    // media group. If detected, fall back to sequential sends.
    const types = new Set(inputs.map((i) => i.type));
    const mixedVisual = types.has('photo') || types.has('video');
    const mixedDocs = types.has('document') || types.has('audio');
    if (mixedVisual && mixedDocs) {
      yield* Effect.logWarning('telegram-grammy: media group would mix types, falling back to sequential');
      let lastId: number | undefined;
      for (const m of inputs) {
        const sent = yield* Effect.tryPromise({
          try: () =>
            bot.api.sendDocument(chatId, m.media as InputFile, {
              message_thread_id: parseThreadId(threadId),
            }),
          catch: (err) => mapGrammyError(err, 'sendDocument-fallback', String(chatId)),
        });
        lastId = sent.message_id;
      }
      return lastId != null ? String(lastId) : undefined;
    }

    const sent = yield* Effect.tryPromise({
      try: () => bot.api.sendMediaGroup(chatId, inputs, { message_thread_id: parseThreadId(threadId) }),
      catch: (err) => mapGrammyError(err, 'sendMediaGroup', String(chatId)),
    });
    return sent.length > 0 ? String(sent[0].message_id) : undefined;
  });

const sendAskQuestion = Effect.fn('telegram-grammy.sendAskQuestion')(function* (
  chatId: number,
  threadId: string | null,
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

    const messageThreadId = parseThreadId(threadId);

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

    for (const chunk of tail) {
      yield* Effect.tryPromise({
        try: () =>
          bot.api.sendMessage(chatId, chunk.text, {
            entities: chunk.entities,
            message_thread_id: messageThreadId,
            link_preview_options: { is_disabled: true },
          }),
        catch: (err) => mapGrammyError(err, 'sendMessage-askQuestion-tail', String(chatId)),
      });
    }

    return String(headSent.message_id);
  });

/**
 * Public outbound entrypoint. Switches on content shape, runs the matching
 * sub-effect, and clears pendingSeen on the success branch so the 👀
 * reaction goes away once the bot's reply lands.
 */
export const dispatchOutbound = Effect.fn('telegram-grammy.dispatchOutbound')(function* (
  platformId: string,
  threadId: string | null,
  message: OutboundMessage,
) {
    const chatId = parseChatId(platformId);
    const view = viewContent(message);
    const reactionKey = threadId ?? platformId;
    const files = message.files ?? [];

    let result: string | undefined = undefined;

    if (view.isEdit && view.editMessageId != null) {
      result = yield* editMessage(chatId, view.editMessageId, view.text);
    } else if (view.isReaction && view.reactionMessageId != null) {
      result = yield* reactToMessage(chatId, view.reactionMessageId, view.reactionEmoji);
    } else if (view.isMediaGroup && view.mediaGroupItems) {
      result = yield* sendMediaGroup(chatId, threadId, view.mediaGroupItems, files);
    } else if (view.isAskQuestion && view.askQuestionId != null && view.askTitle != null && view.askOptions) {
      result = yield* sendAskQuestion(
        chatId,
        threadId,
        view.askQuestionId,
        view.askTitle,
        view.askQuestion ?? '',
        view.askOptions,
      );
    } else if (view.isCard && view.cardFallbackText != null) {
      result = yield* sendDefault(chatId, threadId, view.cardFallbackText, files);
    } else {
      result = yield* sendDefault(chatId, threadId, view.text, files);
    }

    yield* clearPendingSeen(chatId, reactionKey);
    return result;
  });

// Test-only re-exports so the smoke test can mount a mock BotService and
// exercise sendWithFallback directly. Keeps the test surface narrow.
export const _sendWithFallbackForTest = sendWithFallback;
export const _sendTextChunksForTest = sendTextChunks;
