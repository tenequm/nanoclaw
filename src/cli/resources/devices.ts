import type { DeviceRow } from '../../modules/device-auth/db.js';
import { getDb } from '../../db/connection.js';
import { mintPairingLink } from '../../modules/device-auth/pairing.js';
import { revokeDevice } from '../../modules/device-auth/verify.js';
import { registerResource } from '../crud.js';
export async function listDevices(userId: string): Promise<DeviceRow[]> {
  return getDb().all<DeviceRow>('SELECT * FROM device_auth_devices WHERE user_id = ? ORDER BY created_at, id', userId);
}
registerResource({
  name: 'device',
  plural: 'devices',
  table: 'device_auth_devices',
  idColumn: 'id',
  description: 'Paired app devices.',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      hostOnly: true,
      description: 'List devices for a user.',
      args: [{ name: 'user', type: 'string', required: true, description: 'User id.' }],
      handler: (args) => listDevices(args.user as string),
    },
    pair: {
      access: 'open',
      hostOnly: true,
      description: 'Mint a one-time pairing link.',
      args: [
        { name: 'user', type: 'string', required: true, description: 'User id.' },
        { name: 'agents', type: 'string', required: true, description: 'Comma-separated agent ids.' },
      ],
      handler: (args) => {
        const ids = (args.agents as string)
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        if (!ids.length) throw new Error('--agents must name at least one agent');
        return mintPairingLink(args.user as string, [...new Set(ids)]);
      },
      formatHuman: (data) => String(data),
    },
    revoke: {
      access: 'open',
      hostOnly: true,
      description: 'Revoke a device.',
      args: [{ name: 'id', type: 'string', required: true, description: 'Device id.' }],
      handler: async (args) => {
        const status = await revokeDevice(args.id as string);
        if (status === 'not_found') throw new Error('No such device');
        return { revoked: args.id, status, message: status === 'already_revoked' ? 'Already revoked' : 'Revoked' };
      },
    },
  },
});
