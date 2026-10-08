import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-project-doc-compose-test';
const REPO_ROOT = process.cwd();

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// The jev gate reads `<DATA_DIR>/jev-gate.json`; keep it inside the test root.
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-project-doc-compose-test/data',
}));

import {
  ensureContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from './db/container-configs.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { createVoiceModeLine } from './db/voice-mode-lines.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import { log } from './log.js';
import {
  BASE_INSTRUCTIONS_PATH,
  composeGroupProjectDoc,
  DEFAULT_PROJECT_DOC,
  MEMORY_NOTE_PLACEHOLDER,
  renderBaseInstructions,
  type ProjectDocSpec,
} from './project-doc-compose.js';
import type { AgentGroup } from './types.js';
// Side-effect imports: the host modules whose per-agent registrations are under test.
import { resetGateConfigCache, writeGateEntry } from './modules/jev-gate/index.js';
import './channels/voice-mode.js';

const CLAUDE_SPEC: ProjectDocSpec = {
  fileName: 'CLAUDE.md',
};

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function groupDirOf(folder: string): string {
  return path.join(TEST_ROOT, folder);
}

async function seed(id: string, folder: string): Promise<AgentGroup> {
  const ag = group(id, folder);
  await createAgentGroup(ag);
  await ensureContainerConfig(ag.id);
  fs.mkdirSync(groupDirOf(folder), { recursive: true });
  return ag;
}

function writePersona(folder: string, text: string): void {
  fs.writeFileSync(path.join(groupDirOf(folder), PERSONA_PREPEND_FILE), text);
}

async function compose(ag: AgentGroup, spec: ProjectDocSpec = CLAUDE_SPEC): Promise<string> {
  await composeGroupProjectDoc(ag, groupDirOf(ag.folder), spec);
  return fs.readFileSync(path.join(groupDirOf(ag.folder), spec.fileName), 'utf-8');
}

/** Run `fn` with cwd at a root whose `container/` is the real tree, shipped skills included. */
async function withRealContainer<T>(fn: () => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(TEST_ROOT, 'real-skills-'));
  fs.mkdirSync(path.join(root, 'container'));
  for (const entry of ['CLAUDE.md', 'agent-runner', 'skills']) {
    fs.symlinkSync(path.join(REPO_ROOT, 'container', entry), path.join(root, 'container', entry));
  }
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(previousCwd);
  }
}

function realSkill(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'container', 'skills', name, 'instructions.md'), 'utf-8').trim();
}

