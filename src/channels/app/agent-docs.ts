import { isAgentWiredToChannel } from '../../db/messaging-groups.js';
import { registerProjectDocSection } from '../../project-doc-compose.js';

export function appAgentInstructions(): string {
  return [
    'Write standard markdown in the Hey Dan app (MarkdownView 4.8.5).',
    '- Headings, bold, italic, nested and task lists, links and quotes render as written.',
    '- Tables scroll sideways: keep them narrow. Use a language on fenced code; inline code works too.',
    '- `$...$` and `$$...$$` render as math and this cannot be turned off.',
    '- Put shell variables (`$HOME`), amounts with a currency symbol, and any line with two dollar signs in backticks, or write amounts as "5 USD".',
    '- Send pictures and documents with `send_file`; they appear in the thread.',
    '- Use `ask_user_question` for choices, with short option labels; buttons remain until the question timeout.',
    '- Telegram-only syntax does not apply here: no `tg://` links, `||spoiler||`, `> [!fold]` or `rich: true`.',
    '- Messages arrive whole on a phone: lead with the answer and keep paragraphs short.',
  ].join('\n');
}

registerProjectDocSection(async (group) =>
  (await isAgentWiredToChannel(group.id, 'app'))
    ? { name: 'Hey Dan app formatting', body: appAgentInstructions() }
    : null,
);
