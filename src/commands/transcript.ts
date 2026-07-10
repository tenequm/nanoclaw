/**
 * Host-side, read-only reader of an agent group's SDK transcript.
 *
 * The Claude Agent SDK writes a JSONL transcript per session under
 *   data/v2-sessions/<agent_group_id>/.claude-shared/projects/<cwd>/<sdk-id>.jsonl
 * (the observed cwd dir is '-workspace-agent'; we glob projects/*\/ instead of
 * hard-coding it). We map a nanoclaw session to its SDK session id via the
 * session's outbound.db `session_state` table (host is the designated reader of
 * outbound.db), keyed `continuation:<provider>` with a legacy `sdk_session_id`
 * fallback (see container/agent-runner/src/db/session-state.ts). When no session
 * or no id is available we fall back to the newest .jsonl in the group's
 * projects dir. Anything unresolved returns null and the status card omits the
 * derived lines.
 *
 * Every fs/parse error is swallowed (log.debug at most, never thrown): a status
 * read must never fail because a transcript is missing or malformed.
 *
 * Typography rule for this module: ASCII only in strings and comments. Emoji
 * are allowed as UI glyphs (none used here).
 */
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';
import { openOutboundDb, outboundDbPath, sessionsBaseDir } from '../session-manager.js';

export interface TranscriptStats {
  /** Latest turn's context size: input + cache_read + cache_creation tokens. */
  contextTokens: number;
  /** Cumulative output tokens across unique-message turns. */
  outputTokens: number;
  /** Number of unique assistant turns (deduped by message.id). */
  turns: number;
}

/** The group's SDK projects dir, or null when the group has no transcript tree. */
function projectsRoot(agentGroupId: string): string | null {
  const root = path.join(sessionsBaseDir(), agentGroupId, '.claude-shared', 'projects');
  if (!fs.existsSync(root)) return null;
  return root;
}

/** All *.jsonl transcript files under projects/*\/, with their mtimes. */
function transcriptFiles(agentGroupId: string): Array<{ file: string; base: string; mtimeMs: number }> {
  const root = projectsRoot(agentGroupId);
  if (!root) return [];
  const out: Array<{ file: string; base: string; mtimeMs: number }> = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      out.push({ file: full, base: f.slice(0, -'.jsonl'.length), mtimeMs });
    }
  }
  return out;
}

/**
 * SDK session id for a nanoclaw session, read from its outbound.db
 * `session_state`. Prefers the per-provider `continuation:*` row, then the
 * legacy `sdk_session_id`. Returns null on any error or when absent.
 */
function sdkSessionId(agentGroupId: string, sessionId: string): string | null {
  const dbPath = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = openOutboundDb(agentGroupId, sessionId);
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(
        `SELECT value FROM session_state
          WHERE key LIKE 'continuation:%' OR key = 'sdk_session_id'
          ORDER BY (key LIKE 'continuation:%') DESC, updated_at DESC
          LIMIT 1`,
      )
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Parse one transcript file. Streams line by line (files can be MBs). For each
 * 'assistant' line with message.usage, dedupe by message.id (the SDK log
 * repeats consecutive lines with an identical id/usage) and:
 *   - context = last turn's input + cache_read + cache_creation tokens,
 *   - outputTokens += that turn's output_tokens,
 *   - turns += 1.
 * Returns null when the file yields no usable assistant turn.
 */
function parseTranscript(file: string): TranscriptStats | null {
  const text = fs.readFileSync(file, 'utf8');
  const seen = new Set<string>();
  let contextTokens = 0;
  let outputTokens = 0;
  let turns = 0;

  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj: {
      type?: string;
      message?: { id?: string; usage?: Record<string, number> };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'assistant') continue;
    const msg = obj.message;
    if (!msg || !msg.usage) continue;
    const id = msg.id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const u = msg.usage;
    contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    outputTokens += u.output_tokens ?? 0;
    turns += 1;
  }

  if (turns === 0) return null;
  return { contextTokens, outputTokens, turns };
}

/**
 * Read transcript stats for an agent group. When `sessionId` is given, resolve
 * that session's SDK transcript; otherwise (or when the session has no SDK id
 * or file) fall back to the newest .jsonl in the group's projects dir. Returns
 * null when nothing is resolvable or on any error.
 */
export function readTranscriptStats(agentGroupId: string, sessionId: string | null): TranscriptStats | null {
  try {
    const files = transcriptFiles(agentGroupId);
    if (files.length === 0) return null;

    let target: string | null = null;
    if (sessionId) {
      const sdkId = sdkSessionId(agentGroupId, sessionId);
      if (sdkId) {
        const match = files.find((f) => f.base === sdkId);
        if (match) target = match.file;
      }
    }
    if (!target) {
      target = files.reduce((newest, f) => (f.mtimeMs > newest.mtimeMs ? f : newest)).file;
    }
    return parseTranscript(target);
  } catch (err) {
    log.debug('Transcript stats read failed', { agentGroupId, sessionId, err: String(err) });
    return null;
  }
}
