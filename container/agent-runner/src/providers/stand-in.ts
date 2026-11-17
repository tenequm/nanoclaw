import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/container-state.js';
import { getSessionRouting } from '../db/session-routing.js';
import { findByRouting } from '../destinations.js';
import { sendMessage, sendFile, editMessage } from '../mcp-tools/core.js';
import { askUserQuestion } from '../mcp-tools/interactive.js';
import type { McpToolDefinition } from '../mcp-tools/types.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './types.js';

function decode(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

// `long 2` or `question 5`: an optional duration after the command word.
function seconds(text: string): number | undefined {
  return Number(/^\w+ (\d+)\b/.exec(text)?.[1]) || undefined;
}

export class StandInProvider implements AgentProvider {
  readonly startsIdle = true;

  constructor() {
    if (process.env.NANOCLAW_LOCAL_STAND_IN !== '1') {
      throw new Error('stand-in requires NANOCLAW_LOCAL_STAND_IN=1 from the local host');
    }
  }

  registerMemorySessionHook(): void {}
  isSessionInvalid(): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const controller = new AbortController();
    const { signal } = controller;
    const pending = input.prompt ? [input.prompt] : [];
    let ended = false;
    let wake: (() => void) | undefined;

    async function invoke(tool: McpToolDefinition, args: Record<string, unknown>): Promise<string> {
      signal.throwIfAborted();
      setContainerToolInFlight(tool.tool.name, null);
      try {
        const result = await tool.handler(args, { signal });
        if (result.isError) throw new Error(`stand-in tool failed: ${tool.tool.name}`);
        return result.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');
      } finally {
        clearContainerToolInFlight();
      }
    }

    async function* turn(prompt: string): AsyncGenerator<ProviderEvent> {
      const messages = [...prompt.matchAll(/<message\b([^>]*)>([\s\S]*?)<\/message>/g)];
      const inputs = messages.length
        ? messages.map((match) => ({
            to: decode(/\bfrom="([^"]*)"/.exec(match[1])?.[1] ?? ''),
            text: decode(match[2].replace(/^\s*<quoted_message\b[^>]*>[\s\S]*?<\/quoted_message>\s*/, '')),
          }))
        : [{ to: '', text: prompt }];
      for (const message of inputs) {
        signal.throwIfAborted();
        const route = getSessionRouting();
        const to = message.to || findByRouting(route.channel_type, route.platform_id)?.name;
        if (!to) throw new Error('stand-in requires a routed chat destination');
        const send = (text: string) => invoke(sendMessage, { to, text });
        yield { type: 'activity' };
        yield { type: 'tool_call', name: 'send_message' };
        if (message.text.startsWith('reply')) {
          await send('Stand-in reply.');
        } else if (message.text.startsWith('markdown')) {
          await send(
            '# Stand-in\n\n- First\n- Second\n\n| Key | Value |\n| --- | --- |\n| State | Ready |\n\n```text\nhello\n```',
          );
        } else if (message.text.startsWith('question')) {
          yield { type: 'tool_call', name: 'ask_user_question' };
          const answer = await invoke(askUserQuestion, {
            title: 'Stand-in question',
            question: 'Choose an option.',
            options: ['Alpha', 'Beta', 'Gamma'],
            timeout: seconds(message.text),
          });
          await send(`Selected: ${answer}`);
        } else if (message.text.startsWith('file')) {
          const directory = fs.mkdtempSync(path.join(input.cwd, '.stand-in-'));
          try {
            fs.writeFileSync(path.join(directory, 'stand-in.txt'), 'Stand-in file.\n');
            fs.writeFileSync(
              path.join(directory, 'stand-in.png'),
              Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
                'base64',
              ),
            );
            for (const name of ['stand-in.txt', 'stand-in.png']) {
              yield { type: 'tool_call', name: 'send_file' };
              await invoke(sendFile, { to, path: path.join(directory, name) });
            }
          } finally {
            fs.rmSync(directory, { recursive: true, force: true });
          }
        } else if (message.text.startsWith('edit')) {
          const sent = await send('Before edit.');
          const id = /\(id: (\d+)\)/.exec(sent)?.[1];
          if (!id) throw new Error('stand-in send_message returned no sequence');
          yield { type: 'tool_call', name: 'edit_message' };
          await invoke(editMessage, { messageId: Number(id), text: 'After edit.' });
        } else if (message.text.startsWith('long')) {
          const duration = seconds(message.text) ?? 20;
          yield { type: 'tool_call', name: 'stand_in_wait' };
          setContainerToolInFlight('stand_in_wait', null);
          try {
            for (let second = 0; second < duration; second++) {
              await sleep(1000, undefined, { signal });
              yield { type: 'activity' };
            }
          } finally {
            clearContainerToolInFlight();
          }
          await send('Long tool complete.');
        } else if (message.text.startsWith('multi')) {
          for (const text of ['First message.', 'Second message.', 'Third message.']) await send(text);
        } else {
          await send(message.text);
        }
      }
      signal.throwIfAborted();
      yield { type: 'result', text: null, stopReason: 'end_turn' };
    }

    return {
      push(message) {
        if (!ended && !signal.aborted) {
          pending.push(message);
          wake?.();
        }
      },
      end() {
        ended = true;
        wake?.();
      },
      abort() {
        controller.abort();
        wake?.();
      },
      events: {
        async *[Symbol.asyncIterator]() {
          try {
            while (!signal.aborted) {
              const prompt = pending.shift();
              if (prompt !== undefined) {
                yield* turn(prompt);
                continue;
              }
              if (ended) break;
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = undefined;
            }
          } catch (error) {
            if (!signal.aborted) throw error;
          }
        },
      },
    };
  }
}

registerProvider('stand-in', () => new StandInProvider());