/** One composed section, up to the next composed heading; the base has headings of its own. */
function composedSection(doc: string, name: string): string {
  const start = doc.indexOf(`# ${name}\n\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start);
  const next = rest.slice(1).search(/\n\n# (NanoClaw (Module|Skill): |MCP Server: |Native Runtime Skills\n)/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const sourceRoot = path.join(TEST_ROOT, 'source');
  const skillDir = path.join(sourceRoot, 'container', 'skills', 'fixture-gateway');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'instructions.md'), 'Fixture credential guidance.');
  for (const entry of ['CLAUDE.md', 'agent-runner']) {
    fs.symlinkSync(path.join(REPO_ROOT, 'container', entry), path.join(sourceRoot, 'container', entry));
  }
  process.chdir(sourceRoot);
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  process.chdir(REPO_ROOT);
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('composeGroupProjectDoc delivery', () => {
  // The regression guard for the bug this composer was rewritten to fix: an
  // `@` import whose target resolves outside the project directory is dropped
  // by Claude Code silently, so the document must not contain one at all.
  it('emits no @ import lines', async () => {
    const ag = await seed('ag-flat', 'flat-group');

    const doc = await compose(ag);

    expect(doc.split('\n').filter((line) => line.startsWith('@'))).toEqual([]);
  });

  it('creates no fragment directory or shared-base symlink', async () => {
    const ag = await seed('ag-artifacts', 'artifacts-group');

    await compose(ag);

    const entries = fs.readdirSync(groupDirOf(ag.folder));
    expect(entries).not.toContain('.claude-fragments');
    expect(entries).not.toContain('.claude-shared.md');
  });

  it('inlines the shared base document, module instructions and resident skill prose', async () => {
    const ag = await seed('ag-inline', 'inline-group');

    const doc = await compose(ag);

    // Whole files, not sentinel phrases: a heading proves a section was
    // emitted, only the body proves the file was read, and reading the source
    // here means adding a paragraph to it cannot break this test.
    const read = (...p: string[]): string => fs.readFileSync(path.join(process.cwd(), ...p), 'utf-8').trim();
    expect(doc).toContain(renderBaseInstructions(read('container', 'CLAUDE.md')));
    expect(doc).toContain(read('container', 'skills', 'fixture-gateway', 'instructions.md'));
    expect(doc).toContain(read('container', 'agent-runner', 'src', 'mcp-tools', 'cli.instructions.md'));
    expect(doc).toContain(read('container', 'agent-runner', 'src', 'mcp-tools', 'core.instructions.md'));
  });

  it('inlines MCP server instructions from the container config', async () => {
    const ag = await seed('ag-mcp', 'mcp-group');
    await updateContainerConfigJson(ag.id, 'mcp_servers', {
      tooling: { command: 'x', args: [], instructions: 'use the tooling server for builds' },
    });

    const doc = await compose(ag);

    expect(doc).toContain('# MCP Server: tooling');
    expect(doc).toContain('use the tooling server for builds');
  });

  // `.claude/skills/migrate-memory` classifies a staged legacy project doc as
  // generated boilerplate by this prefix. Nothing else guards the composer side.
  it('starts with the composed-at-spawn marker', async () => {
    const ag = await seed('ag-marker', 'marker-group');

    const doc = await compose(ag);

    expect(doc.startsWith('<!-- Composed at spawn')).toBe(true);
    // A heading here instead of a comment would make the header the document's
    // first section and displace the persona.
    expect(doc.split('\n').find((l) => l.startsWith('# '))).not.toBe('# Composed at spawn');
  });

  it('never reads agent-authored files under the group directory except the persona', async () => {
    const ag = await seed('ag-memory', 'memory-group');
    const memoryDir = path.join(groupDirOf(ag.folder), 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'index.md'), 'must not enter the project document');

    const doc = await compose(ag);

    expect(doc).not.toContain('must not enter the project document');
  });
});

describe('composeGroupProjectDoc temp-file safety', () => {
  // The group dir is the agent's read-write working directory, so anything the
  // composer writes there by a guessable name is a path the agent can pre-plant.
  // Red if writeAtomic goes back to a predictable name or drops the 'wx' flag.
  it('does not follow a symlink planted where the temp file used to land', async () => {
    const ag = await seed('ag-squat', 'squat-group');
    const victim = path.join(TEST_ROOT, 'victim.txt');
    fs.writeFileSync(victim, 'ORIGINAL');
    // Exactly the name the old implementation used, and the pid is stable for
    // the life of the host process.
    const squat = path.join(groupDirOf(ag.folder), `CLAUDE.md.tmp-${process.pid}`);
    fs.symlinkSync(victim, squat);

    const doc = await compose(ag);

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(doc).toContain('# NanoClaw Runtime Contract');
    expect(fs.lstatSync(squat).isSymbolicLink()).toBe(true); // left alone, not ours
  });

  // A directory squatting the temp path used to make the finally-rm throw
  // ERR_FS_EISDIR, which rides wakeContainer's retry and darks the group forever.
  it('composes even when a directory occupies the old temp path', async () => {
    const ag = await seed('ag-squat-dir', 'squat-dir-group');
    fs.mkdirSync(path.join(groupDirOf(ag.folder), `CLAUDE.md.tmp-${process.pid}`), { recursive: true });

    await expect(compose(ag)).resolves.toContain('# NanoClaw Runtime Contract');
  });

  it('leaves no temp file behind', async () => {
    const ag = await seed('ag-tmp', 'tmp-group');

    await compose(ag);

    expect(fs.readdirSync(groupDirOf(ag.folder)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('composeGroupProjectDoc corrupt skill selection', () => {
  // The sibling column (mcp_servers) is re-validated; this one used to be a bare
  // cast, so a stored string turned the filter into a substring match and a
  // stored null threw on every spawn. Red if parseSkillSelection is bypassed.
  it.each([
    ['null', 'null'],
    ['a number', '7'],
    ['an object', '{"welcome":true}'],
    ['malformed JSON', '{not json'],
  ])('falls back to every skill when the selection is %s', async (_label, stored) => {
    const ag = await seed(`ag-bad-${stored.length}`, `bad-skills-${stored.length}`);
    await getDb().run('UPDATE container_configs SET skills = ? WHERE agent_group_id = ?', stored, ag.id);

    const doc = await compose(ag);

    expect(doc).toContain('# NanoClaw Skill: fixture-gateway');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('skill selection'), expect.anything());
  });

  it('does not substring-match a stored string against skill names', async () => {
    const ag = await seed('ag-substr', 'substr-group');
    await getDb().run(
      'UPDATE container_configs SET skills = ? WHERE agent_group_id = ?',
      JSON.stringify('xx-fixture-gateway-xx'),
      ag.id,
    );

    const doc = await compose(ag);

    // Treated as corrupt and widened to 'all', never as a selection that
    // happens to contain the skill's name as a substring.
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('skill selection'), expect.anything());
    expect(doc).toContain('# NanoClaw Skill: fixture-gateway');
  });
});

describe('composeGroupProjectDoc persona', () => {
  it('leads the document, before the runtime contract', async () => {
    const ag = await seed('ag-persona', 'persona-group');
    writePersona(ag.folder, 'You are an SDR agent.\n');

    const doc = await compose(ag);

    expect(doc.indexOf('# Persona')).toBeGreaterThan(-1);
    expect(doc.indexOf('# Persona')).toBeLessThan(doc.indexOf('# NanoClaw Runtime Contract'));
    expect(doc).toContain('You are an SDR agent.');
  });

  // Compose runs on every spawn, so the second write matters as much as the
  // first: red if writeAtomic stops overwriting an existing document.
  it('overwrites the previous document rather than keeping it', async () => {
    const ag = await seed('ag-persona-2', 'persona-group-2');
    writePersona(ag.folder, 'first persona');
    await compose(ag);

    writePersona(ag.folder, 'second persona');
    const doc = await compose(ag);

    expect(doc).toContain('second persona');
    expect(doc).not.toContain('first persona');
  });

  it('is inert when no persona file is present (non-template groups)', async () => {
    const ag = await seed('ag-no-persona', 'no-persona-group');

    const doc = await compose(ag);

    expect(doc).not.toContain('# Persona');
    expect(doc).toContain('# NanoClaw Runtime Contract');
  });
});

describe('composeGroupProjectDoc skill selection', () => {
  // Red if the walk stops filtering: the document would teach a skill whose
  // SKILL.md syncSkillSymlinks did not plant, which is a live contradiction.
  it('omits resident prose for a skill the group did not select', async () => {
    const ag = await seed('ag-skills-off', 'skills-off-group');
    await updateContainerConfigJson(ag.id, 'skills', ['welcome']);

    const doc = await compose(ag);

    expect(doc).not.toContain('# NanoClaw Skill: fixture-gateway');
    expect(doc).toContain('# NanoClaw Module: core');
  });

  it('inlines every shipping skill at the default selection', async () => {
    const ag = await seed('ag-skills-all', 'skills-all-group');

    const doc = await compose(ag);

    expect(doc).toContain('# NanoClaw Skill: fixture-gateway');
  });

  // The fork's no-em-dash rule lives once, in the base's Tenequm defaults block. Red if it moves
  // back into a skill, or the defaults block stops composing from the real tree.
  it('carries the em-dash rule once, inside the Tenequm defaults block', async () => {
    const ag = await seed('ag-resident', 'resident-group');

    const doc = await withRealContainer(() => compose(ag));

    const base = composedSection(doc, 'NanoClaw Runtime Contract');
    expect(base).toContain('You are a NanoClaw agent.');
    const defaultsAt = base.indexOf('\n## Tenequm defaults\n');
    expect(defaultsAt).toBeGreaterThan(-1);
    expect(base.slice(0, defaultsAt)).not.toMatch(/no em-dash/i);
    expect(base.slice(defaultsAt)).toMatch(/no em-dash, ever/i);
    expect(doc.match(/no em-dash, ever/gi)).toHaveLength(1);
  });
});

describe('composeGroupProjectDoc per-agent sections', () => {
  const JEV_HEADING = '# NanoClaw Module: jev-gate';
  const VOICE_HEADING = '# NanoClaw Skill: voice-mode-formatting';

  beforeEach(() => {
    fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
    resetGateConfigCache();
  });

  async function wire(ag: AgentGroup, mgId: string, channelType: string): Promise<void> {
    const createdAt = new Date().toISOString();
    await createMessagingGroup({
      id: mgId,
      channel_type: channelType,
      platform_id: `${channelType}:${mgId}`,
      instance: channelType,
      name: mgId,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: createdAt,
    });
    await createMessagingGroupAgent({
      id: `mga-${mgId}`,
      messaging_group_id: mgId,
      agent_group_id: ag.id,
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      threads: 0,
      created_at: createdAt,
    });
  }

  it('adds the jev-gate note for an agent whose gate is live', async () => {
    const ag = await seed('ag-jev-live', 'jev-live-group');
    writeGateEntry(ag.id, { enabled: true, mode: 'live' });

    const doc = await compose(ag);

    expect(composedSection(doc, 'NanoClaw Module: jev-gate')).toContain('A gate wake is an invitation, not an order');
  });

  // Shadow silences every ambient message, so the note's "the gate wakes you" would be false.
  it.each([
    ['no entry', undefined],
    ['a disabled entry', { enabled: false, mode: 'live' as const }],
    ['a shadow entry', { enabled: true, mode: 'shadow' as const }],
  ])('leaves the jev-gate note out with %s', async (_label, entry) => {
    const ag = await seed(`ag-jev-${_label.length}`, `jev-off-${_label.length}`);
    if (entry) writeGateEntry(ag.id, entry);

    const doc = await compose(ag);

    expect(doc).not.toContain(JEV_HEADING);
  });

  it('composes voice-mode-formatting for an agent with a voice-mode line', async () => {
    const ag = await seed('ag-voice', 'voice-group');
    await wire(ag, 'mg-voice-chat', 'telegram');
    await createVoiceModeLine({
      agentGroupId: ag.id,
      ownerUserId: 'telegram:owner',
      messagingGroupId: 'mg-voice-chat',
      threadId: null,
    });

    const doc = await withRealContainer(() => compose(ag));

    expect(composedSection(doc, 'NanoClaw Skill: voice-mode-formatting')).toContain(realSkill('voice-mode-formatting'));
  });

  it('composes voice-mode-formatting for an agent with a line from before the rename', async () => {
    const ag = await seed('ag-voice-legacy', 'voice-legacy-group');
    await wire(ag, 'mg-voice-legacy', 'voice');

    const doc = await withRealContainer(() => compose(ag));

    expect(doc).toContain(VOICE_HEADING);
  });

  it('leaves voice-mode-formatting out for a non-voice agent on the "all" selection', async () => {
    const ag = await seed('ag-no-voice', 'no-voice-group');
    await wire(ag, 'mg-text-only', 'telegram');

    const doc = await withRealContainer(() => compose(ag));

    // Proves the walk ran on the real tree at "all": the ungated resident skill is there.
    expect(doc).toContain('# NanoClaw Skill: onecli-gateway');
    expect(doc).not.toContain(VOICE_HEADING);
  });
});

describe('composeGroupProjectDoc cli_scope', () => {
  // Red-on-delete guard for the `scheduling`/`cli` exclusion: the agent is
  // taught `ncl tasks` iff it has ncl.
  it('inlines the scheduling module at the default cli_scope', async () => {
    const ag = await seed('ag-sched', 'sched-group');

    const doc = await compose(ag);

    expect(doc).toContain('# NanoClaw Module: scheduling');
    expect(doc).toContain('# NanoClaw Module: cli');
  });

  it('excludes both scheduling and cli when cli_scope is disabled', async () => {
    const ag = await seed('ag-sched-off', 'sched-group-off');
    await updateContainerConfigScalars(ag.id, { cli_scope: 'disabled' });

    const doc = await compose(ag);

    expect(doc).not.toContain('# NanoClaw Module: scheduling');
    expect(doc).not.toContain('# NanoClaw Module: cli');
    expect(doc).toContain('# NanoClaw Module: core');
  });
});

describe('composeGroupProjectDoc spec', () => {
  // The instruction prose is core-owned canon: with no provider facts the
  // rendered base must be byte-identical to the template minus its placeholder
  // paragraph, so the Claude document never changes when facts are added for
  // other providers.
  it('renders the canonical base byte-identically when no provider facts are declared', () => {
    const template = fs.readFileSync(path.join(process.cwd(), BASE_INSTRUCTIONS_PATH), 'utf-8');
    expect(template.split(MEMORY_NOTE_PLACEHOLDER)).toHaveLength(2);
    expect(renderBaseInstructions(template)).toBe(template.replace(`\n\n${MEMORY_NOTE_PLACEHOLDER}`, ''));
    expect(renderBaseInstructions(template)).not.toContain(MEMORY_NOTE_PLACEHOLDER);
  });

  it('renders provider facts as canonical prose in the declared slots', async () => {
    const ag = await seed('ag-facts', 'facts-group');

    const doc = await compose(ag, {
      fileName: 'AGENTS.md',
      instructions: {
        nativeOverrideFiles: ['AGENTS.local.md', 'AGENTS.override.md'],
        nativeSkills: {
          discoveryPath: '/workspace/agent/.agents/skills',
          sharedSource: '/app/skills',
          selfAuthoredHome: '~/.codex/skills',
          persistentRoots: ['~/.codex', '~/.agents'],
          ruleBearingInlined: true,
        },
      },
    });

    expect(doc).toContain('Do not use `AGENTS.local.md` or `AGENTS.override.md` for memory.');
    expect(doc).not.toContain(MEMORY_NOTE_PLACEHOLDER);
    expect(doc).toContain('provider-native skills at `/workspace/agent/.agents/skills`');
    expect(doc).toContain('`~/.codex/skills/<name>/SKILL.md`');
    expect(doc).toContain('inlined as `NanoClaw Skill:` sections');
    expect(doc.indexOf('# NanoClaw Runtime Contract')).toBeLessThan(doc.indexOf('# Native Runtime Skills'));
    expect(doc.indexOf('# Native Runtime Skills')).toBeLessThan(doc.indexOf('# NanoClaw Module: agents'));
  });

  it('keeps pre-contract payload base documents and sections working', async () => {
    const ag = await seed('ag-legacy-spec', 'legacy-spec-group');
    const baseDocPath = path.join(TEST_ROOT, 'legacy-base.md');
    fs.writeFileSync(baseDocPath, 'legacy provider instructions');

    const doc = await compose(ag, {
      fileName: 'AGENTS.md',
      baseDocPath,
      extraSections: [{ name: 'Legacy Pointer', body: 'legacy pointer text' }],
    });

    expect(doc).toContain('# NanoClaw Runtime Contract\n\nlegacy provider instructions');
    expect(doc).toContain('# Legacy Pointer\n\nlegacy pointer text');
  });

  // Tolerated so a partial checkout still spawns, but never silent: an absent
  // runtime contract is the same shape as the bug this replaced, and it is
  // what a wrong-cwd host looks like. Red if the warn is dropped.
  it('writes the file named by the spec and warns loudly on a missing base document', async () => {
    const ag = await seed('ag-nobase', 'nobase-group');
    const root = fs.mkdtempSync(path.join(TEST_ROOT, 'nobase-root-'));
    fs.mkdirSync(path.join(root, 'container'));
    fs.symlinkSync(path.join(process.cwd(), 'container', 'agent-runner'), path.join(root, 'container', 'agent-runner'));
    fs.symlinkSync(path.join(process.cwd(), 'container', 'skills'), path.join(root, 'container', 'skills'));
    const previousCwd = process.cwd();
    process.chdir(root);

    try {
      const doc = await compose(ag, { fileName: 'AGENTS.md' });

      expect(doc).not.toContain('# NanoClaw Runtime Contract');
      expect(doc).toContain('# NanoClaw Module: core');
      expect(log.warn).toHaveBeenCalledWith(
        'Project document composed without its base document',
        expect.objectContaining({ file: 'AGENTS.md' }),
      );
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe('composeGroupProjectDoc size cap', () => {
  const bigMcp = (n: number): Record<string, { command: string; args: string[]; instructions: string }> =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`bloated${i}`, { command: 'x', args: [], instructions: 'B'.repeat(9000) }]),
    );

  it('drops the largest droppable sections, keeps the core, and says so in the document', async () => {
    const ag = await seed('ag-cap', 'cap-group');
    writePersona(ag.folder, 'PERSONA_MARKER');
    await updateContainerConfigJson(ag.id, 'mcp_servers', bigMcp(4));

    const doc = await compose(ag, { ...CLAUDE_SPEC, maxBytes: 24 * 1024 });

    expect(Buffer.byteLength(doc, 'utf-8')).toBeLessThanOrEqual(24 * 1024);
    expect(doc).toContain('# Omitted for size');
    expect(doc).toContain('PERSONA_MARKER');
    expect(doc).toContain('# NanoClaw Runtime Contract');
    expect(log.error).toHaveBeenCalled();
  });

  // Claude Code "loads a CLAUDE.md file of up to 4 MiB in full and skips a
  // larger file", and over that cliff the agent gets NOTHING, silently. Red if
  // the default spec goes back to being uncapped.
  it('caps the default document at the size Claude Code will still load', () => {
    expect(DEFAULT_PROJECT_DOC.maxBytes).toBe(4 * 1024 * 1024);
  });

  // fitToCap must never throw: a per-spawn throw rides wakeContainer's retry and
  // darks the group on a 60s loop forever. Oversized-and-loud beats bricked.
  it('writes an oversized document loudly when the core alone exceeds the cap', async () => {
    const ag = await seed('ag-core-over', 'core-over-group');
    writePersona(ag.folder, `P${'A'.repeat(40_000)}`); // persona is never droppable

    const doc = await compose(ag, { ...CLAUDE_SPEC, maxBytes: 20 * 1024 });

    expect(Buffer.byteLength(doc, 'utf-8')).toBeGreaterThan(20 * 1024);
    expect(doc).toContain('AAAA');
    expect(log.error).toHaveBeenCalled();
  });

  it('applies no cap and logs nothing when maxBytes is unset', async () => {
    const ag = await seed('ag-nocap', 'nocap-group');
    await updateContainerConfigJson(ag.id, 'mcp_servers', bigMcp(4));

    const doc = await compose(ag);

    expect(Buffer.byteLength(doc, 'utf-8')).toBeGreaterThan(32 * 1024);
    expect(doc).not.toContain('# Omitted for size');
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns while there is still headroom, before anything is dropped', async () => {
    const ag = await seed('ag-warn', 'warn-group');
    // Calibrate off whatever the repo's own instruction prose weighs today, so
    // adding a paragraph to a skill cannot break this from another file.
    const bytes = Buffer.byteLength(await compose(ag), 'utf-8');
    vi.clearAllMocks();

    const doc = await compose(ag, { ...CLAUDE_SPEC, maxBytes: Math.ceil(bytes * 1.05) });

    expect(doc).not.toContain('# Omitted for size');
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
