/**
 * Telegram prose for the agents' composed project documents: the formatting
 * guide and the Rich messages section.
 *
 * Kept apart from the adapter so tests can compose a document without loading
 * the adapter: both sections are pure DB reads, registered at import time.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { isAgentWiredToChannel } from '../../db/messaging-groups.js';
import { registerProjectDocSection } from '../../project-doc-compose.js';
import type { AgentGroup } from '../../types.js';

const CHANNEL_TYPE = 'telegram';

export const FORMATTING_SECTION = 'Telegram formatting';

// formatter.test.ts checks that every syntax taught here renders as described.
export const FORMATTING_BODY = [
  'Write ordinary markdown in Telegram messages; the integration converts it to',
  "Telegram's own formatting and splits long text, so your job is only the shape.",
  '',
  '- **Renders as written:** `**bold**`, `_italic_`, `__underline__`,',
  '  `~~strike~~`, `||spoiler||`, `` `code` ``, fenced code with a language,',
  '  `[label](https://...)`, `> quote`, and lists, including nested lists and',
  '  `- [ ]` / `- [x]` tasks.',
  '- **Mentions:** `[Name](tg://user?id=123)` notifies that person by Telegram id.',
  '- **Collapsible detail:** start a quote with `> [!fold]` so long logs or',
  '  sources stay folded until the reader opens them.',
  '- **Times:** `[Fri 15:00](tg://time?unix=1792162800&format=wDT)` shows each',
  '  reader the time in their own timezone; `format=r` shows it relative',
  '  ("in 2 hours"). Use it whenever you state a time for someone else.',
  '- **Degrades:** headings become bold lines, tables become a small monospace',
  '  grid or bullets when wide, and markdown images become links. Prefer short',
  '  bullets over wide tables, and send pictures with `send_file`.',
  '- **Bold vs italic:** a single `*x*` renders bold here, so write italic as `_x_`.',
].join('\n');

export const RICH_MESSAGES_SECTION = 'Rich messages';

export const RICH_MESSAGES_BODY = [
  'On Telegram, `send_message` takes `rich: true` to send a Rich Message. Telegram then renders real tables, headings (`#`), nested and task lists (`- [ ]`, `- [x]`) and collapsible `<details><summary>Title</summary>...</details>` blocks, up to 32768 characters in one message.',
  'Use it when structure carries the meaning: a table, a structured report, a long reference text. Keep normal chat plain, without `rich`: a plain message renders on every client, and readers can quote-reply a part of it, which a Rich Message does not allow.',
  'A Rich Message reads standard markdown, so a single line break joins two lines into one paragraph; leave a blank line between lines you want apart. `**bold**` and `_italic_` mean the same in both kinds of message. If Telegram refuses a Rich Message it goes out as a normal message, so the text still arrives.',
].join('\n\n');

/** Rich Messages are taught only where they work: a Telegram-wired agent whose group has them on. */
async function richMessagesSection(group: AgentGroup): Promise<{ name: string; body: string } | null> {
  if ((await getContainerConfig(group.id))?.rich_messages !== 1) return null;
  if (!(await isAgentWiredToChannel(group.id, CHANNEL_TYPE))) return null;
  return { name: RICH_MESSAGES_SECTION, body: RICH_MESSAGES_BODY };
}

/** Every Telegram-wired agent gets the guide, whatever its skill selection. */
async function formattingSection(group: AgentGroup): Promise<{ name: string; body: string } | null> {
  return (await isAgentWiredToChannel(group.id, CHANNEL_TYPE))
    ? { name: FORMATTING_SECTION, body: FORMATTING_BODY }
    : null;
}

// Registration order is document order: the guide, then the Rich messages extension of it.
registerProjectDocSection(formattingSection);
registerProjectDocSection(richMessagesSection);
