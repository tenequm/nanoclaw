/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with:
 *   1. A pairing interceptor wrapped around onInbound (see telegram-pairing.ts).
 *   2. A feature interceptor that materializes attachment bytes to the group
 *      folder, fires a 👀 reaction on seen, and transcribes voice notes via
 *      Whisper so the agent sees the transcript inline.
 *   3. A wrapped deliver() that routes single-file videos through sendVideo
 *      with supports_streaming:true, handles send_media_group, and clears
 *      the 👀 seen-reaction once the bot replies.
 *
 * Reactions go through the adapter's own addReaction/removeReaction so the
 * compound "chatId:messageId" format is decoded correctly. sendMediaGroup
 * and sendVideo still use raw fetch against api.telegram.org to avoid a
 * second grammy/Bot dependency alongside @chat-adapter/telegram.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { resolveGroupFolderForPlatformId, resolveGroupFolderPath } from '../group-folder.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { transcribeAudio } from '../transcription.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { renderTelegramHtmlChunks } from './telegram-render.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

function chatIdFromPlatformId(platformId: string): string {
  return platformId.split(':').slice(1).join(':');
}

/**
 * Telegram's absolute limit is 4096 chars; the adapter truncates at that
 * ceiling with an ellipsis appended. We split our own text well under it so
 * the ellipsis never triggers and mid-word cuts are unlikely.
 */
const TELEGRAM_SAFE_LIMIT = 3800;

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = chatIdFromPlatformId(platformId);
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Pairing success! I'm spinning up the agent now, you'll get a message from them shortly.",
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      hostOnInbound(platformId, threadId, message);
    }
  };
}

// --- Feature interceptor (👀 reaction + attachment materialization + voice transcription) ---

const VOICE_EXTS = new Set(['.ogg', '.oga', '.m4a', '.mp3', '.wav', '.webm']);
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);

const SEEN_EMOJI = '👀';

function sanitizeAttachmentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
}

interface InboundAttachment {
  type?: string;
  name?: string;
  mimeType?: string;
  data?: string; // base64
  localPath?: string;
  transcript?: string;
}

async function materializeAttachment(
  att: InboundAttachment,
  folder: string,
  msgId: string,
  index: number,
): Promise<void> {
  if (!att.data) return;
  const groupDir = resolveGroupFolderPath(folder);
  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  const baseName = att.name ? sanitizeAttachmentName(att.name) : `${att.type ?? 'file'}_${msgId}_${index}`;
  const hasExt = !!path.extname(baseName);
  const mimeExt = !hasExt && att.mimeType ? mimeToExt(att.mimeType) : '';
  const finalName = hasExt ? baseName : `${baseName}${mimeExt}`;
  const destPath = path.join(attachDir, finalName);

  try {
    const buf = Buffer.from(att.data, 'base64');
    fs.writeFileSync(destPath, buf);
    att.localPath = `agent/attachments/${finalName}`;

    const ext = path.extname(finalName).toLowerCase();
    if (att.type === 'voice' || att.type === 'audio' || VOICE_EXTS.has(ext)) {
      const transcript = await transcribeAudio(destPath);
      if (transcript) att.transcript = transcript;
    }

    // Free the base64 payload now that bytes are persisted.
    delete att.data;
  } catch (err) {
    log.warn('Failed to materialize Telegram attachment', { folder, name: finalName, err });
  }
}

function mimeToExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('mpeg') && m.startsWith('audio/')) return '.mp3';
  if (m.includes('mp4') && m.startsWith('video/')) return '.mp4';
  if (m.includes('webm')) return '.webm';
  if (m.includes('jpeg')) return '.jpg';
  if (m.includes('png')) return '.png';
  if (m.includes('gif')) return '.gif';
  if (m.includes('webp')) return '.webp';
  return '';
}

/**
 * Track which Telegram messages we've reacted 👀 to so we can clear the
 * reaction once the bot replies. Keyed by threadId (same encoded string the
 * adapter expects for add/removeReaction) so forum topics stay isolated —
 * a reply in topic-B won't clear a 👀 left in topic-A.
 *
 * In-memory only. Host crash between add and clear means the 👀 sticks; a
 * recovery sweep would cost more than it saves for a cosmetic indicator.
 */
type ReactionAdapter = {
  addReaction(threadId: string, messageId: string, emoji: string): Promise<unknown>;
  removeReaction(threadId: string, messageId: string, emoji: string): Promise<unknown>;
};

