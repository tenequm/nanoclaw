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
import { renderFS, splitCaption, splitForBody } from './formatter.js';
import { extractTelegramMessageId, parseChatId, parseTopicId, resolveMessageThreadId } from './inbound.js';
import { rememberTopicMessage } from './topic-map.js';
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
  reply: ReplyParameters | undefined,
) {
  const { bot } = yield* BotService;
  let lastId: number | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const sent = yield* sendReplying(index, reply, (replyParameters) =>
      Effect.tryPromise({
        try: () =>
          bot.api.sendMessage(chatId, chunk.text, {
            entities: plain ? undefined : chunk.entities,
            message_thread_id: messageThreadId,
            link_preview_options: { is_disabled: true },
            reply_parameters: replyParameters,
          }),
        catch: (err) => mapGrammyError(err, 'sendMessage', String(chatId)),
      }),
    );
    lastId = sent.message_id;
  }
  return lastId != null ? String(lastId) : undefined;
});

/**
 * Text that did not fit where it was meant to go (a caption's overflow, the
 * tail of a long edit), sent as plain follow-up messages so nothing is lost.
 */
const sendFollowUp = (
  chatId: number,
  messageThreadId: number | undefined,
  chunks: readonly FormattedString[],
): Effect.Effect<void, GrammyDeliveryError, BotService> =>
  chunks.length === 0
    ? Effect.void
    : sendWithFallback(sendTextChunks(chatId, messageThreadId, chunks, false, undefined), () =>
        sendTextChunks(chatId, messageThreadId, chunks, true, undefined),
      ).pipe(Effect.asVoid);

/**
 * What the bot sent as (chatId, messageId), for edits: a media message takes
 * `editMessageCaption`. Bounded FIFO, wiped by a host restart; an edit of an
 * unremembered media message still lands through the "no text" retry.
 */
const MAX_SENT_KINDS = 4096;
type SentKind = 'media';
const sentKinds = new Map<string, SentKind>();

function rememberSentKind(chatId: number, messageId: string | number | undefined, kind: SentKind): void {
  if (messageId === undefined) return;
  const key = `${chatId}:${messageId}`;
  sentKinds.delete(key);
  sentKinds.set(key, kind);
  if (sentKinds.size > MAX_SENT_KINDS) {
    const oldest = sentKinds.keys().next().value;
    if (oldest !== undefined) sentKinds.delete(oldest);
  }
}

function sentKindOf(chatId: number, messageId: number): SentKind | undefined {
  return sentKinds.get(`${chatId}:${messageId}`);
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
 * Send a default text+files message. Returns the first chunk's message id, or
 * for files the (last) file's id. Text longer than a caption follows the
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
    const fs = renderFS(text);
    const chunks = splitForBody(fs);
    return yield* sendWithFallback(sendTextChunks(chatId, messageThreadId, chunks, false, reply), () =>
      sendTextChunks(chatId, messageThreadId, chunks, true, reply),
    );
  }

  const { caption, rest } = text ? splitCaption(renderFS(text)) : { caption: undefined, rest: [] };

  if (files.length === 1) {
    const file = files[0];
    const kind = mediaKindFromFilename(file.filename);
    const sentId = yield* sendReplying(0, reply, (replyParameters) =>
      sendSingleFile(bot, chatId, kind, file, caption, messageThreadId, replyParameters),
    );
    rememberSentKind(chatId, sentId, 'media');
    yield* sendFollowUp(chatId, messageThreadId, rest);
    return sentId;
  }

  // Multiple files → sequential sendDocument. Telegram's media group API
  // requires 2–10 items AND forbids mixing photos/videos with
  // documents/audios, so falling back to sequential docs is the most
  // permissive path for arbitrary attachment bundles. For an opinionated
  // media group callers should use the `send_media_group` operation.
  let lastId: number | undefined;
  for (const [index, file] of files.entries()) {
    const input = new InputFile(file.data, file.filename);
    const captionHere = index === 0 ? caption : undefined;
    const sent = yield* sendReplying(index, reply, (replyParameters) =>
      Effect.tryPromise({
        try: () =>
          bot.api.sendDocument(chatId, input, {
            caption: captionHere?.text,
            caption_entities: captionHere?.entities,
            message_thread_id: messageThreadId,
            reply_parameters: replyParameters,
          }),
        catch: (err) => mapGrammyError(err, 'sendDocument', String(chatId)),
      }),
    );
    rememberSentKind(chatId, sent.message_id, 'media');
    lastId = sent.message_id;
  }
  yield* sendFollowUp(chatId, messageThreadId, rest);
  return lastId != null ? String(lastId) : undefined;
});

/** Telegram's answer to `editMessageText` on a message that has a caption instead of text. */
const NO_TEXT_TO_EDIT_RE = /no text in the message/i;

/** Edit a text message's body; returns the chunks that did not fit. */
const editTextBody = (
  chatId: number,
  messageId: number,
  fs: FormattedString,
): Effect.Effect<FormattedString[], GrammyDeliveryError, BotService> =>
  Effect.gen(function* () {
    const { bot } = yield* BotService;
    const [head, ...rest] = splitForBody(fs);
    if (!head) return [];
    const edit = (plain: boolean) =>
      Effect.tryPromise({
        try: () => bot.api.editMessageText(chatId, messageId, head.text, plain ? {} : { entities: head.entities }),
        catch: (err) => mapGrammyError(err, plain ? 'editMessageText-plain' : 'editMessageText', String(chatId)),
      }).pipe(Effect.asVoid);
    yield* sendWithFallback<void>(edit(false), () => edit(true));
    return rest;
  });

