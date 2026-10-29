import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSlackAdapter } from '@chat-adapter/slack';
import type { StateAdapter } from 'chat';
import { describe, expect, it, vi } from 'vitest';

import { appendRawText, applyTextRewrite } from './chat-sdk-bridge.js';
import {
  createSlackMentionRewriter,
  extractSlackRawText,
  slackMentionAnnotator,
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

/** A state holding the adapter's user cache entries (`slack:user:<id>`) for these display names. */
function userCache(names: Record<string, string>): StateAdapter & { get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(async (key: string) => {
    const name = names[key.replace(/^slack:user:/, '')];
    return name ? { displayName: name } : null;
  });
  return { get } as unknown as StateAdapter & { get: typeof get };
}

/** In-memory StateAdapter covering the calls the Slack adapter's user lookup makes. */
function memoryState(): StateAdapter {
  const kv = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  return {
    get: async (key: string) => kv.get(key) ?? null,
    set: async (key: string, value: unknown) => void kv.set(key, value),
    getList: async (key: string) => lists.get(key) ?? [],
    appendToList: async (key: string, value: unknown) => void lists.set(key, [...(lists.get(key) ?? []), value]),
  } as unknown as StateAdapter;
}

const annotate = (text: string, mentions: Array<[string, string]>): string => slackMentionAnnotator(mentions)()(text);

describe('Slack mention ids', () => {
  it('collects mentioned user ids per occurrence, in order, with or without a label', () => {
    expect(slackMentionedUserIds({ text: `<@${BOT}> hi <@${BORIS}|boris> and <@${BORIS}> <#C1|general>` })).toEqual([
      BOT,
      BORIS,
      BORIS,
    ]);
    expect(slackMentionedUserIds({ text: 'no mentions' })).toEqual([]);
    expect(slackMentionedUserIds({})).toEqual([]);
  });

  it('appends the id to each rendered display name', () => {
    expect(annotate(`@${BOT} привітайся з @Boris Faktorovich`, [[BORIS, 'Boris Faktorovich']])).toBe(
      `@${BOT} привітайся з @Boris Faktorovich (<@${BORIS}>)`,
    );
  });

  it('prefers the longer of two names sharing a prefix and never matches inside a longer word', () => {
    expect(
      annotate('@Bob and @Bo, not @Bobby or ops@Bob.com', [
        ['U1', 'Bo'],
        ['U2', 'Bob'],
      ]),
    ).toBe('@Bob (<@U2>) and @Bo (<@U1>), not @Bobby or ops@Bob.com');
  });

  it('pairs mentions sharing one display name with their ids in order, repeats included', () => {
    const mentions: Array<[string, string]> = [
      ['U1', 'Alex'],
      ['U2', 'Alex'],
      ['U1', 'Alex'],
    ];
    expect(annotate('@Alex meet @Alex, said @Alex', mentions)).toBe(
      '@Alex (<@U1>) meet @Alex (<@U2>), said @Alex (<@U1>)',
    );
  });

  it('keeps the pairing across the text nodes of one rendering and restarts it per rendering', () => {
    const mentions: Array<[string, string]> = [
      ['U1', 'Alex'],
      ['U2', 'Alex'],
    ];
    const serialized: Record<string, unknown> = {
      text: '@Alex says hi @Alex',
      formatted: {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'text', value: '@Alex says ' },
              { type: 'strong', children: [{ type: 'text', value: 'hi' }] },
              { type: 'text', value: ' @Alex' },
            ],
          },
        ],
      },
    };
    applyTextRewrite(serialized, slackMentionAnnotator(mentions));
    expect(serialized.text).toBe('@Alex (<@U1>) says hi @Alex (<@U2>)');
    expect(JSON.stringify(serialized.formatted)).toContain('"@Alex (<@U1>) says "');
    expect(JSON.stringify(serialized.formatted)).toContain('" @Alex (<@U2>)"');
  });

  it('escapes regex syntax in names and leaves annotated mentions alone', () => {
    const mentions: Array<[string, string]> = [['U1', 'a.b (ops)']];
    expect(annotate('@a.b (ops) and @axb (ops)', mentions)).toBe('@a.b (ops) (<@U1>) and @axb (ops)');
    expect(annotate('@a.b (ops) (<@U1>)', mentions)).toBe('@a.b (ops) (<@U1>)');
  });

  it('reads names from the adapter cache only, skipping the bot itself and uncached users', async () => {
    const state = userCache({ [BORIS]: 'Boris Faktorovich' });
    const rewriter = createSlackMentionRewriter(() => BOT);

    expect(await rewriter({ text: `<@${BOT}> hi` }, state)).toBeNull();
    expect(state.get).not.toHaveBeenCalled();
    expect(await rewriter({ text: `<@${BOT}> hi <@U0NOBODY>` }, state)).toBeNull();

    const rewrite = await rewriter({ text: `<@${BOT}> hi <@${BORIS}> and <@${BORIS}>` }, state);
    expect(rewrite?.()(`@${BOT} hi @Boris Faktorovich and @Boris Faktorovich`)).toBe(
      `@${BOT} hi @Boris Faktorovich (<@${BORIS}>) and @Boris Faktorovich (<@${BORIS}>)`,
    );
    expect(state.get.mock.calls.filter(([key]) => key === `slack:user:${BORIS}`)).toHaveLength(1);
  });

  // Runs the installed adapter's own inbound parse and user cache, so an
  // adapter bump that changes how mentions render or where it caches the
  // names fails here.
  it('keeps the mentioned user id through the real adapter parse, in text and formatted', async () => {
    const adapter = createSlackAdapter({ botToken: 'xoxb-test', signingSecret: 'test-secret', botUserId: BOT });
    const usersInfo = vi.fn(async ({ user }: { user: string }) => ({
      ok: true,
      user: { id: user, profile: { display_name: user === BORIS ? 'Boris Faktorovich' : 'wisdom-agent' } },
    }));
    const state = memoryState();
    const internals = adapter as unknown as {
      _client: { users: { info: typeof usersInfo } };
      chat: { getState(): StateAdapter };
      parseSlackMessage(e: unknown, t: string): Promise<{ toJSON(): unknown }>;
    };
    internals._client.users.info = usersInfo;
    internals.chat = { getState: () => state };
    const event = {
      type: 'message',
      channel: 'C1',
      user: 'U0SENDER',
      ts: '1.0',
      text: `<@${BOT}> привітайся з <@${BORIS}>`,
    };

    const message = await internals.parseSlackMessage(event, 'slack:C1:1.0');
    const serialized = message.toJSON() as Record<string, unknown>;
    const calls = usersInfo.mock.calls.length;
    const rewrite = await createSlackMentionRewriter(() => adapter.botUserId)(event, state);
    applyTextRewrite(serialized, rewrite!);

    const expected = `@${BOT} привітайся з @Boris Faktorovich (<@${BORIS}>)`;
    expect(serialized.text).toBe(expected);
    expect(JSON.stringify(serialized.formatted)).toContain(JSON.stringify(expected).slice(1, -1));
    expect(usersInfo.mock.calls.length).toBe(calls);
  });
});
