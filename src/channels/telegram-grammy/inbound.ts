/**
 * grammY Context → NanoClaw InboundMessage.
 *
 * Pure conversion. Produces the same content shape chat-sdk-bridge.ts
 * emits — flat `senderId/sender/senderName` plus nested `author` for
 * legacy readers (telegram-pairing.ts reads `author.userId`). The router
 * (src/router.ts) only reads `text`, `sender`, `senderId`.
 *
 * isMention is platform-confirmed here (not regex-matched later) so the
 * router never has to guess whether the bot was addressed — the presence
 * of a `mention`/`text_mention` entity or a reply_to_message pointing at
 * the bot is authoritative, and DMs are by definition addressed.
 */
import type { Context } from 'grammy';
import type { Message, MessageEntity, MessageOrigin, User } from 'grammy/types';

import type { InboundMessage } from '../adapter.js';

/** Compose the platform id the router expects for a Telegram chat. */
export const platformIdFor = (chatId: number): string => `telegram:${chatId}`;

/**
 * Encode a thread id for forum topics. Returns null for plain chats/DMs —
 * the adapter declares supportsThreads: false so the router will strip it
 * anyway, but keeping the encode symmetric with the legacy adapter avoids
 * surprises when topics are later promoted to first-class.
 */
export const threadIdFor = (chatId: number, msg: Message): string | null =>
  msg.is_topic_message && typeof msg.message_thread_id === 'number'
    ? `telegram:${chatId}:${msg.message_thread_id}`
    : null;

/** Compound id encoding so outbound `edit`/`reaction` can decode back to (chatId, msgId). */
export const compoundMessageId = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

function fullName(user: User | undefined): string | null {
  if (!user) return null;
  const first = user.first_name ?? '';
  const last = user.last_name ?? '';
  const combined = `${first}${last ? ` ${last}` : ''}`.trim();
  return combined || user.username || null;
}

function displayName(user: User | undefined): string | null {
  if (!user) return null;
  return fullName(user) ?? user.username ?? null;
}

/** Platform-confirmed bot-mention signal. */
export function detectMention(ctx: Context, botUsername: string | null, botUserId: number | null): boolean {
  const chat = ctx.chat;
  const msg = ctx.msg;
  if (!chat || !msg) return false;

  // DMs are by definition addressed to the bot.
  if (chat.type === 'private') return true;

  // Reply to one of the bot's own messages counts as a mention.
  const replyFromId = msg.reply_to_message?.from?.id;
  if (botUserId != null && replyFromId === botUserId) return true;

  const entities: MessageEntity[] = msg.entities ?? msg.caption_entities ?? [];
  const source = msg.text ?? msg.caption ?? '';

  for (const entity of entities) {
    if (entity.type === 'mention' && botUsername) {
      const slice = source.slice(entity.offset, entity.offset + entity.length);
      if (slice.toLowerCase() === `@${botUsername.toLowerCase()}`) return true;
    }
    if (entity.type === 'text_mention' && botUserId != null && entity.user?.id === botUserId) {
      return true;
    }
  }
  return false;
}

/**
 * Reply context surfaced to the agent. The agent-runner formatter renders
 * `reply_to="<id>"` on the parent `<message>` plus `<quoted_message from="...">text</quoted_message>`
 * inline, so `id` is what lets the agent disambiguate between identical-
 * looking messages, and `text` is the context body.
 *
 * Three reply shapes are merged into this one envelope:
 *   - plain `msg.reply_to_message` — normal "tap reply".
 *   - `msg.quote` — iOS/Desktop quote-reply where the user highlights a
 *     specific fragment; we prefer the fragment over the whole message so
 *     the agent sees what was actually referenced.
 *   - `msg.external_reply` — reply to a message from a *different* chat
 *     (quote-reply of a channel post etc.). No local id; we label the
 *     sender with the origin so the agent knows the quoted content is
 *     external.
 */
export interface ReplyContext {
  id: string | null;
  text: string;
  sender: string;
}