/** Edit a media message's caption; returns the chunks that did not fit. */
const editCaptionBody = (
  chatId: number,
  messageId: number,
  fs: FormattedString,
): Effect.Effect<FormattedString[], GrammyDeliveryError, BotService> =>
  Effect.gen(function* () {
    const { bot } = yield* BotService;
    const { caption, rest } = splitCaption(fs);
    const edit = (plain: boolean) =>
      Effect.tryPromise({
        try: () =>
          bot.api.editMessageCaption(chatId, messageId, {
            caption: caption?.text ?? '',
            ...(plain ? {} : { caption_entities: caption?.entities }),
          }),
        catch: (err) => mapGrammyError(err, plain ? 'editMessageCaption-plain' : 'editMessageCaption', String(chatId)),
      }).pipe(Effect.asVoid);
    yield* sendWithFallback<void>(edit(false), () => edit(true));
    return rest;
  });

/**
 * Edit a message the bot sent. A media message gets its caption edited (known
 * from what was sent, or learned from Telegram's "no text" answer). Text
 * beyond the message's limit is sent right after as new messages.
 */
const editMessage = Effect.fn('telegram-grammy.editMessage')(function* (
  chatId: number,
  messageThreadId: number | undefined,
  compound: string,
  text: string,
) {
  const parsed = extractTelegramMessageId(compound, chatId);
  if (!parsed) {
    yield* Effect.logError('telegram-grammy: edit with invalid compound id', { compound });
    return undefined;
  }
  const fs = renderFS(text);
  const rest =
    sentKindOf(parsed.chatId, parsed.messageId) === 'media'
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

/**
 * Send 2-10 files as an album. Each item keeps its own caption, and caption
 * text beyond Telegram's limit follows as messages. A `.gif` cannot sit in a
 * Telegram album, so it goes out as its own animation after the album. An
 * album that would mix photos/videos with documents/audio (Telegram forbids
 * it) falls back to sequential documents, each still captioned.
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
  const album: Array<{ file: OutboundFile; input: AlbumInput }> = [];
  const animations: Array<{ file: OutboundFile; caption: FormattedString | undefined }> = [];
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
    if (kind === 'animation') {
      animations.push({ file, caption });
      continue;
    }
    const base = {
      media: new InputFile(file.data, file.filename),
      caption: caption?.text,
      caption_entities: caption?.entities,
    };
    if (kind === 'video') {
      const meta = yield* Effect.promise(() => probeMediaMeta(file.data));
      album.push({ file, input: { type: 'video', supports_streaming: true, ...base, ...(meta ?? {}) } });
    } else if (kind === 'photo') album.push({ file, input: { type: 'photo', ...base } });
    else if (kind === 'audio') album.push({ file, input: { type: 'audio', ...base } });
    else album.push({ file, input: { type: 'document', ...base } });
  }

  let sends = 0;
  let firstId: string | undefined;
  const record = (id: string | number | undefined): void => {
    if (id === undefined) return;
    rememberSentKind(chatId, id, 'media');
    firstId ??= String(id);
  };

  const types = new Set(album.map((a) => a.input.type));
  const mixed = (types.has('photo') || types.has('video')) && (types.has('document') || types.has('audio'));
  if (album.length === 1) {
    const [{ file, input }] = album;
    const caption =
      input.caption !== undefined ? new FormattedString(input.caption, input.caption_entities ?? []) : undefined;
    record(
      yield* sendReplying(sends++, reply, (replyParameters) =>
        sendSingleFile(
          bot,
          chatId,
          mediaKindFromFilename(file.filename),
          file,
          caption,
          messageThreadId,
          replyParameters,
        ),
      ),
    );
  } else if (album.length > 1 && mixed) {
    yield* Effect.logWarning('telegram-grammy: media group would mix types, falling back to sequential');
    for (const { input } of album) {
      const sent = yield* sendReplying(sends++, reply, (replyParameters) =>
        Effect.tryPromise({
          try: () =>
            bot.api.sendDocument(chatId, input.media as InputFile, {
              caption: input.caption,
              caption_entities: input.caption_entities,
              message_thread_id: messageThreadId,
              reply_parameters: replyParameters,
            }),
          catch: (err) => mapGrammyError(err, 'sendDocument-fallback', String(chatId)),
        }),
      );
      record(sent.message_id);
    }
  } else if (album.length > 1) {
    const sent = yield* sendReplying(sends++, reply, (replyParameters) =>
      Effect.tryPromise({
        // grammY 1.46 types each media-group family apart; the mixed-type check above narrows only at runtime.
        try: () =>
          bot.api.sendMediaGroup(chatId, album.map((a) => a.input) as Parameters<typeof bot.api.sendMediaGroup>[1], {
            message_thread_id: messageThreadId,
            reply_parameters: replyParameters,
          }),
        catch: (err) => mapGrammyError(err, 'sendMediaGroup', String(chatId)),
      }),
    );
    for (const m of sent) record(m.message_id);
  }

  for (const { file, caption } of animations) {
    record(
      yield* sendReplying(sends++, reply, (replyParameters) =>
        sendSingleFile(bot, chatId, 'animation', file, caption, messageThreadId, replyParameters),
      ),
    );
  }

  yield* sendFollowUp(chatId, messageThreadId, overflow);
  return firstId;
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
    result = yield* editMessage(chatId, messageThreadId, view.editMessageId, view.text);
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
