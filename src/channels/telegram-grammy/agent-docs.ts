/**
 * Telegram prose for the agents' composed project documents: the
 * telegram-formatting skill's gate and the Rich messages section.
 *
 * Kept apart from the adapter so tests can compose a document without loading
 * the adapter: the section and its gate are pure DB reads, registered at import
 * time.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { isAgentWiredToChannel } from '../../db/messaging-groups.js';
import { registerProjectDocSection, registerResidentSkillGate } from '../../project-doc-compose.js';
import type { AgentGroup } from '../../types.js';

const CHANNEL_TYPE = 'telegram';

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

registerProjectDocSection(richMessagesSection);

// The formatting guide teaches Telegram's rendering, so only Telegram-wired agents get it.
registerResidentSkillGate('telegram-formatting', (group) => isAgentWiredToChannel(group.id, CHANNEL_TYPE));