/**
 * Render a MessageOrigin (from forward / external_reply) into a compact
 * human-readable label. Prefers `@username` when available because that's
 * the stable public handle; falls back to display name.
 */
function describeOrigin(origin: MessageOrigin): string {
  switch (origin.type) {
    case 'user': {
      const u = origin.sender_user;
      const name = `${u.first_name}${u.last_name ? ` ${u.last_name}` : ''}`.trim() || (u.username ?? 'user');
      return u.username ? `${name} (@${u.username})` : name;
    }
    case 'hidden_user':
      return `${origin.sender_user_name} (hidden profile)`;
    case 'chat': {
      const c = origin.sender_chat;
      const title = (c as { title?: string }).title ?? (c as { username?: string }).username ?? `chat:${c.id}`;
      const sig = origin.author_signature ? ` (signed: ${origin.author_signature})` : '';
      return `"${title}"${sig}`;
    }
    case 'channel': {
      const c = origin.chat;
      const title = (c as { title?: string }).title ?? `channel:${c.id}`;
      const handle = (c as { username?: string }).username;
      const msgId = origin.message_id;
      const sig = origin.author_signature ? `, signed: ${origin.author_signature}` : '';
      return handle
        ? `${title} channel (@${handle}, msg ${msgId}${sig})`
        : `${title} channel (msg ${msgId}${sig})`;
    }
  }
}

/**
 * Format a forward header that we prepend to the message body. The date
 * is the *original* send date from the forward origin, not the forward
 * action's date — that's what lets the agent reason about recency of the
 * forwarded content.
 */
function formatForwardHeader(origin: MessageOrigin): string {
  const origDate = new Date(origin.date * 1000).toISOString().replace('T', ' ').slice(0, 16);
  return `[forwarded from ${describeOrigin(origin)}, ${origDate} UTC]`;
}

export function extractReplyContext(msg: Message): ReplyContext | null {
  // Case C — reply to a message from a different chat (quote-reply of a
  // channel post, etc.). Telegram delivers this as `external_reply` with
  // an origin describing where the quoted message lived. No local id.
  const ext = (msg as { external_reply?: { origin: MessageOrigin; message_id?: number } }).external_reply;
  if (ext) {
    const quoteText = (msg as { quote?: { text: string } }).quote?.text;
    const body = quoteText && quoteText.length > 0
      ? quoteText
      : ((ext as { text?: string }).text ?? '');
    return {
      id: null,
      sender: `(external) ${describeOrigin(ext.origin)}`,
      text: body,
    };
  }

  const reply = msg.reply_to_message;
  if (!reply) return null;

  // Case B — user highlighted a specific fragment and replied to that
  // portion. Prefer the fragment so the agent sees exactly what was
  // referenced rather than the whole message.
  const quote = (msg as { quote?: { text: string; is_manual?: boolean } }).quote;
  const fullText = reply.text ?? reply.caption ?? '';
  const text = quote?.text && quote.text.length > 0 ? quote.text : fullText;

  return {
    id: String(reply.message_id),
    text,
    sender: reply.from?.first_name ?? reply.from?.username ?? 'Unknown',
  };
}

/**
 * Inbound attachment descriptor handed to attachments.ts for download.
 * Matches the legacy Telegram adapter's content shape so the container
 * agent-runner (which only knows about this shape) doesn't need any
 * changes to read files produced here.
 */
export interface InboundAttachment {
  type:
    | 'photo'
    | 'voice'
    | 'audio'
    | 'video'
    | 'video_note'
    | 'document'
    | 'sticker'
    | 'animation'
    | 'contact'
    | 'location';
  /** File id for downloadable types; empty string for contact / location. */
  fileId: string;
  name: string | null;
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /** Populated by attachments.ts after successful download, consumed by the agent-runner. */
  localPath?: string;
  transcript?: string;
}

