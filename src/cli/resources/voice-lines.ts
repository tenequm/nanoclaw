import { getDb } from '../../db/connection.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getVoiceLine, getVoiceLineOwners, isVoiceLineOwner } from '../../db/voice-lines.js';
import { getUser } from '../../modules/permissions/db/users.js';
import { registerResource, type ColumnDef } from '../crud.js';

/** The voice line's messaging group, from its platform id (`voice:<line id>`). */
async function voiceLineGroupId(line: string): Promise<string> {
  const mg = await getMessagingGroupByPlatform('voice', line);
  if (!mg) throw new Error(`no voice line ${line}; see: ncl messaging-groups list --channel-type voice`);
  return mg.id;
}

async function knownUser(userId: string): Promise<string> {
  if (!(await getUser(userId))) throw new Error(`unknown user ${userId}; see: ncl users list`);
  return userId;
}

/** A line's row plus its owner accounts, as list/get and every write return it. */
async function voiceLineView(lineId: string) {
  const row = await getVoiceLine(lineId);
  return row && { ...row, owners: await getVoiceLineOwners(lineId) };
}

const lineArg: ColumnDef = {
  name: 'line',
  type: 'string',
  description: 'The voice line, as voice:<line id>.',
  required: true,
};
const ownerArg: ColumnDef = {
  name: 'owner',
  type: 'string',
  description: 'An owner chat user id (users.id).',
  required: true,
};

