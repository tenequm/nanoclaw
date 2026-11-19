import {
  enrollMachine,
  getMachine,
  listMachines,
  revokeMachine,
  setMeshMembership,
} from '../../channels/peer/store.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'peer machine',
  plural: 'peers',
  table: 'peer_machines',
  idColumn: 'id',
  description: 'Machines enrolled to connect to the peer hub.',
  columns: [],
  operations: {},
  customOperations: {
    add: {
      hostOnly: true,
      access: 'open',
      description: 'Enroll a machine with its P-256 public key.',
      args: [
        { name: 'name', type: 'string', required: true, description: 'Machine name.' },
        { name: 'public_key', type: 'string', required: true, description: 'Base64url-encoded SPKI DER public key.' },
      ],
      handler: async ({ name, public_key }) => ({ id: await enrollMachine(String(name), String(public_key)), name }),
    },
    list: {
      hostOnly: true,
      access: 'open',
      args: [],
      description: 'List machine ids, names, last contact and revocation times.',
      handler: listMachines,
    },
    revoke: {
      hostOnly: true,
      access: 'open',
      description: 'Revoke the enrollment identified by its machine id.',
      args: [{ name: 'id', type: 'string', required: true, description: 'Machine id from peers list.' }],
      handler: async ({ id }) => {
        if (!(await getMachine(String(id)))) throw new Error('Unknown machine id');
        const changed = await revokeMachine(String(id));
        return { id, status: changed ? 'revoked' : 'already_revoked' };
      },
    },
  },
});

function membershipOperation(member: boolean) {
  return {
    hostOnly: true,
    access: 'open' as const,
    description: member ? 'Add an agent group to the mesh.' : 'Remove an agent group from the mesh.',
    args: [{ name: 'id', type: 'string' as const, required: true, description: 'Agent group id or display name.' }],
    handler: async ({ id }: Record<string, unknown>) => {
      const value = String(id);
      let groupId = (await getAgentGroup(value))?.id;
      if (!groupId) {
        const matches = await getDb().all<{ id: string }>(
          'SELECT id FROM agent_groups WHERE lower(name) = lower(?) ORDER BY id',
          value,
        );
        if (matches.length > 1)
          throw new Error('Ambiguous agent name. Choose an id: ' + matches.map((m) => m.id).join(', '));
        if (!matches.length) throw new Error('Unknown agent group');
        groupId = matches[0].id;
      }
      await setMeshMembership(groupId, member);
      return { agent_group_id: groupId, member };
    },
  };
}

registerResource({
  name: 'mesh',
  plural: 'mesh',
  table: 'mesh_members',
  idColumn: 'agent_group_id',
  description: 'Agent membership in the peer mesh.',
  columns: [],
  operations: {},
  customOperations: { add: membershipOperation(true), remove: membershipOperation(false) },
});
