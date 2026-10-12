/**
 * Who a line connects, against the real central DB: the caller is whoever minted the line's link,
 * and stays one only while core grants them an owner or admin role over the line's agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { getRegisteredMigrations } from '../db/migrations/index.js';
import {
  bindVoiceModeLineChat,
  createVoiceModeLine,
  fillVoiceModeLineTts,
  getVoiceModeLine,
  mintVoiceModeLine,
  setVoiceModeLineTts,
} from '../db/voice-mode-lines.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { createUser } from '../modules/permissions/db/users.js';
import { grantRole, revokeRole } from '../modules/permissions/db/user-roles.js';
import { LINE_DEFAULT_CHOICE, TTS_DEFAULT_CHOICE } from '../voice-mode-tts.js';
import { lineIdOf, linePlatformId, resolveVoiceModeLine, sameCallerAndAgent } from './voice-mode-line.js';

const stamp = () => new Date().toISOString();
const ADMIN = 'telegram:7';
const MEMBER = 'telegram:8';

const current = async (lineId: string) => (await getVoiceModeLine(lineId))!;
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
    expect(await resolveVoiceModeLine(await mint(ADMIN))).toEqual({
      caller: { id: ADMIN, name: 'Ethan' },
      agentGroupId: 'ag-1',
      agent: { name: 'Andy' },
      linkHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      tts: LINE_DEFAULT_CHOICE,
    });
  });

  it("speaks with the line's saved choice, keeps it across a re-mint and a chat move", async () => {
    const line = await mint(ADMIN);
    const lineId = lineIdOf(line)!;
    const kore = { provider: 'gemini', model: 'gemini-3.8-flash-lite-tts', voice: 'kore' } as const;
    const saved = await setVoiceModeLineTts(lineId, kore, await current(lineId));
    expect(saved).toMatchObject({ tts_provider: 'gemini', tts_model: 'gemini-3.8-flash-lite-tts', tts_voice: 'kore' });
    expect((await resolveVoiceModeLine(line))?.tts).toEqual(kore);
    await mint(ADMIN);
    await bindVoiceModeLineChat({
      agentGroupId: 'ag-1',
      callerUserId: ADMIN,
      messagingGroupId: 'mg-2',
      threadId: null,
    });
    expect((await resolveVoiceModeLine(line))?.tts).toEqual(kore);
    expect(await setVoiceModeLineTts('000000000000', kore, await current(lineId))).toBeUndefined();
  });

  it('saves only for the link and caller a request started with', async () => {
    const lineId = lineIdOf(await mint(ADMIN))!;
    const before = await current(lineId);
    await mint(ADMIN);
    expect(await setVoiceModeLineTts(lineId, TTS_DEFAULT_CHOICE, before)).toBeUndefined();
    expect((await current(lineId)).tts_voice).toBe(LINE_DEFAULT_CHOICE.voice);
    expect(await setVoiceModeLineTts(lineId, TTS_DEFAULT_CHOICE, await current(lineId))).toMatchObject({
      tts_voice: TTS_DEFAULT_CHOICE.voice,
    });
  });

  it('stores a whole choice on every write, and reads a row from before that as it speaks', async () => {
    const nulls = () =>
      getDb().all(
        `SELECT line_id FROM voice_mode_lines
           WHERE tts_provider IS NULL OR tts_model IS NULL OR tts_voice IS NULL`,
      );
    const line = await mint(ADMIN);
    await createVoiceModeLine({ agentGroupId: 'ag-2', ownerUserId: ADMIN, messagingGroupId: 'mg-1', threadId: null });
    await mintVoiceModeLine({ agentGroupId: 'ag-3', ownerUserId: ADMIN, messagingGroupId: 'mg-1', threadId: null });
    const lineId = lineIdOf(line)!;
    const eleven = { provider: 'elevenlabs', model: 'eleven_v4', voice: 'x'.repeat(20) } as const;
    await setVoiceModeLineTts(lineId, eleven, await current(lineId));
    await setVoiceModeLineTts(lineId, LINE_DEFAULT_CHOICE, await current(lineId));
    expect(await nulls()).toEqual([]);
    await getDb().run('UPDATE voice_mode_lines SET tts_provider = NULL, tts_model = NULL, tts_voice = NULL');
    expect((await resolveVoiceModeLine(line))?.tts).toEqual(TTS_DEFAULT_CHOICE);
    expect(await nulls()).toHaveLength(3);
  });

  it('fills in what an older host wrote after a rollback, keeping every saved field and the re-mint', async () => {
    const lineId = lineIdOf(await mint(ADMIN))!;
    await setVoiceModeLineTts(
      lineId,
      { provider: 'elevenlabs', model: 'eleven_v4', voice: 'S80713fa2M70CssGEBj5' },
      await current(lineId),
    );
    // The older host's writes: a pick that left the model out, a reset, and a line created without a voice.
    await getDb().run('UPDATE voice_mode_lines SET tts_model = NULL WHERE line_id = ?', lineId);
    await mintVoiceModeLine({ agentGroupId: 'ag-2', ownerUserId: ADMIN, messagingGroupId: 'mg-1', threadId: null });
    await getDb().run(
      "UPDATE voice_mode_lines SET tts_provider = NULL, tts_model = NULL, tts_voice = NULL WHERE agent_group_id = 'ag-2'",
    );
    await getDb().run(
      `INSERT INTO voice_mode_lines (line_id, agent_group_id, token_hash, owner_user_id, created_at, updated_at)
         VALUES ('old000000000', 'ag-3', ?, ?, ?, ?)`,
      'a'.repeat(64),
      ADMIN,
      stamp(),
      stamp(),
    );
    // A provider the registry lacks is left as it is, and never counted as filled.
    await getDb().run(
      `INSERT INTO voice_mode_lines (line_id, agent_group_id, token_hash, owner_user_id, tts_provider, created_at, updated_at)
         VALUES ('old000000001', 'ag-4', ?, ?, 'openai', ?, ?)`,
      'b'.repeat(64),
      ADMIN,
      stamp(),
      stamp(),
    );
    expect(await fillVoiceModeLineTts()).toBe(3);
    expect(await fillVoiceModeLineTts()).toBe(0);
    await mint(ADMIN);
    expect(
      await getDb().all(
        'SELECT agent_group_id, tts_provider, tts_model, tts_voice FROM voice_mode_lines ORDER BY agent_group_id',
      ),
    ).toEqual([
      {
        agent_group_id: 'ag-1',
        tts_provider: 'elevenlabs',
        tts_model: 'eleven_v4_turbo',
        tts_voice: 'S80713fa2M70CssGEBj5',
      },
      { agent_group_id: 'ag-2', tts_provider: 'gemini', tts_model: 'gemini-3.8-flash-tts', tts_voice: 'alnilam' },
      { agent_group_id: 'ag-3', tts_provider: 'gemini', tts_model: 'gemini-3.8-flash-tts', tts_voice: 'alnilam' },
      { agent_group_id: 'ag-4', tts_provider: 'openai', tts_model: null, tts_voice: null },
    ]);
  });

  it('backfills every missing field with what the line spoke with', async () => {
    const backfill = getRegisteredMigrations().find((m) => m.name === 'module:voice-mode:lines-tts-concrete')!;
    for (const id of ['ag-2', 'ag-3', 'ag-4']) {
      await mintVoiceModeLine({ agentGroupId: id, ownerUserId: ADMIN, messagingGroupId: 'mg-1', threadId: null });
    }
    const set = (agent: string, provider: string | null, model: string | null, voice: string | null) =>
      getDb().run(
        'UPDATE voice_mode_lines SET tts_provider = ?, tts_model = ?, tts_voice = ? WHERE agent_group_id = ?',
        provider,
        model,
        voice,
        agent,
      );
    await set('ag-2', null, null, null);
    await set('ag-3', 'elevenlabs', null, 'S80713fa2M70CssGEBj5');
    await set('ag-4', 'gemini', 'gemini-3.8-flash-lite-tts', null);
    await (backfill.up as (db: ReturnType<typeof getDb>) => Promise<void>)(getDb());
    expect(
      await getDb().all(
        'SELECT agent_group_id, tts_provider, tts_model, tts_voice FROM voice_mode_lines ORDER BY agent_group_id',
      ),
    ).toEqual([
      { agent_group_id: 'ag-2', tts_provider: 'gemini', tts_model: 'gemini-3.8-flash-tts', tts_voice: 'alnilam' },
      {
        agent_group_id: 'ag-3',
        tts_provider: 'elevenlabs',
        tts_model: 'eleven_v4_turbo',
        tts_voice: 'S80713fa2M70CssGEBj5',
      },
      { agent_group_id: 'ag-4', tts_provider: 'gemini', tts_model: 'gemini-3.8-flash-lite-tts', tts_voice: 'alnilam' },
    ]);
  });

  it('lists the startup vocabulary on call setup only, and no names when none are configured', async () => {
    const line = await mint(ADMIN);
    expect((await resolveVoiceModeLine(line, { forCall: true, vocabulary: 'Acme, k8s' }))?.agent.vocabulary).toEqual([
      'Acme',
      'k8s',
    ]);
    expect((await resolveVoiceModeLine(line, { vocabulary: 'Acme' }))?.agent.vocabulary).toBeUndefined();
    expect((await resolveVoiceModeLine(line, { forCall: true }))?.agent.vocabulary).toBeUndefined();
  });

  it('denies a caller whose role was revoked, a plain member, and unknown lines', async () => {
    const line = await mint(ADMIN);
    await revokeRole(ADMIN, 'admin', 'ag-1');
    expect(await resolveVoiceModeLine(line)).toBeNull();
    expect(await resolveVoiceModeLine(await mint(MEMBER))).toBeNull();
    expect(await resolveVoiceModeLine('voice-mode:000000000000')).toBeNull();
    expect(await resolveVoiceModeLine('telegram:7')).toBeNull();
  });

  it('ends a call once its link is re-minted, even by the same caller', async () => {
    const line = await mint(ADMIN);
    const before = (await resolveVoiceModeLine(line))!;
    expect(sameCallerAndAgent(before, (await resolveVoiceModeLine(line))!)).toBe(true);
    await mint(ADMIN);
    expect(sameCallerAndAgent(before, (await resolveVoiceModeLine(line))!)).toBe(false);
  });

  it('keeps a call going when /voice only moves the line to another chat', async () => {
    const line = await mint(ADMIN);
    const before = (await resolveVoiceModeLine(line))!;
    await bindVoiceModeLineChat({
      agentGroupId: 'ag-1',
      callerUserId: ADMIN,
      messagingGroupId: 'mg-2',
      threadId: null,
    });
    expect(sameCallerAndAgent(before, (await resolveVoiceModeLine(line))!)).toBe(true);
  });

  it('names the caller by id when the user has no display name, and ends a call when someone else re-mints', async () => {
    const line = await mint(ADMIN);
    const before = (await resolveVoiceModeLine(line))!;
    await grantRole({ user_id: MEMBER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: stamp() });
    expect(await mint(MEMBER)).toBe(line);
    const after = (await resolveVoiceModeLine(line))!;
    expect(after.caller).toEqual({ id: MEMBER, name: MEMBER });
    expect(sameCallerAndAgent(before, after)).toBe(false);
  });
});
