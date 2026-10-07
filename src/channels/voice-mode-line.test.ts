import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, updateMessagingGroup } from '../db/messaging-groups.js';
import { addMember, removeMember } from '../modules/permissions/db/agent-group-members.js';
import { createUser, updateDisplayName } from '../modules/permissions/db/users.js';
import { grantRole, isOwner } from '../modules/permissions/db/user-roles.js';
import { resolveVoiceModeLine } from './voice-mode-line.js';

const stamp = () => new Date().toISOString();

// Lines from before the voice-mode rename keep their `voice` rows and ids; env-backed new ones are `voice-mode`.
describe.each(['voice', 'voice-mode'] as const)('personal %s line access (real central DB)', (channel) => {
  const ETHAN = `${channel}:ethan-test`;
  const LAURA = `${channel}:laura-test`;

  async function line(id: string, name: string) {
    await createUser({ id, kind: channel, display_name: name, created_at: stamp() });
    await createMessagingGroup({
      id: `mg-${id}`,
      channel_type: channel,
      platform_id: id,
      instance: channel,
      name: 'Personal call',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: stamp(),
    });
    await createMessagingGroupAgent({
      id: `wire-${id}`,
      messaging_group_id: `mg-${id}`,
      agent_group_id: 'voice-agent',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: stamp(),
    });
  }
  const allow = (id: string) =>
    addMember({ user_id: id, agent_group_id: 'voice-agent', added_by: null, added_at: stamp() });

  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: 'voice-agent',
      name: 'Casa',
      folder: 'voice-access-fixture',
      agent_provider: null,
      created_at: stamp(),
    });
    await line(ETHAN, 'Ethan');
  });
  afterEach(async () => {
    await closeDb();
  });

  it('requires explicit membership and never infers ownership from a matching name', async () => {
    await createUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Ethan', created_at: stamp() });
    await grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: stamp(),
    });
    expect(await resolveVoiceModeLine(ETHAN)).toBeNull();
    await allow(ETHAN);
    const access = await resolveVoiceModeLine(ETHAN);
    expect(access).toMatchObject({
      caller: { id: ETHAN, name: 'Ethan' },
      agent: { name: 'Casa' },
      agentGroupId: 'voice-agent',
    });
    expect(await isOwner(ETHAN)).toBe(false);
  });

  it('lists the startup vocabulary on call setup only, and no names when none are configured', async () => {
    await allow(ETHAN);
    const setup = await resolveVoiceModeLine(ETHAN, undefined, { forCall: true, vocabulary: 'Acme, k8s' });
    expect(setup?.agent.vocabulary).toEqual(['Acme', 'k8s']);
    expect((await resolveVoiceModeLine(ETHAN, undefined, { vocabulary: 'Acme' }))?.agent.vocabulary).toBeUndefined();
    expect((await resolveVoiceModeLine(ETHAN, undefined, { forCall: true }))?.agent.vocabulary).toBeUndefined();
  });

  it('keeps two people distinct when they call the same agent', async () => {
    await line(LAURA, 'Laura');
    await allow(ETHAN);
    await allow(LAURA);
    const first = await resolveVoiceModeLine(ETHAN);
    const second = await resolveVoiceModeLine(LAURA);
    expect(first?.agentGroupId).toBe(second?.agentGroupId);
    expect(first?.caller).toEqual({ id: ETHAN, name: 'Ethan' });
    expect(second?.caller).toEqual({ id: LAURA, name: 'Laura' });
  });

  it('denies revoked, anonymous, and public lines', async () => {
    await allow(ETHAN);
    expect(await resolveVoiceModeLine(ETHAN)).not.toBeNull();
    await removeMember(ETHAN, 'voice-agent');
    expect(await resolveVoiceModeLine(ETHAN)).toBeNull();
    await allow(ETHAN);
    await updateDisplayName(ETHAN, ' ');
    expect(await resolveVoiceModeLine(ETHAN)).toBeNull();
    await updateDisplayName(ETHAN, 'Ethan');
    await updateMessagingGroup(`mg-${ETHAN}`, { unknown_sender_policy: 'public' });
    expect(await resolveVoiceModeLine(ETHAN)).toBeNull();
    expect(await resolveVoiceModeLine(`${channel}:unknown`)).toBeNull();
  });

  it('refuses ambiguous wiring to multiple agents', async () => {
    await allow(ETHAN);
    await createAgentGroup({
      id: 'other-agent',
      name: 'Other',
      folder: 'voice-access-other',
      agent_provider: null,
      created_at: stamp(),
    });
    await createMessagingGroupAgent({
      id: 'second-wire',
      messaging_group_id: `mg-${ETHAN}`,
      agent_group_id: 'other-agent',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 1,
      created_at: stamp(),
    });
    expect(await resolveVoiceModeLine(ETHAN)).toBeNull();
  });
});
