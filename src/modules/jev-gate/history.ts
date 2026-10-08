/**
 * The gate's read side: one host-side open of the session's mailbox per
 * judged message, merged in/out, from which everything else is derived.
 *
 * There is no gate table. The verdict lands on each stored message twice:
 * a human-readable `[jev: …]` line appended to `text` (for the agent's
 * prompt and pond), and a host-written `jev` metadata key in the content
 * JSON. Derivation — the daily wake count, the cooldown stamp, the
 * consecutive-bot streak — reads ONLY the metadata key. User-authored text
 * is a JSON string value and cannot forge a key, so a chat message
 * containing the literal marker cannot trip the levers.
 *
 * Read-only from the host side (the existing open-read-close mailbox
 * helper), so it is safe with a live container.
 */
import { withExistingMailboxSession } from '../../session-manager.js';
import { log } from '../../log.js';

/** Human-readable prefix of a granted-wake annotation. Display only — never derivation. */
export const WAKE_MARKER = '[jev: reply';

/** First window per judgment; escalates when a busy day outruns it (see readGateHistory). */
export const GATE_HISTORY_LIMIT = 200;

/** Escalation ladder: a window is wide enough once it reaches back past 24h. */
const HISTORY_LIMITS = [GATE_HISTORY_LIMIT, 1000, 4000];

/** Rows rendered into the state we send Jev, counted after albums and edits collapse. */
export const STATE_HISTORY_LINES = 15;

/** A pause between rendered rows longer than this gets a gap marker. */
const GAP_MARK_MS = 30 * 60_000;

/** Quoted reply targets are clipped; the gist is enough to tell who is talking to whom. */
const REPLY_QUOTE_CHARS = 80;

/** Host-written verdict metadata stored next to `text` in the content JSON. */
export interface JevMeta {
  v: 'reply' | 'silent' | 'error';
  mode: 'live' | 'shadow';
  at?: string;
}

export interface GateHistoryRow {
  timestamp: string;
  direction: 'in' | 'out';
  /** Mailbox row kind: 'chat' | 'chat-sdk' | 'system' | 'task' | … */
  kind: string;
  text: string;
  sender: string;
  /** True for our own outbound, and for inbound whose author is a bot. */
  isBot: boolean;
  /** Host-written verdict metadata, null for rows the gate never judged. */
  jev: JevMeta | null;
  /** The sender's nanoclaw role (`owner`, `admin`), host-stamped; null when none. */
  role: string | null;
  /** The message this one replies to, when the platform says so. */
  replyTo: { sender: string; text: string } | null;
  hasMedia: boolean;
}

/** Rows written by a real chat participant — the only ones the bot-loop streak walks. */
function isChatRow(row: GateHistoryRow): boolean {
  return row.kind === 'chat' || row.kind === 'chat-sdk';
}

type ParsedContent = Pick<GateHistoryRow, 'text' | 'sender' | 'isBot' | 'jev' | 'role' | 'replyTo' | 'hasMedia'>;

function parseJevMeta(value: unknown): JevMeta | null {
  if (!value || typeof value !== 'object') return null;
  const v = (value as { v?: unknown }).v;
  const mode = (value as { mode?: unknown }).mode;
  if ((v === 'reply' || v === 'silent' || v === 'error') && (mode === 'live' || mode === 'shadow')) {
    return { v, mode };
  }
  return null;
}

/**
 * Bot-authorship of a stored message. `author.isBot` is the real signal
 * (propagated from Telegram's `from.is_bot`); the username heuristic is the
 * fallback for rows written before that field existed.
 */
export function parseAuthor(raw: string): ParsedContent {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { text: raw, sender: '', isBot: false, jev: null, role: null, replyTo: null, hasMedia: false };
  }
  const author = (parsed.author ?? {}) as Record<string, unknown>;
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  const sender =
    (typeof parsed.sender === 'string' && parsed.sender) ||
    (typeof parsed.senderName === 'string' && parsed.senderName) ||
    (typeof author.fullName === 'string' && author.fullName) ||
    '';
  const userName = typeof author.userName === 'string' ? author.userName : '';
  const isBot = author.isBot === true || (author.isBot === undefined && userName.toLowerCase().endsWith('bot'));
  const reply = (parsed.replyTo ?? null) as Record<string, unknown> | null;
  // An edit with no reply of its own is linked to its original as sender 'original' — not a reply.
  const replyTo =
    reply && typeof reply.sender === 'string' && reply.sender && reply.sender !== 'original'
      ? { sender: reply.sender, text: typeof reply.text === 'string' ? reply.text : '' }
      : null;
  return {
    text,
    sender,
    isBot,
    jev: parseJevMeta(parsed.jev),
    role: typeof parsed.senderRole === 'string' && parsed.senderRole ? parsed.senderRole : null,
    replyTo,
    hasMedia: Array.isArray(parsed.attachments) && parsed.attachments.length > 0,
  };
}

