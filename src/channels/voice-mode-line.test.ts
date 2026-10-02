/**
 * Who a line connects, against the real central DB: the caller is whoever minted the line's link,
 * and stays one only while core grants them an owner or admin role over the line's agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { bindVoiceModeLineChat, mintVoiceModeLine } from '../db/voice-mode-lines.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { createUser } from '../modules/permissions/db/users.js';
import { grantRole, revokeRole } from '../modules/permissions/db/user-roles.js';
import { linePlatformId, resolveVoiceLine, sameCallerAndAgent } from './voice-mode-line.js';

const stamp = () => new Date().toISOString();
const ADMIN = 'telegram:7';
const MEMBER = 'telegram:8';

const mint = async (owner: string) =>
  linePlatformId(
    (await mintVoiceModeLine({ agentGroupId: 'ag-1', ownerUserId: owner, messagingGroupId: 'mg-1', threadId: null }))
      .line.line_id,
  );

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Andy',
    folder: 'voice-line-fixture',
    agent_provider: null,
    created_at: stamp(),
  });
  await createUser({ id: ADMIN, kind: 'telegram', display_name: 'Ethan', created_at: stamp() });
  await createUser({ id: MEMBER, kind: 'telegram', display_name: null, created_at: stamp() });
  await grantRole({ user_id: ADMIN, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: stamp() });
  await addMember({ user_id: MEMBER, agent_group_id: 'ag-1', added_by: null, added_at: stamp() });
});
afterEach(async () => {
  await closeDb();
});

describe('voice line access (real central DB)', () => {
  it("resolves the line's agent and its caller, the user who minted the link", async () => {
    expect(await resolveVoiceLine(await mint(ADMIN))).toEqual({
      caller: { id: ADMIN, name: 'Ethan' },
      agentGroupId: 'ag-1',
      agent: { name: 'Andy' },
      linkHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('lists the startup vocabulary on call setup only, and no names when none are configured', async () => {
    const line = await mint(ADMIN);
    expect((await resolveVoiceLine(line, { forCall: true, vocabulary: 'Acme, k8s' }))?.agent.vocabulary).toEqual([
      'Acme',
      'k8s',
    ]);
    expect((await resolveVoiceLine(line, { vocabulary: 'Acme' }))?.agent.vocabulary).toBeUndefined();
    expect((await resolveVoiceLine(line, { forCall: true }))?.agent.vocabulary).toBeUndefined();
  });

  it('denies a caller whose role was revoked, a plain member, and unknown lines', async () => {
    const line = await mint(ADMIN);
    await revokeRole(ADMIN, 'admin', 'ag-1');
    expect(await resolveVoiceLine(line)).toBeNull();
    expect(await resolveVoiceLine(await mint(MEMBER))).toBeNull();
    expect(await resolveVoiceLine('voice-mode:000000000000')).toBeNull();
    expect(await resolveVoiceLine('telegram:7')).toBeNull();
  });

  it('ends a call once its link is re-minted, even by the same caller', async () => {
    const line = await mint(ADMIN);
    const before = (await resolveVoiceLine(line))!;
    expect(sameCallerAndAgent(before, (await resolveVoiceLine(line))!)).toBe(true);
    await mint(ADMIN);
    expect(sameCallerAndAgent(before, (await resolveVoiceLine(line))!)).toBe(false);
  });

  it('keeps a call going when /voice only moves the line to another chat', async () => {
    const line = await mint(ADMIN);
    const before = (await resolveVoiceLine(line))!;
    await bindVoiceModeLineChat({ agentGroupId: 'ag-1', messagingGroupId: 'mg-2', threadId: null });
    expect(sameCallerAndAgent(before, (await resolveVoiceLine(line))!)).toBe(true);
  });

  it('names the caller by id when the user has no display name, and ends a call when someone else re-mints', async () => {
    const line = await mint(ADMIN);
    const before = (await resolveVoiceLine(line))!;
    await grantRole({ user_id: MEMBER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: stamp() });
    expect(await mint(MEMBER)).toBe(line);
    const after = (await resolveVoiceLine(line))!;
    expect(after.caller).toEqual({ id: MEMBER, name: MEMBER });
    expect(sameCallerAndAgent(before, after)).toBe(false);
  });
});
