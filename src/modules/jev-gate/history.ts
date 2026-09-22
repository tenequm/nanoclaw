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

/** Rows rendered into the state we send Jev. */
export const STATE_HISTORY_LINES = 10;

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
}

/** Rows written by a real chat participant — the only ones the bot-loop streak walks. */
function isChatRow(row: GateHistoryRow): boolean {
  return row.kind === 'chat' || row.kind === 'chat-sdk';
}

interface ParsedContent {
  text: string;
  sender: string;
  isBot: boolean;
  jev: JevMeta | null;
}

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
    return { text: raw, sender: '', isBot: false, jev: null };
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
  return { text, sender, isBot, jev: parseJevMeta(parsed.jev) };
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
      const { text, sender, isBot, jev } = parseAuthor(r.content);
      rows.push({ timestamp: r.timestamp, direction: 'in', kind: r.kind, text, sender, isBot, jev });
    }
    for (const r of raw.outbound) {
      const { text } = parseAuthor(r.content);
      rows.push({ timestamp: r.timestamp, direction: 'out', kind: r.kind, text, sender: '', isBot: true, jev: null });
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

/** The last `STATE_HISTORY_LINES` rows, rendered for Jev. */
export function renderStateLines(rows: GateHistoryRow[], lines = STATE_HISTORY_LINES): string {
  return rows
    .slice(-lines)
    .map((r) => {
      const who = r.direction === 'out' ? 'Dan (the assistant)' : `${r.sender || 'unknown'}${r.isBot ? ' [bot]' : ''}`;
      return `${who}: ${oneLine(r.text)}`;
    })
    .join('\n');
}

// No length cap: Telegram bounds a message at 4096 chars, so 10 history lines
// plus the new message stay well inside Jev's 32k-token state budget.
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