function createFeatureInterceptor(
  next: ChannelSetup['onInbound'],
  adapter: ReactionAdapter,
  pendingSeen: Map<string, Set<string>>,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      // Fire 👀 seen-reaction. Fire-and-forget so attachments/materialization
      // aren't blocked on a Telegram round-trip, but track the message on
      // success so we can clear it after the agent replies.
      if (message.kind === 'chat-sdk' && message.id) {
        const reactionKey = threadId ?? platformId;
        const compoundId = message.id;
        adapter
          .addReaction(reactionKey, compoundId, SEEN_EMOJI)
          .then(() => {
            let set = pendingSeen.get(reactionKey);
            if (!set) {
              set = new Set();
              pendingSeen.set(reactionKey, set);
            }
            set.add(compoundId);
          })
          .catch((err) => log.warn('Telegram addReaction failed', { reactionKey, err }));
      }

      if (message.kind === 'chat-sdk' && message.content && typeof message.content === 'object') {
        const content = message.content as { attachments?: InboundAttachment[] };
        const attachments = content.attachments;
        if (Array.isArray(attachments) && attachments.length > 0) {
          const folder = resolveGroupFolderForPlatformId('telegram', platformId);
          if (folder) {
            await Promise.all(attachments.map((att, i) => materializeAttachment(att, folder, message.id, i)));
          } else {
            log.debug('No group folder for Telegram platformId — dropping attachment bytes', { platformId });
            for (const att of attachments) delete att.data;
          }
        }
      }
    } catch (err) {
      log.warn('Telegram feature interceptor error', { err });
    }

    await next(platformId, threadId, message);
  };
}

/** Drain and clear all pending 👀 for a thread after a successful outbound. */
function clearPendingSeen(adapter: ReactionAdapter, pendingSeen: Map<string, Set<string>>, reactionKey: string): void {
  const set = pendingSeen.get(reactionKey);
  if (!set || set.size === 0) return;
  const drained = [...set];
  pendingSeen.delete(reactionKey);
  void Promise.allSettled(
    drained.map((compoundId) => adapter.removeReaction(reactionKey, compoundId, SEEN_EMOJI)),
  ).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      log.warn('Telegram removeReaction partial failure', { reactionKey, failed, total: drained.length });
    }
  });
}

// --- Outbound wrapping: send_media_group + streaming video ---

interface MediaGroupItem {
  path: string;
  caption?: string;
}

function buildInputMedia(item: MediaGroupItem): Record<string, unknown> {
  const ext = path.extname(item.path).toLowerCase();
  const filename = path.basename(item.path);
  const ref = `attach://${filename}`;
  const base: Record<string, unknown> = { media: ref };
  if (item.caption) base.caption = item.caption;
  if (VIDEO_EXTS.has(ext)) return { type: 'video', supports_streaming: true, ...base };
  if (PHOTO_EXTS.has(ext)) return { type: 'photo', ...base };
  return { type: 'document', ...base };
}

