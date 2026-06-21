import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  query as sdkQuery,
  type HookCallback,
  type PreCompactHookInput,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/**
 * Read a Claude transcript .jsonl, render a markdown summary, and drop it into
 * the agent's `conversations/` folder so context survives a compaction or a
 * session rotation. Best-effort: returns false (and logs) on any failure.
 */
function archiveTranscriptFile(transcriptPath: string | undefined, sessionId: string | undefined, assistantName?: string): boolean {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) return false;

    // Try to get summary from sessions index
    let summary: string | undefined;
    const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        summary = index.entries?.find((e: { sessionId: string; summary?: string }) => e.sessionId === sessionId)?.summary;
      } catch {
        /* ignore */
      }
    }

    const name = summary
      ? summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
      : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });
    const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
    fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
    log(`Archived conversation to ${filename}`);
    return true;
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    archiveTranscriptFile(preCompact.transcript_path, preCompact.session_id, assistantName);
    return {};
  };
}

// ── Continuation rotation (cold-resume guard) ──

/**
 * Resume cost is dominated by transcript size. Past this many bytes a fresh
 * cold container can't reload the .jsonl before the host's 30-min idle ceiling
 * fires, so the session is dropped and started clean. Operator-overridable.
 */
function transcriptRotateBytes(): number {
  return Number(process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

/**
 * Secondary age trigger, measured from the transcript's first entry. 0 (or a
 * non-positive value) disables the age check; size alone then governs.
 */
function transcriptRotateAgeMs(): number {
  const raw = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  // Explicit non-positive override disables the age check; size alone governs.
  return days > 0 ? days * 86_400_000 : Infinity;
}

function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/**
 * Locate the .jsonl backing a session id. The SDK names project dirs by a
 * mangled cwd; rather than reproduce that convention we scan project dirs for
 * `<sessionId>.jsonl` (session ids are UUIDs, so this is unambiguous).
 */
function findTranscriptPath(sessionId: string): string | null {
  const projects = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Epoch-ms of the first transcript entry, or null if unreadable. */
function transcriptStartMs(transcriptPath: string): number | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
      const ts = JSON.parse(firstLine)?.timestamp;
      const ms = ts ? Date.parse(ts) : NaN;
      return Number.isNaN(ms) ? null : ms;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ── SDK message classification (translator helpers) ──

/**
 * Text + tool-use summary for an `SDKAssistantMessage`. We surface text-only
 * AMs as `result` events and AMs containing any `tool_use` block as
 * `progress` events (per Anthropic's documented "AssistantMessage = per-turn
 * progress, ResultMessage = lifecycle" model).
 */
interface AssistantTextSummary {
  text: string;
  hasToolUse: boolean;
}

export function extractAssistantText(message: SDKAssistantMessage): AssistantTextSummary {
  let text = '';
  let hasToolUse = false;
  for (const block of message.message.content) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') hasToolUse = true;
  }
  return { text: text.trim(), hasToolUse };
}

export const RESULT_ERROR_MESSAGES: Record<string, string> = {
  error_max_turns: 'Agent reached the maximum turn limit before finishing.',
  error_max_budget_usd: 'Agent reached the budget limit before finishing.',
  error_during_execution: 'Agent execution was interrupted by an error.',
  error_max_structured_output_retries:
    'Agent failed to produce valid structured output after retries.',
};

export type ResultClassification =
  | { kind: 'success'; text: string }
  | { kind: 'refusal' }
  | { kind: 'error'; subtype: string; message: string };

export function classifyResult(message: SDKResultMessage): ResultClassification {
  if (message.subtype !== 'success') {
    return {
      kind: 'error',
      subtype: message.subtype,
      message: RESULT_ERROR_MESSAGES[message.subtype] ?? `Agent stopped: ${message.subtype}`,
    };
  }
  // Narrowed to SDKResultSuccess. `result` is `string` (always present).
  if (message.stop_reason === 'refusal') return { kind: 'refusal' };
  return { kind: 'success', text: (message as { result: string }).result };
}

/**
 * Translate the Claude Agent SDK's message stream into our `ProviderEvent`
 * stream. Exported (rather than inlined into `query()`) so we can replay real
 * JSONL transcripts through it in tests.
 *
 * ── Turn-boundary delivery model — READ THIS before changing the emit logic ──
 *
 * Anthropic's agent loop defines two distinct message roles
 * (docs: https://code.claude.com/docs/en/agent-sdk/agent-loop —
 *  "The SDK yields a final AssistantMessage with the text response (no tool
 *   calls), followed by a ResultMessage with the final text … ResultMessage
 *   marks the end of the agent loop."):
 *   - AssistantMessage — the canonical carrier of the response TEXT
 *     ("emitted after each Claude response, including the final text-only one").
 *   - ResultMessage    — the END-OF-TURN lifecycle marker (cost/usage/stop
 *     reason). It ALSO echoes the final text in `result`, but redundantly.
 *
 * We therefore read the answer from the final text-only AssistantMessage and
 * use the ResultMessage purely as the once-per-turn boundary. We do NOT just
 * read `ResultMessage.result`, for two reasons:
 *   1. By design the text lives on the AssistantMessage; the RM copy is
 *      redundant.
 *   2. The SDK has historically returned an EMPTY `ResultMessage.result` on
 *      some turns (fixed upstream in @anthropic-ai/claude-agent-sdk 0.3.176 &
 *      0.3.179 — both newer than our pinned 0.3.170), which would silently
 *      drop the whole answer if we trusted only the RM. Reading from the AM is
 *      the robust choice and the original reason this translator exists. See
 *      the "replay of the actual failing turn" test in claude.test.ts.
 *
 * ⚠ CRITICAL INVARIANT: emit EXACTLY ONE `result` event per turn, at the
 *     ResultMessage boundary — never one per AssistantMessage.
 *
 *     The poll-loop runs its "not wrapped → not delivered" nudge once per
 *     `result` event (see processQuery → dispatchResultText + the
 *     `willRetryWrapping` push in poll-loop.ts — upstream-identical code that
 *     ASSUMES one result per turn). An earlier version of this translator
 *     emitted a `result` for every intermediate text-only AssistantMessage
 *     (e.g. bare narration like "Now let me check…"). That made the nudge
 *     false-fire mid-turn → the agent re-sent an already-delivered answer →
 *     DUPLICATE messages in chat. Coalescing to one result per turn is the fix.
 *     Do not reintroduce per-AssistantMessage `result`/`progress` emission.
 *
 * TRADE-OFF (intentional): intermediate AssistantMessage text — mid-turn
 * narration, or a `<message>` block the model emits before the final turn — is
 * NOT delivered; only the final answer is. Mid-turn updates must use the
 * `send_message` MCP tool (mcp-tools/core.ts), which is the intended mechanism
 * and is unaffected by this.
 */
export async function* translateSdkMessages(
  source: AsyncIterable<SDKMessage>,
  isAborted: () => boolean = () => false,
): AsyncGenerator<ProviderEvent> {
  let messageCount = 0;
  // Buffered text of the latest top-level text-only AssistantMessage for the
  // CURRENT turn — the answer per Anthropic's loop model. Held (not emitted)
  // until the ResultMessage boundary, then delivered once and reset. See the
  // "Turn-boundary delivery model" block on this function.
  let lastAssistantText: string | null = null;

  for await (const message of source) {
    if (isAborted()) return;
    messageCount++;

    // Liveness: every SDK event keeps the heartbeat fresh.
    yield { type: 'activity' };

    switch (message.type) {
      case 'system': {
        // Narrowed to SDKSystemMessage | SDKAPIRetryMessage |
        // SDKCompactBoundaryMessage | SDKTaskNotificationMessage.
        switch ((message as { subtype?: string }).subtype) {
          case 'init':
            yield { type: 'init', continuation: (message as { session_id: string }).session_id };
            break;
          case 'api_retry':
            yield { type: 'error', message: 'API retry', retryable: true };
            break;
          case 'compact_boundary': {
            // The SDK auto-summarized older context to free up the window. This
            // is a system NOTICE, not agent output — emit it as `notice` so the
            // poll-loop delivers it directly to chat (visible to the user) and
            // does NOT run it through the `<message>`-wrapping nudge. (Emitting
            // it as a bare-text `result` made it both invisible — dropped as
            // scratchpad — AND trip the false "not delivered" nudge.)
            const pre = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata?.pre_tokens;
            const detail = pre ? ` (${pre.toLocaleString()} tokens summarized)` : '';
            yield { type: 'notice', message: `🗜 Context compacted${detail} — older messages were summarized to free up space.` };
            break;
          }
          case 'task_notification':
            yield { type: 'progress', message: (message as { summary?: string }).summary || 'Task notification' };
            break;
        }
        break;
      }

      case 'rate_limit_event': {
        // SDKRateLimitEvent is its own top-level type, not a `system` subtype.
        // Surface only `rejected` status; `allowed` and `allowed_warning` are informational.
        if ((message as { rate_limit_info?: { status?: string } }).rate_limit_info?.status === 'rejected') {
          yield {
            type: 'error',
            message: 'Rate limit reached.',
            retryable: false,
            classification: 'quota',
          };
        }
        break;
      }

      case 'assistant': {
        // Skip subagent narration (Task tool spawns these; parent_tool_use_id
        // is set). We only surface top-level agent output to the user.
        if ((message as SDKAssistantMessage).parent_tool_use_id != null) break;
        const { text, hasToolUse } = extractAssistantText(message as SDKAssistantMessage);
        // Buffer the answer-style text (text with NO tool_use — the documented
        // "final AssistantMessage with the text response (no tool calls)").
        // Do NOT emit here: delivery happens once at the ResultMessage
        // boundary below. Text that accompanies a tool_use is per-turn
        // narration, not the answer, so it is neither buffered nor emitted.
        // See the "Turn-boundary delivery model" block — emitting per-AM here
        // is exactly what caused the duplicate-message bug.
        if (text && !hasToolUse) lastAssistantText = text;
        break;
      }

      case 'result': {
        // ResultMessage = end-of-turn boundary. Emit EXACTLY ONE result for
        // the turn here (or surface a terminal error), then reset the buffer.
        const classified = classifyResult(message as SDKResultMessage);
        if (classified.kind === 'error') {
          yield {
            type: 'error',
            message: classified.message,
            retryable: false,
            classification: classified.subtype,
          };
        } else if (classified.kind === 'refusal') {
          yield {
            type: 'error',
            message: 'Claude declined this request.',
            retryable: false,
            classification: 'refusal',
          };
        } else {
          // Prefer the buffered AssistantMessage text (canonical carrier; never
          // empty when there is an answer). Fall back to ResultMessage.result
          // for the no-text-AM turn and the historical empty-AM/structured
          // cases. `null` when the turn legitimately produced no text (e.g. the
          // agent only used send_message / tools) — the poll-loop then delivers
          // nothing and skips the nudge.
          const text = lastAssistantText ?? (classified.text || null);
          yield { type: 'result', text };
        }
        lastAssistantText = null; // reset for the next turn in this stream
        break;
      }

      // user, user_replay, partial_assistant, status, hook_*, plugin_install,
      // tool_progress, auth_status, task_started/updated/progress,
      // session_state_changed, notification, files_persisted, tool_use_summary,
      // memory_recall, elicitation_complete, prompt_suggestion,
      // local_command_output: no user-facing emit. `activity` already yielded.
    }
  }
  log(`Query completed after ${messageCount} SDK messages`);
}

// ── Provider ──

/**
 * Currently disabled — the env var takes priority over settings.json, so
 * forcing a value here clamps every agent regardless of their configured
 * model's native context window. Leaving it unset lets settings.json's
 * `autoCompactWindow` (or the native model ceiling) take effect.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
// const CLAUDE_CODE_AUTO_COMPACT_WINDOW = '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
    this.effort = options.effort;
    // Do NOT inject CLAUDE_CODE_AUTO_COMPACT_WINDOW here — the env var takes
    // priority over settings.json, so a hardcoded fallback would clamp every
    // agent to 165k regardless of their configured model's context window.
    // Let settings.json's `autoCompactWindow` (or the native model ceiling)
    // win. Operators who want a specific value set it in the host env.
    this.env = {
      ...(options.env ?? {}),
      ...(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
        ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW }
        : {}),
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  maybeRotateContinuation(continuation: string): string | null {
    const transcriptPath = findTranscriptPath(continuation);
    if (!transcriptPath) return null;

    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      return null;
    }

    const maxBytes = transcriptRotateBytes();
    const startMs = transcriptStartMs(transcriptPath);
    const ageMs = startMs === null ? 0 : Date.now() - startMs;
    const maxAgeMs = transcriptRotateAgeMs();

    let reason: string | null = null;
    if (size > maxBytes) {
      reason = `transcript ${(size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`;
    } else if (startMs !== null && ageMs > maxAgeMs) {
      reason = `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`;
    }
    if (!reason) return null;

    // Preserve a readable summary, then move the heavy .jsonl out of the
    // resume path so the SDK starts a fresh session and the disk is reclaimed.
    archiveTranscriptFile(transcriptPath, continuation, this.assistantName);
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (err) {
      log(`Failed to move rotated transcript aside: ${err instanceof Error ? err.message : String(err)}`);
    }
    return reason;
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions } : undefined,
        allowedTools: [
          ...TOOL_ALLOWLIST,
          ...Object.keys(this.mcpServers).map(mcpAllowPattern),
        ],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        model: this.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.effort as any,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user', 'local'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateSdkMessages(sdkResult, () => aborted),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