registerResource({
  name: 'voice-line',
  plural: 'voice-lines',
  table: 'voice_lines',
  description:
    "Voice line owners — links a voice line to its owner's chat accounts (e.g. telegram:<id> and slack:<id> of one person), the only ones who can run /voice for it (which also sets where the line's LiveKit calls talk; the last /voice from any owner account wins). A voice line's caller is its own voice user, linked to no other account.",
  idColumn: 'line_messaging_group_id',
  columns: [
    { name: 'line_messaging_group_id', type: 'string', description: "The voice line's messaging group." },
    { name: 'owners', type: 'json', description: 'The owner accounts, as namespaced chat user ids (users.id).' },
    {
      name: 'target_messaging_group_id',
      type: 'string',
      description: 'The chat the line was pointed at by /voice; null until then.',
    },
    { name: 'thread_id', type: 'string', description: 'The thread within that chat, if any.' },
    { name: 'updated_at', type: 'string', description: 'When the row last changed.' },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      hostOnly: true,
      description: 'List voice lines with their owner accounts and /voice chat.',
      args: [],
      handler: async () => {
        const rows = await getDb().all<{ line_messaging_group_id: string }>(
          'SELECT line_messaging_group_id FROM voice_lines ORDER BY line_messaging_group_id',
        );
        return Promise.all(rows.map((r) => voiceLineView(r.line_messaging_group_id)));
      },
    },
    get: {
      access: 'open',
      hostOnly: true,
      description: 'Get a voice line with its owner accounts and /voice chat. Use: get voice:<line id>.',
      args: [{ name: 'id', type: 'string', description: 'The voice line, as voice:<line id>.', required: true }],
      handler: async (args) => {
        const view = await voiceLineView(await voiceLineGroupId(args.id as string));
        if (!view) throw new Error(`voice line ${args.id as string} has no owner; see: ncl voice-lines set`);
        return view;
      },
    },
    set: {
      access: 'approval',
      // Owning a line is holding its call link: an operator decision, never an agent's.
      hostOnly: true,
      description:
        'Make one chat account the only owner of a voice line. OPERATOR-ONLY. Keeps the /voice chat when that ' +
        'account already owned the line, else clears it (a new person starts with none). Add the same ' +
        "person's other accounts with add-owner. Use --line voice:<line id> --owner <user id>.",
      args: [lineArg, ownerArg],
      examples: ['ncl voice-lines set --line voice:0123456789ab --owner telegram:123456789'],
      handler: async (args) => {
        const lineId = await voiceLineGroupId(args.line as string);
        const owner = await knownUser(args.owner as string);
        const db = getDb();
        await db.transaction(async () => {
          const keep = await isVoiceLineOwner(lineId, owner);
          const now = new Date().toISOString();
          await db.run(
            `INSERT INTO voice_lines (line_messaging_group_id, updated_at) VALUES (?, ?)
               ON CONFLICT (line_messaging_group_id) DO NOTHING`,
            lineId,
            now,
          );
          if (!keep) {
            await db.run(
              `UPDATE voice_lines SET target_messaging_group_id = NULL, thread_id = NULL, updated_at = ?
                 WHERE line_messaging_group_id = ?`,
              now,
              lineId,
            );
          }
          await db.run('DELETE FROM voice_line_owners WHERE line_messaging_group_id = ?', lineId);
          await db.run(
            'INSERT INTO voice_line_owners (line_messaging_group_id, owner_user_id) VALUES (?, ?)',
            lineId,
            owner,
          );
        });
        return voiceLineView(lineId);
      },
    },
    'add-owner': {
      access: 'approval',
      hostOnly: true,
      description:
        "Add another chat account of the line's owner (e.g. their Slack user next to their Telegram one), so " +
        '/voice and !voice work from either. OPERATOR-ONLY. Keeps the /voice chat. ' +
        'Use --line voice:<line id> --owner <user id>.',
      args: [lineArg, ownerArg],
      examples: ['ncl voice-lines add-owner --line voice:0123456789ab --owner slack:U0123ABCD'],
      handler: async (args) => {
        const lineId = await voiceLineGroupId(args.line as string);
        const owner = await knownUser(args.owner as string);
        const db = getDb();
        await db.transaction(async () => {
          await db.run(
            `INSERT INTO voice_lines (line_messaging_group_id, updated_at) VALUES (?, ?)
               ON CONFLICT (line_messaging_group_id) DO NOTHING`,
            lineId,
            new Date().toISOString(),
          );
          await db.run(
            `INSERT INTO voice_line_owners (line_messaging_group_id, owner_user_id) VALUES (?, ?)
               ON CONFLICT (line_messaging_group_id, owner_user_id) DO NOTHING`,
            lineId,
            owner,
          );
        });
        return voiceLineView(lineId);
      },
    },
    'remove-owner': {
      access: 'approval',
      hostOnly: true,
      description:
        'Remove one owner account from a voice line. OPERATOR-ONLY. Refuses the last owner (use remove). ' +
        'Use --line voice:<line id> --owner <user id>.',
      args: [lineArg, ownerArg],
      handler: async (args) => {
        const lineId = await voiceLineGroupId(args.line as string);
        const owner = args.owner as string;
        const owners = await getVoiceLineOwners(lineId);
        if (!owners.includes(owner)) throw new Error(`${owner} does not own ${args.line as string}`);
        if (owners.length === 1) {
          throw new Error(`${owner} is the last owner of ${args.line as string}; use: ncl voice-lines remove`);
        }
        await getDb().run(
          'DELETE FROM voice_line_owners WHERE line_messaging_group_id = ? AND owner_user_id = ?',
          lineId,
          owner,
        );
        return voiceLineView(lineId);
      },
    },
    remove: {
      access: 'approval',
      hostOnly: true,
      description:
        'Remove all owners of a voice line (and its /voice chat). OPERATOR-ONLY. Use --line voice:<line id>.',
      args: [lineArg],
      handler: async (args) => {
        const lineId = await voiceLineGroupId(args.line as string);
        const db = getDb();
        const removed = await db.transaction(async () => {
          await db.run('DELETE FROM voice_line_owners WHERE line_messaging_group_id = ?', lineId);
          return (await db.run('DELETE FROM voice_lines WHERE line_messaging_group_id = ?', lineId)).changes > 0;
        });
        return { removed: removed ? args.line : null };
      },
    },
  },
});