async function sendMediaGroupRaw(
  token: string,
  chatId: string,
  items: MediaGroupItem[],
  messageThreadId?: number,
): Promise<void> {
  const form = new FormData();
  form.append('chat_id', chatId);
  if (messageThreadId != null) form.append('message_thread_id', String(messageThreadId));
  form.append('media', JSON.stringify(items.map(buildInputMedia)));
  for (const item of items) {
    const filename = path.basename(item.path);
    const buf = await fs.promises.readFile(item.path);
    form.append(filename, new Blob([buf]), filename);
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sendMediaGroup failed: ${res.status} ${body}`);
  }
}

/**
 * POST sendMessage with parse_mode=HTML. Used by the direct-send path that
 * bypasses the vercel/chat adapter for text (see deliver() below).
 */
async function sendMessageTextRaw(
  token: string,
  chatId: string,
  html: string,
  messageThreadId?: number,
): Promise<string | undefined> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    // Suppress URL link previews — the bot's replies shouldn't unfurl every
    // link into a big preview card. Users who want a preview can click through.
    link_preview_options: { is_disabled: true },
  };
  if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`sendMessage failed: ${res.status} ${errText}`);
  }
  const json = (await res.json()) as { ok: boolean; result?: { message_id?: number } };
  return json.result?.message_id != null ? String(json.result.message_id) : undefined;
}

async function sendVideoRaw(
  token: string,
  chatId: string,
  filePath: string,
  caption: string | undefined,
  messageThreadId?: number,
): Promise<string | undefined> {
  const form = new FormData();
  form.append('chat_id', chatId);
  if (messageThreadId != null) form.append('message_thread_id', String(messageThreadId));
  form.append('supports_streaming', 'true');
  if (caption) form.append('caption', caption);
  const buf = await fs.promises.readFile(filePath);
  const filename = path.basename(filePath);
  form.append('video', new Blob([buf]), filename);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sendVideo failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { ok: boolean; result?: { message_id?: number } };
  return json.result?.message_id != null ? String(json.result.message_id) : undefined;
}

function isVideoOnlySingle(message: OutboundMessage): { filePath: string; caption?: string } | null {
  const files = message.files;
  if (!files || files.length !== 1) return null;
  const content = message.content as Record<string, unknown> | null | undefined;
  const text = ((content?.markdown as string) || (content?.text as string) || '').trim();
  const file = files[0];
  const ext = path.extname(file.filename).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return null;
  // Only divert when text is empty or a brief caption (heuristic mirrors fork behaviour).
  if (text.length > 1024) return null;
  return { filePath: '', caption: text || undefined };
}

function parseThreadId(threadId: string | null): number | undefined {
  if (!threadId) return undefined;
  // chat-sdk-bridge threadId format for Telegram is "<platformId>:<topicId>" when topics are used.
  const parts = threadId.split(':');
  const tail = parts[parts.length - 1];
  const n = Number(tail);
  return Number.isFinite(n) && String(n) === tail ? n : undefined;
}

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
    });
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: false,
    });

    const botUsernamePromise = fetchBotUsername(token);
    const pendingSeen = new Map<string, Set<string>>();

    const wrapped: ChannelAdapter = {
      ...bridge,
      async setup(hostConfig: ChannelSetup) {
        const paired = createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token);
        const featured = createFeatureInterceptor(paired, telegramAdapter, pendingSeen);
        const intercepted: ChannelSetup = { ...hostConfig, onInbound: featured };
        return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
      },
      async deliver(platformId, threadId, message): Promise<string | undefined> {
        const content = (message.content as Record<string, unknown>) ?? {};
        const reactionKey = threadId ?? platformId;

        // Custom send_media_group operation
        if (content.operation === 'send_media_group' && Array.isArray(content.items)) {
          const items = content.items as MediaGroupItem[];
          // Resolve each item path: if relative, assume it's a filename in message.files.
          const files = message.files ?? [];
          const resolved: MediaGroupItem[] = [];
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-mg-'));
          try {
            for (const item of items) {
              const bare = path.basename(item.path);
              const file = files.find((f) => f.filename === bare);
              if (!file) {
                log.warn('send_media_group: file not found in outbound files', { path: item.path });
                continue;
              }
              const tmp = path.join(tmpDir, bare);
              await fs.promises.writeFile(tmp, file.data);
              resolved.push({ path: tmp, caption: item.caption });
            }
            if (resolved.length < 2 || resolved.length > 10) {
              log.warn('send_media_group requires 2-10 items', { count: resolved.length });
              return;
            }
            const chatId = chatIdFromPlatformId(platformId);
            await sendMediaGroupRaw(token, chatId, resolved, parseThreadId(threadId));
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
          clearPendingSeen(telegramAdapter, pendingSeen, reactionKey);
          return;
        }

        // Single-file video → sendVideo with supports_streaming.
        const videoMatch = isVideoOnlySingle(message);
        if (videoMatch && message.files) {
          const file = message.files[0];
          const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-tgv-')), file.filename);
          try {
            await fs.promises.writeFile(tmp, file.data);
            const chatId = chatIdFromPlatformId(platformId);
            const msgId = await sendVideoRaw(token, chatId, tmp, videoMatch.caption, parseThreadId(threadId));
            clearPendingSeen(telegramAdapter, pendingSeen, reactionKey);
            return msgId;
          } finally {
            fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
          }
        }

        // Text-only messages: render markdown → Telegram HTML via the vendored
        // openclaw pipeline, chunk at the HTML level (tags never split), and
        // send each chunk directly with parse_mode=HTML, bypassing the
        // vercel/chat adapter's MarkdownV2 path. See src/channels/telegram-render.ts.
        //
        // Messages with attachments fall through to the bridge — it handles
        // media captions (1024-char limit) on its own send path.
        const rawText =
          typeof content.markdown === 'string'
            ? (content.markdown as string)
            : typeof content.text === 'string'
              ? (content.text as string)
              : '';
        const hasFiles = !!(message.files && message.files.length > 0);
        if (rawText && !hasFiles) {
          const chunks = renderTelegramHtmlChunks(rawText, TELEGRAM_SAFE_LIMIT);
          const chatId = chatIdFromPlatformId(platformId);
          const topicId = parseThreadId(threadId);
          let lastId: string | undefined;
          for (const html of chunks) {
            lastId = await sendMessageTextRaw(token, chatId, html, topicId);
          }
          clearPendingSeen(telegramAdapter, pendingSeen, reactionKey);
          return lastId;
        }

        const result = await bridge.deliver(platformId, threadId, message);
        clearPendingSeen(telegramAdapter, pendingSeen, reactionKey);
        return result;
      },
    };
    return wrapped;
  },
});
