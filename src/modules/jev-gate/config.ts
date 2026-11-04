/**
 * Per-wiring config for the Jev ambient wake-gate, hot-reloaded from
 * `data/jev-gate.json`.
 *
 * Shape: `{ "<agent_group_id>": { enabled, mode, daily_cap, ... } }`.
 * A missing file, an unparseable file, or a missing entry all mean "gate off"
 * — the router then behaves exactly as it did before this module existed.
 * That is the only safe default: the gate exists to hold back wakes for a
 * wiring whose engage_mode was widened to pattern-everything, so a config
 * read failure must never be the thing that decides to wake a container.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';

export interface JevThresholds {
  /** Wake when `direct_invitation` reaches this. */
  direct_invitation: number;
  /** Wake when `unresolved` reaches this. */
  unresolved: number;
  /** Veto: at or above this, stay silent however high the wake signals are. */
  already_answered: number;
  /** Veto: two humans in a personal back-and-forth. */
  human_pingpong: number;
}

export interface JevGateEntry {
  enabled: boolean;
  /** `live` applies the verdict; `shadow` judges and annotates but never silences. */
  mode: 'live' | 'shadow';
  /** Max wakes this gate may grant per local day. 0 = no cap. */
  daily_cap: number;
  /** Minutes of quiet after a granted wake. 0 = no cooldown. */
  cooldown_minutes: number;
  /** Consecutive bot-authored gate wakes (no human in between) before the loop guard trips. 0 = off. */
  max_consecutive_bot: number;
  thresholds: JevThresholds;
}

export const DEFAULT_THRESHOLDS: JevThresholds = {
  direct_invitation: 0.7,
  unresolved: 0.6,
  already_answered: 0.6,
  human_pingpong: 0.7,
};

export const DEFAULT_ENTRY: JevGateEntry = {
  enabled: false,
  mode: 'shadow',
  daily_cap: 50,
  cooldown_minutes: 0,
  max_consecutive_bot: 6,
  thresholds: DEFAULT_THRESHOLDS,
};

export function gateConfigPath(): string {
  return path.join(DATA_DIR, 'jev-gate.json');
}

// Keyed on path + mtime + size: an edit is picked up on the next message with
// one stat() per message, and a broken edit is never cached as a permanent
// answer. A parse failure caches nothing, so fixing the file is enough.
let cache: { path: string; mtimeMs: number; size: number; config: Record<string, JevGateEntry> } | null = null;

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeEntry(raw: unknown): JevGateEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const t = (r.thresholds ?? {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    mode: r.mode === 'live' ? 'live' : 'shadow',
    daily_cap: num(r.daily_cap, DEFAULT_ENTRY.daily_cap),
    cooldown_minutes: num(r.cooldown_minutes, DEFAULT_ENTRY.cooldown_minutes),
    max_consecutive_bot: num(r.max_consecutive_bot, DEFAULT_ENTRY.max_consecutive_bot),
    thresholds: {
      direct_invitation: num(t.direct_invitation, DEFAULT_THRESHOLDS.direct_invitation),
      unresolved: num(t.unresolved, DEFAULT_THRESHOLDS.unresolved),
      already_answered: num(t.already_answered, DEFAULT_THRESHOLDS.already_answered),
      human_pingpong: num(t.human_pingpong, DEFAULT_THRESHOLDS.human_pingpong),
    },
  };
}

/** The whole file, normalized. `{}` when absent or unreadable. */
export function loadGateConfig(): Record<string, JevGateEntry> {
  const file = gateConfigPath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache = null;
    return {};
  }

  if (cache && cache.path === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.config;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    log.warn('Jev gate config unreadable — gate stays off', { file, err });
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('Jev gate config is not an object of agent-group entries — gate stays off', { file });
    return {};
  }

  const config: Record<string, JevGateEntry> = {};
  for (const [agentGroupId, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = normalizeEntry(raw);
    if (entry) config[agentGroupId] = entry;
  }
  cache = { path: file, mtimeMs: stat.mtimeMs, size: stat.size, config };
  return config;
}

/** The entry for one wiring, or null when the gate is off for it. */
export function gateEntryFor(agentGroupId: string): JevGateEntry | null {
  const entry = loadGateConfig()[agentGroupId];
  return entry && entry.enabled ? entry : null;
}

/** A partial update: thresholds merge field-by-field, not wholesale. */
export type JevGatePatch = Partial<Omit<JevGateEntry, 'thresholds'>> & { thresholds?: Partial<JevThresholds> };

/** Merge a partial entry into the file and return the stored result. */
export function writeGateEntry(agentGroupId: string, patch: JevGatePatch): JevGateEntry {
  const current = loadGateConfig();
  const base = current[agentGroupId] ?? DEFAULT_ENTRY;
  const merged: JevGateEntry = {
    ...base,
    ...patch,
    thresholds: { ...base.thresholds, ...(patch.thresholds ?? {}) },
  };
  const next = { ...current, [agentGroupId]: merged };
  const file = gateConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  cache = null;
  return merged;
}

/** Test seam: drop the mtime cache (a same-millisecond rewrite is otherwise sticky). */
export function resetGateConfigCache(): void {
  cache = null;
}
