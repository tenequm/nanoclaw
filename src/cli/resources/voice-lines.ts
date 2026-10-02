import { getDb } from '../../db/connection.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getUser } from '../../modules/permissions/db/users.js';
import { registerResource } from '../crud.js';

/** The voice line's messaging group, from its platform id (`voice:<line id>`). */
async function voiceLineGroupId(line: string): Promise<string> {
  const mg = await getMessagingGroupByPlatform('voice', line);
  if (!mg) throw new Error(`no voice line ${line}; see: ncl messaging-groups list --channel-type voice`);
  return mg.id;
}

registerResource({
  name: 'voice-line',
  plural: 'voice-lines',
  table: 'voice_lines',
  description:
    "Voice line owner — links a voice line to its owner's chat user, the only one who can run /voice for it (which also sets where the line's LiveKit calls talk). A voice line's caller is its own voice user, linked to no other account.",
  idColumn: 'line_messaging_group_id',
  columns: [
    { name: 'line_messaging_group_id', type: 'string', description: "The voice line's messaging group." },
    { name: 'owner_user_id', type: 'string', description: 'The owner, as a namespaced chat user id (users.id).' },
    {
      name: 'target_messaging_group_id',
      type: 'string',
      description: 'The chat the line was pointed at by /voice; null until then.',
    },
    { name: 'thread_id', type: 'string', description: 'The thread within that chat, if any.' },
    { name: 'updated_at', type: 'string', description: 'When the row last changed.' },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    set: {
      access: 'approval',
      // Owning a line is holding its call link: an operator decision, never an agent's.
      hostOnly: true,
      description:
        'Set the owner of a voice line. OPERATOR-ONLY. A new owner starts with no /voice chat. ' +
        'Use --line voice:<line id> --owner <user id>.',
      args: [
        { name: 'line', type: 'string', description: 'The voice line, as voice:<line id>.', required: true },
        { name: 'owner', type: 'string', description: "The owner's chat user id (users.id).", required: true },
      ],
      examples: ['ncl voice-lines set --line voice:0123456789ab --owner telegram:123456789'],
      handler: async (args) => {
        const lineId = await voiceLineGroupId(args.line as string);
        const owner = args.owner as string;
        if (!(await getUser(owner))) throw new Error(`unknown user ${owner}; see: ncl users list`);
        await getDb().run(
          `INSERT INTO voice_lines (line_messaging_group_id, owner_user_id, updated_at) VALUES (?, ?, ?)
             ON CONFLICT (line_messaging_group_id) DO UPDATE SET
               owner_user_id = excluded.owner_user_id,
               target_messaging_group_id = CASE WHEN voice_lines.owner_user_id = excluded.owner_user_id
                 THEN voice_lines.target_messaging_group_id END,
               thread_id = CASE WHEN voice_lines.owner_user_id = excluded.owner_user_id
                 THEN voice_lines.thread_id END,
               updated_at = excluded.updated_at`,
          lineId,
          owner,
          new Date().toISOString(),
        );
        return getDb().get('SELECT * FROM voice_lines WHERE line_messaging_group_id = ?', lineId);
      },
    },
    remove: {
      access: 'approval',
      hostOnly: true,
      description: 'Remove the owner of a voice line (and its /voice chat). OPERATOR-ONLY. Use --line voice:<line id>.',
      args: [{ name: 'line', type: 'string', description: 'The voice line, as voice:<line id>.', required: true }],
      handler: async (args) => {
        const lineId = await voiceLineGroupId(args.line as string);
        const result = await getDb().run('DELETE FROM voice_lines WHERE line_messaging_group_id = ?', lineId);
        return { removed: result.changes > 0 ? args.line : null };
      },
    },
  },
});
