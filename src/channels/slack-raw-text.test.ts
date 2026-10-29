import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSlackAdapter } from '@chat-adapter/slack';
import { describe, expect, it, vi } from 'vitest';

import { appendRawText, applyTextRewrite } from './chat-sdk-bridge.js';
import {
  annotateSlackMentions,
  createSlackMentionRewriter,
  extractSlackRawText,
  slackMentionedUserIds,
} from './slack-raw-text.js';

const pastedTableEvent = {
  text: 'Analyze this attendee list:',
  attachments: [
    {
      fallback: '[no preview available]',
      blocks: [
        {
          type: 'table',
          rows: [
            [
              {
                type: 'rich_text',
                elements: [
                  {
                    type: 'rich_text_section',
                    elements: [{ type: 'text', text: 'Company', style: { bold: true } }],
                  },
                ],
              },
              {
                type: 'rich_text',
                elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Title' }] }],
              },
            ],
            [
              { type: 'raw_text', text: 'Agria Pet Insurance' },
              { type: 'raw_text', text: 'Head of IT Operations' },
            ],
            [
              { type: 'raw_text', text: 'AVEVA' },
              { type: 'raw_text', text: 'Head of Cyber Security Risk and Assurance' },
            ],
          ],
        },
      ],
    },
  ],
};

describe('Slack pasted-table ingestion', () => {
  it('flattens table attachment blocks into readable rows', () => {
    expect(extractSlackRawText(pastedTableEvent)).toBe(
      [
        'Company | Title',
        'Agria Pet Insurance | Head of IT Operations',
        'AVEVA | Head of Cyber Security Risk and Assurance',
      ].join('\n'),
    );
  });

  it('ignores ordinary attachments and malformed table blocks', () => {
    expect(extractSlackRawText({ text: 'hello' })).toBeNull();
    expect(extractSlackRawText({ attachments: [{ fallback: 'link preview' }] })).toBeNull();
    expect(extractSlackRawText({ attachments: [{ blocks: [{ type: 'table', rows: 'bad' }] }] })).toBeNull();
  });

  it('appends rescued rows to the user text before raw payload removal', () => {
    const serialized: Record<string, unknown> = { text: 'Analyze this attendee list:' };
    appendRawText(serialized, pastedTableEvent, extractSlackRawText);
    expect(serialized.text).toContain('Analyze this attendee list:\n\nCompany | Title');
    expect(serialized.text).toContain('Agria Pet Insurance | Head of IT Operations');
  });

  it('caps unexpectedly large pasted tables', () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => [
      { type: 'raw_text', text: `row-${index}-with-padding` },
    ]);
    const text = extractSlackRawText({ attachments: [{ blocks: [{ type: 'table', rows }] }] });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(100_000);
    expect(text).toContain('[table truncated]');
  });

  it('keeps the default Slack factory wired to the extractor', () => {
    const source = readFileSync(join(new URL('.', import.meta.url).pathname, 'slack.ts'), 'utf8');
    expect(source).toContain("import { createSlackMentionRewriter, extractSlackRawText } from './slack-raw-text.js';");
    expect(source).toContain('extractRawText: extractSlackRawText');
    expect(source).toContain('rewriteInboundText: createSlackMentionRewriter(');
  });
});

const BOT = 'U0CD6UYAJ2W';
const BORIS = 'U0CB953FS91';

describe('Slack mention ids', () => {
  it('collects mentioned user ids once each, in order, with or without a label', () => {
    expect(slackMentionedUserIds({ text: `<@${BOT}> hi <@${BORIS}|boris> and <@${BORIS}> <#C1|general>` })).toEqual([
      BOT,
      BORIS,
    ]);
    expect(slackMentionedUserIds({ text: 'no mentions' })).toEqual([]);
    expect(slackMentionedUserIds({})).toEqual([]);
  });

  it('appends the id to each rendered display name', () => {
    const names = new Map([[BORIS, 'Boris Faktorovich']]);
    expect(annotateSlackMentions(`@${BOT} привітайся з @Boris Faktorovich`, names)).toBe(
      `@${BOT} привітайся з @Boris Faktorovich (<@${BORIS}>)`,
    );
  });

  it('prefers the longer of two names sharing a prefix and never matches inside a longer word', () => {
    const names = new Map([
      ['U1', 'Bo'],
      ['U2', 'Bob'],
    ]);
    expect(annotateSlackMentions('@Bob and @Bo, not @Bobby', names)).toBe('@Bob (<@U2>) and @Bo (<@U1>), not @Bobby');
  });

  it('pairs ids sharing one display name with its occurrences in order', () => {
    const names = new Map([
      ['U1', 'Alex'],
      ['U2', 'Alex'],
    ]);
    expect(annotateSlackMentions('@Alex meet @Alex', names)).toBe('@Alex (<@U1>) meet @Alex (<@U2>)');
  });

  it('escapes regex syntax in names and leaves annotated mentions alone', () => {
    const names = new Map([['U1', 'a.b (ops)']]);
    expect(annotateSlackMentions('@a.b (ops) and @axb (ops)', names)).toBe('@a.b (ops) (<@U1>) and @axb (ops)');
    expect(annotateSlackMentions('@a.b (ops) (<@U1>)', names)).toBe('@a.b (ops) (<@U1>)');
  });

  it('skips the bot itself and users whose lookup failed', async () => {
    const lookup = vi.fn(async (id: string) => (id === BORIS ? 'Boris Faktorovich' : null));
    const rewriter = createSlackMentionRewriter(lookup, () => BOT);

    expect(await rewriter({ text: `<@${BOT}> hi` })).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    expect(await rewriter({ text: `<@${BOT}> hi <@U0NOBODY>` })).toBeNull();

    const rewrite = await rewriter({ text: `<@${BOT}> hi <@${BORIS}>` });
    expect(rewrite?.(`@${BOT} hi @Boris Faktorovich`)).toBe(`@${BOT} hi @Boris Faktorovich (<@${BORIS}>)`);
  });

  // Runs the installed adapter's own inbound parse, so an adapter bump that
  // changes how mentions render fails here.
  it('keeps the mentioned user id through the real adapter parse, in text and formatted', async () => {
    const adapter = createSlackAdapter({ botToken: 'xoxb-test', signingSecret: 'test-secret', botUserId: BOT });
    const usersInfo = vi.fn(async ({ user }: { user: string }) => ({
      ok: true,
      user: { id: user, profile: { display_name: user === BORIS ? 'Boris Faktorovich' : 'wisdom-agent' } },
    }));
    (adapter as unknown as { _client: { users: { info: typeof usersInfo } } })._client.users.info = usersInfo;
    const event = {
      type: 'message',
      channel: 'C1',
      user: 'U0SENDER',
      ts: '1.0',
      text: `<@${BOT}> привітайся з <@${BORIS}>`,
    };

    const message = await (
      adapter as unknown as { parseSlackMessage(e: unknown, t: string): Promise<{ toJSON(): unknown }> }
    ).parseSlackMessage(event, 'slack:C1:1.0');
    const serialized = message.toJSON() as Record<string, unknown>;
    const rewrite = await createSlackMentionRewriter(
      async (id) => (await adapter.getUser(id))?.userName,
      () => adapter.botUserId,
    )(event);
    applyTextRewrite(serialized, rewrite!);

    const expected = `@${BOT} привітайся з @Boris Faktorovich (<@${BORIS}>)`;
    expect(serialized.text).toBe(expected);
    expect(JSON.stringify(serialized.formatted)).toContain(JSON.stringify(expected).slice(1, -1));
  });
});
