/**
 * Channel-agnostic formatting helpers for the chat-command surface.
 *
 * Pure functions with no IO. They produce the compact token counts and the
 * absolute-plus-relative timestamps the Hermes-style status card renders.
 *
 * Typography rule for this module: ASCII only in strings and comments (no
 * em-dash, en-dash, smart quotes, unicode ellipsis, arrows, bullet chars, or
 * non-breaking space). Emoji are allowed as UI glyphs.
 */

/** Drop a trailing '.0' from a fixed(1) string ('4.0' -> '4', '4.5' -> '4.5'). */
function stripTrailingZero(fixed: string): string {
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/**
 * Compact token count (OpenClaw heuristic):
 *   >= 1_000_000 -> '1.2m'  (1 decimal, trailing .0 stripped)
 *   >= 10_000    -> '46k'   (0 decimals)
 *   >= 1_000     -> '4.5k'  (1 decimal, trailing .0 stripped)
 *   else         -> the raw integer as a string
 * Negatives and non-finite inputs fall back to String(n).
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n >= 1_000_000) return `${stripTrailingZero((n / 1_000_000).toFixed(1))}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${stripTrailingZero((n / 1000).toFixed(1))}k`;
  return String(n);
}

/** Two-digit zero-pad for date/time parts. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local 'YYYY-MM-DD HH:MM' for a Date. */
function localStamp(d: Date): string {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${date} ${time}`;
}

/** Relative age of a millisecond delta: 'just now' | 'Nm ago' | 'Nh ago' | 'Nd ago'. */
function relative(deltaMs: number): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

/**
 * Absolute local time plus a relative suffix, e.g.
 * '2026-07-10 00:32 (2h ago)'. Invalid input echoes back unchanged so a bad
 * timestamp never blanks a card.
 */
export function formatDateRel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${localStamp(d)} (${relative(Date.now() - d.getTime())})`;
}