/**
 * Merged, chronological history for one session. Empty when the session has
 * no mailbox yet. The window starts at GATE_HISTORY_LIMIT rows and escalates
 * until it reaches back past 24h (which always covers the local day the cap
 * counts over) or the ladder tops out — a row-capped window on a busy day
 * would silently undercount `wakesToday` and leak the cap.
 */
export async function readGateHistory(agentGroupId: string, sessionId: string): Promise<GateHistoryRow[]> {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  for (let i = 0; i < HISTORY_LIMITS.length; i++) {
    const limit = HISTORY_LIMITS[i];
    let raw:
      | {
          inbound: Array<{ timestamp: string; kind: string; content: string }>;
          outbound: Array<{ timestamp: string; kind: string; content: string }>;
        }
      | undefined;
    try {
      raw = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => ({
        inbound: mailbox.getInboundHistory(limit),
        outbound: mailbox.getOutboundHistory(limit),
      }));
    } catch (err) {
      // A locked or half-written session DB must not decide a wake — the
      // caller treats an empty history as "judge on the message alone".
      log.debug('Jev gate history read failed', { agentGroupId, sessionId, err });
      return [];
    }
    if (!raw) return [];

    const windowFull = raw.inbound.length >= limit;
    const oldestInbound = raw.inbound.reduce<string | null>(
      (min, r) => (min === null || r.timestamp < min ? r.timestamp : min),
      null,
    );
    const coversDay = !windowFull || (oldestInbound !== null && new Date(oldestInbound).getTime() < dayAgo);
    if (!coversDay && i < HISTORY_LIMITS.length - 1) continue;
    if (!coversDay) {
      log.warn('Jev gate history window exhausted before covering 24h — cap may undercount', {
        agentGroupId,
        sessionId,
        limit,
      });
    }

    const rows: GateHistoryRow[] = [];
    for (const r of raw.inbound) {
      rows.push({ timestamp: r.timestamp, direction: 'in', kind: r.kind, ...parseAuthor(r.content) });
    }
    for (const r of raw.outbound) {
      const { text, hasMedia } = parseAuthor(r.content);
      rows.push({
        timestamp: r.timestamp,
        direction: 'out',
        kind: r.kind,
        text,
        sender: '',
        isBot: true,
        jev: null,
        role: null,
        replyTo: null,
        hasMedia,
      });
    }
    rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    return rows;
  }
  return [];
}

function localDay(timestamp: string, timezone: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

function isWake(row: GateHistoryRow, mode: JevMeta['mode']): boolean {
  return row.direction === 'in' && row.jev?.v === 'reply' && row.jev.mode === mode;
}

/**
 * Wakes this gate granted today (local day), from the stored metadata. In
 * shadow mode the count is of shadow verdicts, so the levers simulate what
 * live would do without live and shadow contaminating each other's quota.
 */
export function wakesToday(
  rows: GateHistoryRow[],
  timezone: string,
  now: Date,
  mode: JevMeta['mode'] = 'live',
): number {
  const today = localDay(now.toISOString(), timezone);
  return rows.filter((r) => isWake(r, mode) && localDay(r.timestamp, timezone) === today).length;
}

/** Timestamp of the most recent gate-granted wake in this mode, or null. */
export function lastWakeAt(rows: GateHistoryRow[], mode: JevMeta['mode'] = 'live'): Date | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (isWake(row, mode)) {
      const date = new Date(row.timestamp);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return null;
}

/**
 * Gate-granted wakes on bot-authored messages since the last human message.
 * A human speaking clears the streak — the guard is about the bot-to-bot
 * spiral, not about how much of the day's traffic came from bots.
 *
 * Only real chat rows participate. System-generated inbound (kind 'system',
 * session echoes, task rows) has no author, so it parses `isBot=false` and
 * would otherwise read as "a human spoke" and clear a live bot-to-bot loop.
 */
export function consecutiveBotWakes(rows: GateHistoryRow[], mode: JevMeta['mode'] = 'live'): number {
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.direction !== 'in') continue;
    if (!isChatRow(row)) continue;
    if (!row.isBot) break;
    if (isWake(row, mode)) streak++;
  }
  return streak;
}