/**
 * Extract attachment descriptors from a Telegram Message. The grammY types
 * expose every attachment kind as an optional top-level field, so we
 * iterate in a fixed order and pick whichever is set. At most one
 * attachment per message is possible in Telegram's protocol.
 */
export function extractAttachments(msg: Message): InboundAttachment[] {
  const out: InboundAttachment[] = [];

  if (msg.photo && msg.photo.length > 0) {
    // Telegram sends an array of sizes; pick the largest.
    const largest = [...msg.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
    out.push({
      type: 'photo',
      fileId: largest.file_id,
      name: null,
      mimeType: 'image/jpeg',
      size: largest.file_size ?? null,
      width: largest.width,
      height: largest.height,
      durationSeconds: null,
    });
  }

  if (msg.voice) {
    out.push({
      type: 'voice',
      fileId: msg.voice.file_id,
      name: null,
      mimeType: msg.voice.mime_type ?? 'audio/ogg',
      size: msg.voice.file_size ?? null,
      width: null,
      height: null,
      durationSeconds: msg.voice.duration,
    });
  }

  if (msg.audio) {
    out.push({
      type: 'audio',
      fileId: msg.audio.file_id,
      name: msg.audio.file_name ?? null,
      mimeType: msg.audio.mime_type ?? null,
      size: msg.audio.file_size ?? null,
      width: null,
      height: null,
      durationSeconds: msg.audio.duration,
    });
  }

  if (msg.video) {
    out.push({
      type: 'video',
      fileId: msg.video.file_id,
      name: msg.video.file_name ?? null,
      mimeType: msg.video.mime_type ?? null,
      size: msg.video.file_size ?? null,
      width: msg.video.width,
      height: msg.video.height,
      durationSeconds: msg.video.duration,
    });
  }

  if (msg.video_note) {
    out.push({
      type: 'video_note',
      fileId: msg.video_note.file_id,
      name: null,
      mimeType: null,
      size: msg.video_note.file_size ?? null,
      width: msg.video_note.length,
      height: msg.video_note.length,
      durationSeconds: msg.video_note.duration,
    });
  }

  if (msg.animation) {
    out.push({
      type: 'animation',
      fileId: msg.animation.file_id,
      name: msg.animation.file_name ?? null,
      mimeType: msg.animation.mime_type ?? null,
      size: msg.animation.file_size ?? null,
      width: msg.animation.width,
      height: msg.animation.height,
      durationSeconds: msg.animation.duration,
    });
  }

  if (msg.sticker) {
    // Encode set_name + emoji alt into `name` so the agent-runner's
    // generic formatAttachments renders `[sticker: 🤦 Picard (from StarTrekPack)]`
    // without needing any changes on the container side.
    const setName = msg.sticker.set_name ?? null;
    const emoji = msg.sticker.emoji ?? null;
    const label =
      emoji && setName ? `${emoji} sticker (from ${setName})`
      : emoji ? `${emoji} sticker`
      : setName ? `sticker (from ${setName})`
      : null;
    out.push({
      type: 'sticker',
      fileId: msg.sticker.file_id,
      name: label,
      mimeType: null,
      size: msg.sticker.file_size ?? null,
      width: msg.sticker.width,
      height: msg.sticker.height,
      durationSeconds: null,
    });
  }

  if (msg.contact) {
    const c = msg.contact;
    const display = `${c.first_name}${c.last_name ? ` ${c.last_name}` : ''} (${c.phone_number})`;
    out.push({
      type: 'contact',
      fileId: '',
      name: display,
      mimeType: null,
      size: null,
      width: null,
      height: null,
      durationSeconds: null,
    });
  }

  if (msg.location) {
    const { latitude, longitude } = msg.location;
    out.push({
      type: 'location',
      fileId: '',
      name: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
      mimeType: null,
      size: null,
      width: null,
      height: null,
      durationSeconds: null,
    });
  }

  // Document goes last — Telegram sends it alongside photo/video/audio as a
  // generic fallback, but for plain files it's the only field set.
  if (msg.document && out.length === 0) {
    out.push({
      type: 'document',
      fileId: msg.document.file_id,
      name: msg.document.file_name ?? null,
      mimeType: msg.document.mime_type ?? null,
      size: msg.document.file_size ?? null,
      width: null,
      height: null,
      durationSeconds: null,
    });
  }

  return out;
}

export interface InboundContent {
  text: string;
  sender: string | null;
  senderId: string;
  senderName: string | null;
  author: {
    userId: string;
    fullName: string | null;
    userName: string | null;
  };
  attachments: InboundAttachment[];
  replyTo?: ReplyContext;
}

export interface InboundEnvelope {
  platformId: string;
  threadId: string | null;
  message: InboundMessage;
}

/**
 * Serialize Telegram's `entities[]` back into markdown-ish text so the
 * inbound body preserves formatting. Telegram delivers `text: "hello"` +
 * `entities: [{type:'bold',offset:0,length:5}]` — we turn that into
 * `**hello**` so the agent sees formatting the same way it emits it.
 *
 * Entities can overlap (e.g. bold + italic on same range). We handle that
 * by building a list of (offset, kind, open/close, url?) markers, sorting
 * stably, and splicing them into the text.
 *
 * Unknown or non-renderable entity types (mention, url, bot_command,
 * hashtag, phone_number, cashtag, custom_emoji, email) are skipped — the
 * text already reads correctly without them.
 */
const ENTITY_WRAP: Record<string, [string, string] | undefined> = {
  bold: ['**', '**'],
  italic: ['_', '_'],
  strikethrough: ['~~', '~~'],
  underline: ['__', '__'],
  spoiler: ['||', '||'],
  code: ['`', '`'],
  pre: ['```\n', '\n```'],
};

export function entitiesToMarkdown(text: string, entities: readonly MessageEntity[] | undefined): string {
  if (!text) return text;
  if (!entities || entities.length === 0) return text;
  type Marker = { pos: number; insert: string; tie: number };
  const markers: Marker[] = [];
  // Tie encoding: close=0, open=1 so at the same position we emit the
  // close marker first. That prevents `**a**_b_` (bold ending at 1, italic
  // starting at 1) from interleaving into `**a_**b_`.
  for (const e of entities) {
    const end = e.offset + e.length;
    if (e.type === 'text_link') {
      const url = (e as { url: string }).url;
      markers.push({ pos: e.offset, insert: '[', tie: 1 });
      markers.push({ pos: end, insert: `](${url})`, tie: 0 });
      continue;
    }
    if (e.type === 'pre') {
      const lang = (e as { language?: string }).language;
      markers.push({ pos: e.offset, insert: lang ? `\`\`\`${lang}\n` : '```\n', tie: 1 });
      markers.push({ pos: end, insert: '\n```', tie: 0 });
      continue;
    }
    const wrap = ENTITY_WRAP[e.type];
    if (!wrap) continue;
    markers.push({ pos: e.offset, insert: wrap[0], tie: 1 });
    markers.push({ pos: end, insert: wrap[1], tie: 0 });
  }
  markers.sort((a, b) => (a.pos - b.pos) || (a.tie - b.tie));

  const chars = Array.from(text); // JS string indexing is UTF-16 — entity offsets are UTF-16 code units, so string indexing is fine
  let out = '';
  let cursor = 0;
  for (const m of markers) {
    if (m.pos > cursor) out += text.slice(cursor, m.pos);
    out += m.insert;
    cursor = m.pos;
  }
  if (cursor < text.length) out += text.slice(cursor);
  // Defensive: chars is unused but keeps the tsc happy about unused vars on
  // older targets — guarantees `text` is valid string. Drop if desired.
  void chars;
  return out;
}

/**
 * Build the router-facing envelope.
 *
 * `isMention` must be set here — the router prefers the platform signal
 * over name-matching the text (see adapter.ts's note on agent_group_name
 * vs bot username). DMs are mentions; group messages are mentions only
 * when the bot is addressed explicitly (@username, text_mention, or
 * reply_to_message pointing at the bot).
 *
 * Detects edited messages via `ctx.update.edited_message` and synthesizes
 * a distinct message id (original id + `:edit:<editDate>`) so the INSERT
 * into messages_in doesn't collide with the original's primary key. The
 * body is prefixed with `[EDITED]` and `replyTo.id` links to the original.
 */
export function toInboundMessage(ctx: Context, botUsername: string | null, botUserId: number | null): InboundEnvelope | null {
  const chat = ctx.chat;
  const msg = ctx.msg;
  const from = ctx.from;
  if (!chat || !msg || !from) return null;

  const senderIdBare = String(from.id);
  const senderIdNs = `telegram:${senderIdBare}`;
  const name = displayName(from);

  const isEdit = Boolean((ctx.update as { edited_message?: unknown }).edited_message);
  const editDate = (msg as { edit_date?: number }).edit_date;

  // Prefer entities over caption_entities when both exist (message text vs media caption).
  const rawText = msg.text ?? msg.caption ?? '';
  const rawEntities = msg.entities ?? msg.caption_entities;
  const markdown = entitiesToMarkdown(rawText, rawEntities);

  // Prepend contextual prefixes: [EDITED], [forwarded from …], [album …].
  const prefixes: string[] = [];
  if (isEdit) prefixes.push('[EDITED]');
  const fwd = (msg as { forward_origin?: MessageOrigin }).forward_origin;
  if (fwd) prefixes.push(formatForwardHeader(fwd));
  const albumId = (msg as { media_group_id?: string }).media_group_id;
  if (albumId) prefixes.push(`[album ${albumId}]`);
  const body = prefixes.length > 0
    ? (markdown.length > 0 ? `${prefixes.join(' ')}\n\n${markdown}` : prefixes.join(' '))
    : markdown;

  const content: InboundContent = {
    text: body,
    sender: name,
    senderId: senderIdNs,
    senderName: name,
    author: {
      userId: senderIdNs,
      fullName: fullName(from),
      userName: from.username ?? null,
    },
    attachments: extractAttachments(msg),
  };

  let replyTo = extractReplyContext(msg);
  if (isEdit && !replyTo) {
    // Link the [EDITED] inbound back to the original message id so the
    // agent-runner renders `reply_to="<origId>"` on the envelope and the
    // agent can walk back to the pre-edit body in its own history.
    replyTo = { id: String(msg.message_id), text: '', sender: 'original' };
  }
  if (replyTo) content.replyTo = replyTo;

  // Edited messages must not collide with the original's primary key.
  const messageId = isEdit && typeof editDate === 'number'
    ? `${chat.id}:${msg.message_id}:edit:${editDate}`
    : compoundMessageId(chat.id, msg.message_id);

  return {
    platformId: platformIdFor(chat.id),
    threadId: threadIdFor(chat.id, msg),
    message: {
      id: messageId,
      kind: 'chat-sdk',
      content,
      timestamp: new Date(msg.date * 1000).toISOString(),
      isMention: detectMention(ctx, botUsername, botUserId),
    },
  };
}

/**
 * Build an inbound envelope for a `message_reaction` Update. Telegram emits
 * this separately from `message` Updates with no Message body — just chat,
 * message_id, user, old_reaction[], new_reaction[]. We synthesize a
 * chat-sdk inbound whose `text` captures the emoji delta and whose
 * `replyTo.id` links to the target message so the agent knows what the
 * reaction is on.
 *
 * Type gymnastics: grammy's `MessageReactionUpdated` type isn't in the
 * base Message union, so we accept a loose shape.
 */
export interface ReactionUpdatePayload {
  chat: { id: number; type: string; title?: string };
  message_id: number;
  user?: User;
  actor_chat?: { id: number; type: string; title?: string };
  date: number;
  old_reaction: ReadonlyArray<{ type: string; emoji?: string; custom_emoji_id?: string }>;
  new_reaction: ReadonlyArray<{ type: string; emoji?: string; custom_emoji_id?: string }>;
}

function describeReactions(rs: ReadonlyArray<{ type: string; emoji?: string; custom_emoji_id?: string }>): string {
  if (rs.length === 0) return '(cleared)';
  return rs
    .map((r) => (r.type === 'emoji' && r.emoji ? r.emoji : r.type === 'custom_emoji' ? `<custom:${r.custom_emoji_id}>` : r.type))
    .join(' ');
}

export function toReactionInbound(upd: ReactionUpdatePayload): InboundEnvelope | null {
  const { chat, message_id, user, new_reaction, old_reaction, date } = upd;
  const actor = user ?? (upd.actor_chat ? { id: upd.actor_chat.id, first_name: upd.actor_chat.title ?? 'chat', username: undefined, is_bot: false } as User : null);
  if (!actor) return null;

  const senderIdNs = `telegram:${actor.id}`;
  const name = displayName(actor) ?? 'anonymous';

  const verb = new_reaction.length === 0 ? 'removed reaction' : old_reaction.length === 0 ? 'reacted' : 'changed reaction';
  const summary = new_reaction.length === 0
    ? `${verb} (was ${describeReactions(old_reaction)})`
    : `${verb}: ${describeReactions(new_reaction)}`;

  const content: InboundContent = {
    text: `[${summary}]`,
    sender: name,
    senderId: senderIdNs,
    senderName: name,
    author: {
      userId: senderIdNs,
      fullName: fullName(actor),
      userName: actor.username ?? null,
    },
    attachments: [],
    replyTo: { id: String(message_id), text: '', sender: 'target' },
  };

  return {
    platformId: platformIdFor(chat.id),
    threadId: null,
    message: {
      id: `${chat.id}:${message_id}:reaction:${actor.id}:${date}`,
      kind: 'chat-sdk',
      content,
      timestamp: new Date(date * 1000).toISOString(),
      // Reactions on bot's own messages are always addressed to the bot.
      isMention: true,
    },
  };
}

/** chatId parser for outbound routing (`telegram:<chatId>` → number). */
export function parseChatId(platformId: string): number {
  const tail = platformId.split(':').slice(1).join(':');
  const n = Number(tail);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid telegram platformId: ${platformId}`);
  }
  return n;
}

/** threadId → numeric forum topic id (falls back to undefined). */
export function parseThreadId(threadId: string | null): number | undefined {
  if (!threadId) return undefined;
  const tail = threadId.split(':').pop() ?? '';
  const n = Number(tail);
  return Number.isFinite(n) && String(n) === tail ? n : undefined;
}

/**
 * Decode a stored message id back to `(chatId, messageId)` so outbound
 * `edit` / `reaction` ops can hit Telegram's Bot API.
 *
 * The agent-runner's `getMessageIdBySeq` returns three shapes:
 *   - bare numeric       (e.g. "1710")   — delivered outbound message id
 *   - 2-part `a:b`       (e.g. "95307956:1716")   — legacy inbound compound
 *   - 3-part `a:b:ag-…`  — current inbound, id wrapped by `messageIdForAgent`
 *
 * The chat id for the API call comes from the routing `platform_id`, so the
 * bare form is fine — `fallbackChatId` fills in when the compound omits it.
 */
export function extractTelegramMessageId(
  compound: string,
  fallbackChatId: number,
): { chatId: number; messageId: number } | null {
  const parts = compound.split(':');
  if (parts.length === 1) {
    const messageId = Number(parts[0]);
    return Number.isFinite(messageId) && String(messageId) === parts[0]
      ? { chatId: fallbackChatId, messageId }
      : null;
  }
  const chatId = Number(parts[0]);
  const messageId = Number(parts[1]);
  if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return null;
  if (String(chatId) !== parts[0] || String(messageId) !== parts[1]) return null;
  return { chatId, messageId };
}
