/**
 * The gate's read side: one host-side open of the session's mailbox per
 * judged message, merged in/out, from which everything else is derived.
 *
 * There is no gate table. The verdict annotation appended to each stored
 * message IS the log, so the daily wake count, the cooldown stamp, and the
 * consecutive-bot streak are all re-derived from `messages_in` on every call.
 * Read-only from the host side (the existing open-read-close mailbox helper),
 * so it is safe with a live container.
 */
import { withExistingMailboxSession } from '../../session-manager.js';
import { log } from '../../log.js';

/** Marker that identifies a message this gate granted a wake for. */
export const WAKE_MARKER = '[jev: reply';

/** How many merged rows we pull per judgment — deep enough for a 50/day cap. */
export const GATE_HISTORY_LIMIT = 200;

/** Rows rendered into the state we send Jev. */
export const STATE_HISTORY_LINES = 10;

export interface GateHistoryRow {
  timestamp: string;
  direction: 'in' | 'out';
  text: string;
  sender: string;
  /** True for our own outbound, and for inbound whose author is a bot. */
  isBot: boolean;
  /** This row carries a `[jev: reply` annotation — the gate woke on it. */
  jevWake: boolean;
}

interface ParsedContent {
  text: string;
  sender: string;
  isBot: boolean;
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
    return { text: raw, sender: '', isBot: false };
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
  return { text, sender, isBot };
}

/** Merged, chronological history for one session. Empty when the session has no mailbox yet. */
export async function readGateHistory(
  agentGroupId: string,
  sessionId: string,
  limit = GATE_HISTORY_LIMIT,
): Promise<GateHistoryRow[]> {
  let raw:
    | {
        inbound: Array<{ timestamp: string; content: string }>;
        outbound: Array<{ timestamp: string; content: string }>;
      }
    | undefined;
  try {
    raw = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => ({
      inbound: mailbox.getInboundHistory(limit),
      outbound: mailbox.getOutboundHistory(limit),
    }));
  } catch (err) {
    // A locked or half-written session DB must not decide a wake — the caller
    // treats an empty history as "judge on the message alone".
    log.debug('Jev gate history read failed', { agentGroupId, sessionId, err });
    return [];
  }
  if (!raw) return [];

  const rows: GateHistoryRow[] = [];
  for (const r of raw.inbound) {
    const { text, sender, isBot } = parseAuthor(r.content);
    rows.push({ timestamp: r.timestamp, direction: 'in', text, sender, isBot, jevWake: text.includes(WAKE_MARKER) });
  }
  for (const r of raw.outbound) {
    const { text } = parseAuthor(r.content);
    rows.push({ timestamp: r.timestamp, direction: 'out', text, sender: '', isBot: true, jevWake: false });
  }
  rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return rows.slice(-limit);
}

function localDay(timestamp: string, timezone: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

/** Wakes this gate granted today (local day), from the stored annotations. */
export function wakesToday(rows: GateHistoryRow[], timezone: string, now: Date): number {
  const today = localDay(now.toISOString(), timezone);
  return rows.filter((r) => r.direction === 'in' && r.jevWake && localDay(r.timestamp, timezone) === today).length;
}

/** Timestamp of the most recent gate-granted wake, or null. */
export function lastWakeAt(rows: GateHistoryRow[]): Date | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.direction === 'in' && row.jevWake) {
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
 */
export function consecutiveBotWakes(rows: GateHistoryRow[]): number {
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.direction !== 'in') continue;
    if (!row.isBot) break;
    if (row.jevWake) streak++;
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

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}