interface StateRow {
  row: GateHistoryRow;
  body: string;
  edited: boolean;
  album: { id: string; items: number } | null;
}

const ANNOTATION_LINE = /\n?^\[jev: [^\n]*\]$/gm;
const EDITED_PREFIX = /^\[EDITED\]\s*/;
const ALBUM_TAG = /^((?:\[[^\]\n]*\] )*)\[album (\S+)\]\s*/;

/**
 * The rows as a reader of the chat saw them. The gate's own `[jev: …]` lines
 * come off the text (derivation reads the metadata key, never this); an edit
 * replaces its original, which the adapter stamps with the same sender and
 * timestamp; an album's per-item rows fold into one; rows with nothing to show
 * (our reactions, CLI frames, system notices) drop out.
 */
function collapse(rows: GateHistoryRow[]): StateRow[] {
  const out: StateRow[] = [];
  for (const row of rows) {
    if (!isChatRow(row)) continue;
    let body = row.text.replace(ANNOTATION_LINE, '');
    const edited = EDITED_PREFIX.test(body);
    if (edited) {
      body = body.replace(EDITED_PREFIX, '');
      for (let i = out.length - 1; i >= 0; i--) {
        const prior = out[i].row;
        if (prior.direction === row.direction && prior.sender === row.sender && prior.timestamp === row.timestamp) {
          if (out[i].album) out[i].album!.items--;
          if (!out[i].album || out[i].album!.items === 0) out.splice(i, 1);
          break;
        }
      }
    }
    const albumMatch = ALBUM_TAG.exec(body);
    if (albumMatch) {
      body = `${albumMatch[1]}${body.slice(albumMatch[0].length)}`;
      const group = out.findLast((s) => s.album?.id === albumMatch[2]);
      if (group) {
        group.album!.items++;
        if (body.trim()) group.body = body;
        group.edited ||= edited;
        out.splice(out.indexOf(group), 1);
        out.push({ ...group, row });
        continue;
      }
    }
    if (!body.trim() && !row.hasMedia && !albumMatch) continue;
    out.push({ row, body, edited, album: albumMatch ? { id: albumMatch[2], items: 1 } : null });
  }
  return out;
}

function gapLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function gapMarker(prev: GateHistoryRow | undefined, next: GateHistoryRow): string | null {
  if (!prev) return null;
  const ms = new Date(next.timestamp).getTime() - new Date(prev.timestamp).getTime();
  return ms > GAP_MARK_MS ? `(${gapLabel(ms)} later)` : null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderRow(s: StateRow, agentName: string): string {
  const { row } = s;
  const who =
    row.direction === 'out'
      ? `${agentName} [assistant]`
      : `${row.sender || 'unknown'}${row.role ? ` [${row.role}]` : ''}${row.isBot ? ' [bot]' : ''}`;
  const quote = row.replyTo?.text ? `: "${clip(oneLine(row.replyTo.text), REPLY_QUOTE_CHARS)}"` : '';
  const reply = row.replyTo ? ` (replying to ${row.replyTo.sender}${quote})` : '';
  const album = s.album ? `[album, ${s.album.items} item${s.album.items === 1 ? '' : 's'}] ` : '';
  const body = oneLine(s.body) || (row.hasMedia && !s.album ? '[media]' : '');
  return `${who}${s.edited ? ' (edited)' : ''}${reply}: ${album}${body}`.trimEnd();
}

/**
 * The state we send Jev: the last `lines` collapsed rows with gap markers,
 * then the new message. The new message collapses with the history, so an
 * edit retires its original and a late album item joins its album.
 */
export function renderState(
  rows: GateHistoryRow[],
  message: GateHistoryRow,
  agentName: string,
  lines = STATE_HISTORY_LINES,
): string {
  const all = collapse([...rows, message]);
  const last = all.at(-1);
  const next = last && last.row === message ? all.pop()! : { row: message, body: '', edited: false, album: null };
  const history = all.slice(-lines);

  const out = ['Conversation so far (oldest first):'];
  history.forEach((s, i) => {
    const gap = gapMarker(history[i - 1]?.row, s.row);
    if (gap) out.push(gap);
    out.push(renderRow(s, agentName));
  });
  if (history.length === 0) out.push('(no prior messages)');
  out.push('', 'NEW MESSAGE:');
  const gap = gapMarker(history.at(-1)?.row, next.row);
  if (gap) out.push(gap);
  out.push(renderRow(next, agentName));
  return out.join('\n');
}

// No length cap: Telegram bounds a message at 4096 chars, so 15 history lines
// plus the new message stay well inside Jev's 32k-token state budget.
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
