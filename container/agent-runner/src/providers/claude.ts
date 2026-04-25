import fs from 'fs';
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

// Tool allowlist for NanoClaw agent containers
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
  'mcp__nanoclaw__*',
];

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

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const { transcript_path: transcriptPath, session_id: sessionId } = preCompact;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);
      if (messages.length === 0) return {};

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

      const conversationsDir = '/workspace/agent/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });
      const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
      fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
      log(`Archived conversation to ${filename}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };
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

const RESULT_ERROR_MESSAGES: Record<string, string> = {
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
  return { kind: 'success', text: message.result };
}

/**
 * Translate the Claude Agent SDK's message stream into our `ProviderEvent`
 * stream. Per Anthropic's documented model:
 *   - `AssistantMessage` is the per-turn progress/final-reply vehicle.
 *   - `ResultMessage` is the lifecycle/cost/error-classification vehicle.
 * Exported (rather than inlined into `query()`) so we can replay real JSONL
 * transcripts through it in tests.
 */
export async function* translateSdkMessages(
  source: AsyncIterable<SDKMessage>,
  isAborted: () => boolean = () => false,
): AsyncGenerator<ProviderEvent> {
  let messageCount = 0;
  // Last text emitted as a final `result` event from a text-only AM.
  // Used to de-dup against ResultMessage.result, which mirrors it on success.
  let lastFinalText: string | null = null;

  for await (const message of source) {
    if (isAborted()) return;
    messageCount++;

    // Liveness: every SDK event keeps the heartbeat fresh.
    yield { type: 'activity' };

    switch (message.type) {
      case 'system': {
        // Narrowed to SDKSystemMessage | SDKAPIRetryMessage |
        // SDKCompactBoundaryMessage | SDKTaskNotificationMessage.
        switch (message.subtype) {
          case 'init':
            yield { type: 'init', continuation: message.session_id };
            break;
          case 'api_retry':
            yield { type: 'error', message: 'API retry', retryable: true };
            break;
          case 'compact_boundary': {
            const pre = message.compact_metadata.pre_tokens;
            const detail = pre ? ` (${pre.toLocaleString()} tokens compacted)` : '';
            yield { type: 'result', text: `Context compacted${detail}.` };
            break;
          }
          case 'task_notification':
            yield { type: 'progress', message: message.summary };
            break;
        }
        break;
      }

      case 'rate_limit_event': {
        // SDKRateLimitEvent is its own top-level type, not a `system` subtype
        // (the previous branch checking `subtype === 'rate_limit_event'` on a
        // system message was dead code). Surface only `rejected` status;
        // `allowed` and `allowed_warning` are informational.
        if (message.rate_limit_info.status === 'rejected') {
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
        if (message.parent_tool_use_id != null) break;
        const { text, hasToolUse } = extractAssistantText(message);
        if (!text) break;
        if (hasToolUse) {
          yield { type: 'progress', message: text };
        } else {
          lastFinalText = text;
          yield { type: 'result', text };
        }
        break;
      }

      case 'result': {
        const classified = classifyResult(message);
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
        } else if (classified.text && classified.text !== lastFinalText) {
          // Defensive: RM has text the AM stream didn't surface. Emit it.
          yield { type: 'result', text: classified.text };
        }
        // else: AM stream already delivered the answer; RM is just lifecycle.
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
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Currently disabled — env var takes priority over settings.json, so setting
 * this clamps every agent to 165k regardless of their configured model's
 * native context window. Leaving it unset lets settings.json's
 * `autoCompactWindow` (or the native model ceiling) take effect.
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

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.env = {
      ...(options.env ?? {}),
      // CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
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
        allowedTools: TOOL_ALLOWLIST,
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
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
