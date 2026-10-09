/**
 * Driver selection, the registry it resolves through, and the settings it reads.
 *
 * The host service has no `EnvironmentFile=`; it parses `.env` in-process. A
 * setting that consulted only `process.env` would be silently ignored in the
 * file where every other NanoClaw setting lives — and for the driver selection,
 * being ignored means silently running the wrong runtime.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { DATA_DIR, GROUPS_DIR, INSTALL_SLUG } from '../config.js';
import {
  adaptSpecToDriver,
  adoptRunningSessions,
  assertGroupDriverChangeAllowed,
  changeGroupDriver,
  ensureSessionRuntimesReady,
  isContainerRunning,
  killContainer,
  reapRetainedSessions,
  rediscoverUnavailableRuntimes,
  wakeContainer,
  _resetAdoptionRetryStateForTesting,
  _setRuntimeDiscoveryScheduleForTesting,
} from '../container-runner.js';
import * as containerConfigs from '../db/container-configs.js';
import * as coordination from '../db/coordination.js';
import { closeDb, createAgentGroup, createSession, getDb, initTestDb, runMigrations } from '../db/index.js';
import {
  ensureContainerConfig,
  listDriverKindsUsed,
  recordDriverKindsUsed,
  setContainerConfigDriver,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../db/container-configs.js';
import { resetGatewayProvider } from '../gateway-providers/index.js';
import { getAgentMailbox } from '../mailbox/index.js';
import { groupRefusesAttachments, initSessionFolder, writeSessionMessage } from '../session-manager.js';
import type { AgentGroup, Session } from '../types.js';
import {
  configuredDriverKind,
  createSessionDriver,
  getSessionDriver,
  mountPolicy,
  onSessionDriverCreated,
  peekSessionDriver,
  peekSessionDrivers,
  readSetting,
  resetSessionDriver,
  sessionDriverForGroup,
} from './index.js';
import {
  FIXTURE_GROUP_VOLUME_CAPABILITIES,
  FIXTURE_PINNED_IMAGE,
  FIXTURE_SURFACE_IMAGE,
  fixtureSpec,
} from './spec-fixture.js';
// Imported from the registry module, not the barrel that re-exports it: this is
// the entry point an overlay reaches for, and it has to work without the
// selection module having been evaluated first.
import { listSessionDriverKinds, registerSessionDriver } from './driver-registry.js';
import { log } from '../log.js';
import type {
  DriverCapabilities,
  MountPolicy,
  RetainedObject,
  SessionDriver,
  SessionHandle,
  SessionKey,
  SessionSnapshot,
  SessionSpec,
} from './types.js';

let cwd: string;
let previous: string;
let uniqueKind = 0;

function writeEnv(contents: string): void {
  fs.writeFileSync(path.join(cwd, '.env'), contents);
}

/**
 * Registration is permanent by design (a duplicate is a wiring bug, so there is
 * no unregister to reach for). Each case therefore claims a kind of its own.
 */
function registerFake(seen: MountPolicy[] = []): { kind: string; seen: MountPolicy[] } {
  const kind = `fake-${++uniqueKind}`;
  registerSessionDriver(kind, (policy) => {
    seen.push(policy);
    return {
      kind,
      capabilities: () => ({
        isolationTiers: ['container'],
        admissionEnforced: false,
        networkPolicy: 'topology',
        encryptedVolumes: false,
        unrealized: [],
        sharedNetworkNamespace: false,
        auxiliaryContainers: false,
        imageBuild: false,
      }),
      prepare: () => Promise.reject(new Error('not under test')),
      listSessions: () => Promise.resolve([]),
      watchSessions: () => ({ stop: () => {} }),
    } satisfies SessionDriver;
  });
  return { kind, seen };
}

beforeEach(() => {
  vi.clearAllMocks();
  previous = process.cwd();
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-driver-env-'));
  process.chdir(cwd);
});

afterEach(() => {
  resetSessionDriver(null);
  process.chdir(previous);
});

describe('configuredDriverKind', () => {
  it('defaults to docker when nothing is set anywhere', () => {
    expect(configuredDriverKind({})).toBe('docker');
  });

  it('reads the selection from .env, not only from the process environment', () => {
    writeEnv('NANOCLAW_RUNTIME_DRIVER=vm\n');
    expect(configuredDriverKind({})).toBe('vm');
  });

  it('lets the process environment win over .env', () => {
    writeEnv('NANOCLAW_RUNTIME_DRIVER=vm\n');
    expect(configuredDriverKind({ NANOCLAW_RUNTIME_DRIVER: 'docker' })).toBe('docker');
  });

  it('reports the configured value verbatim instead of correcting it', () => {
    // Selection does not decide what is legitimate; the registry does. Anything
    // that "corrects" a value here is a silent fallback wearing a hat.
    expect(configuredDriverKind({ NANOCLAW_RUNTIME_DRIVER: 'firecracker' })).toBe('firecracker');
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('createSessionDriver', () => {
  it('builds the docker driver by default, and it is pre-registered', () => {
    expect(listSessionDriverKinds()).toContain('docker');
    expect(createSessionDriver('docker').kind).toBe('docker');
  });

  it('refuses a kind no driver is registered for, naming the setting, the value and what is installed', () => {
    // The message is the entire remediation an operator gets. Asserting its
    // shape — not just that something threw — is what keeps it actionable. The
    // `[^\n]*` anchoring is the point: all three facts must be in the FIRST
    // line, because that is the line a log aggregator shows.
    const selecting = (): unknown => createSessionDriver('vm');
    expect(selecting).toThrow(/^[^\n]*NANOCLAW_RUNTIME_DRIVER[^\n]*'vm'[^\n]*installed: /);
    // The list is what the registry actually holds, not a literal: an overlay
    // adds kinds, and a test that hard-coded `docker` would fail on a tree
    // where the message is doing its job.
    expect(selecting).toThrow(`installed: ${listSessionDriverKinds().join(', ')}`);
    expect(selecting).toThrow(/install the driver skill or unset the variable/);
  });

  it('refuses a typo exactly as it refuses an uninstalled driver', () => {
    // `=dcoker` silently running docker is the same failure as `=vm` silently
    // running docker: a host configured for one runtime running another.
    const selecting = (): unknown => createSessionDriver('dcoker');
    expect(selecting).toThrow(/^[^\n]*NANOCLAW_RUNTIME_DRIVER[^\n]*'dcoker'[^\n]*installed: /);
    expect(selecting).toThrow(`installed: ${listSessionDriverKinds().join(', ')}`);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('resolves a kind once a driver registers it, and hands it the resolved policy', () => {
    const { kind, seen } = registerFake();
    const driver = createSessionDriver(kind, { materialsRoot: '/srv/override' });
    expect(driver.kind).toBe(kind);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.materialsRoot).toBe('/srv/override');
    expect(seen[0]?.surfaceRoots).toHaveLength(3);
  });

  it('resolves a driver registered through the registry module alone', () => {
    // What an overlay does: import the registry, register at module scope, and
    // never touch selection. If that only worked when `index.js` had already
    // been evaluated, the appended-import install shape would be a startup
    // crash on the one path nobody exercises until an overlay exists.
    const { kind } = registerFake();
    expect(listSessionDriverKinds()).toContain(kind);
    expect(createSessionDriver(kind).kind).toBe(kind);
  });

  it('refuses to let two registrations claim one kind', () => {
    const { kind } = registerFake();
    expect(() => registerSessionDriver(kind, () => createSessionDriver('docker'))).toThrow(/already registered/);
  });

  it('logs the boot marker an operator uses to tell a crash loop from a healthy start', () => {
    // Under `Restart=always`, `systemctl is-active` says `active` all through a
    // crash loop. Absent marker + active unit = selection is throwing.
    createSessionDriver('docker');
    expect(log.info).toHaveBeenCalledWith(
      'Session runtime driver selected',
      expect.objectContaining({ driver: 'docker' }),
    );
  });
});

describe('getSessionDriver', () => {
  it('builds the configured kind through the registry and memoizes it', () => {
    const { kind } = registerFake();
    process.env.NANOCLAW_RUNTIME_DRIVER = kind;
    try {
      resetSessionDriver(null);
      const first = getSessionDriver();
      expect(first.kind).toBe(kind);
      expect(getSessionDriver()).toBe(first);
    } finally {
      delete process.env.NANOCLAW_RUNTIME_DRIVER;
    }
  });

  it('honours the reset seam so a suite can install its own driver', () => {
    const { kind } = registerFake();
    const standIn = createSessionDriver(kind);
    resetSessionDriver(standIn);
    expect(getSessionDriver()).toBe(standIn);
    resetSessionDriver(null);
    expect(getSessionDriver().kind).toBe('docker');
  });
});

describe('mountPolicy', () => {
  it('pins materialsRoot to the .env value the provisioner also reads', () => {
    // The provisioner reads this key from .env. If the two resolve differently,
    // every identity-material mount is denied by a policy naming a path that
    // looks correct.
    writeEnv('NANOCLAW_SESSION_MATERIAL_ROOT=/srv/materials\n');
    expect(mountPolicy({}).materialsRoot).toBe('/srv/materials');
  });

  it('enumerates surface roots instead of trusting an install-root prefix', () => {
    // The state roots nest inside the project root, so a prefix check would
    // admit the central DB as a mountable "surface".
    const policy = mountPolicy({});
    expect(policy.surfaceRoots).toHaveLength(3);
    expect(policy.surfaceRoots.every((root) => root.includes(`${path.sep}container${path.sep}`))).toBe(true);
    expect(policy.surfaceRoots.some((root) => root === policy.dataRoot)).toBe(false);
    // Named, not just counted: nothing mounts container/CLAUDE.md any more, so
    // the only thing keeping an operator additionalMount of it read-only is its
    // presence here. A bare length check would be "fixed" by editing the number.
    expect(policy.surfaceRoots).toContain(path.join(process.cwd(), 'container', 'CLAUDE.md'));
  });
});

describe('readSetting', () => {
  it('trims and treats blank as unset', () => {
    writeEnv('NANOCLAW_SESSION_MATERIAL_ROOT=   \n');
    expect(readSetting('NANOCLAW_SESSION_MATERIAL_ROOT', {})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Per-group selection (ratified D1) and the composition gates a driver's
// declarations drive. Everything below runs against registered FAKE drivers —
// a 'group-volume' one declaring exactly the kubernetes capabilities — so the
// gates are proven with no cluster, through the real spawn path.
// ---------------------------------------------------------------------------

interface FakeDriverOptions {
  capabilities?: DriverCapabilities;
  ensureReady?: () => Promise<void>;
  listSessions?: () => Promise<SessionSnapshot[]>;
  listRetained?: () => Promise<RetainedObject[]>;
  reapRetained?: (installSlug: string, keys: SessionKey[]) => Promise<void>;
}

interface FakeDriverRecord {
  kind: string;
  prepared: SessionSpec[];
  reaped: SessionKey[][];
  watches: number;
}

const HOST_BIND_CAPABILITIES: DriverCapabilities = {
  isolationTiers: ['container'],
  admissionEnforced: false,
  networkPolicy: 'topology',
  encryptedVolumes: false,
  unrealized: [],
  sharedNetworkNamespace: false,
  auxiliaryContainers: false,
  imageBuild: false,
};

function fakeHandle(spec: SessionSpec): SessionHandle {
  return {
    key: spec.key,
    name: `fake-${spec.key.sessionId}`,
    start: () => Promise.resolve(),
    status: () => Promise.resolve({ phase: 'running' }),
    stop: () => Promise.resolve(),
    execSpec: () => ({ bin: 'true', argsTty: [], argsPlain: [] }),
  };
}

/** Registers a fake under a fresh kind; the record exposes what the driver was handed. */
function registerRecordingFake(options: FakeDriverOptions = {}): FakeDriverRecord {
  const kind = `fake-${++uniqueKind}`;
  const record: FakeDriverRecord = { kind, prepared: [], reaped: [], watches: 0 };
  registerSessionDriver(kind, () => {
    const driver: SessionDriver = {
      kind,
      capabilities: () => options.capabilities ?? HOST_BIND_CAPABILITIES,
      prepare: (spec) => {
        record.prepared.push(structuredClone(spec));
        return Promise.resolve(fakeHandle(spec));
      },
      listSessions: options.listSessions ?? (() => Promise.resolve([])),
      watchSessions: () => {
        record.watches += 1;
        return { stop: () => {} };
      },
    };
    if (options.ensureReady) driver.ensureReady = options.ensureReady;
    if (options.listRetained) driver.listRetained = options.listRetained;
    if (options.reapRetained || options.listRetained) {
      driver.reapRetained = async (installSlug, keys) => {
        record.reaped.push(keys);
        await options.reapRetained?.(installSlug, keys);
      };
    }
    return driver;
  });
  return record;
}

describe('per-kind selection', () => {
  it('memoizes one wrapped instance per kind, independently', () => {
    const a = registerFake();
    const b = registerFake();
    const first = getSessionDriver(a.kind);
    expect(getSessionDriver(a.kind)).toBe(first);
    expect(getSessionDriver(b.kind)).not.toBe(first);
    expect(peekSessionDrivers()).toEqual(expect.arrayContaining([first, getSessionDriver(b.kind)]));
    // The install default is its own entry and stays the no-argument answer.
    expect(getSessionDriver().kind).toBe('docker');
    expect(getSessionDriver()).toBe(getSessionDriver('docker'));
  });

  it('announces every newly built driver exactly once, never a memo hit', () => {
    const seen: string[] = [];
    const unsubscribe = onSessionDriverCreated((driver) => seen.push(driver.kind));
    try {
      const { kind } = registerFake();
      getSessionDriver(kind);
      getSessionDriver(kind);
      expect(seen).toEqual([kind]);
    } finally {
      unsubscribe();
    }
  });

  it('keeps one session-events hub per instance: a handle arms only its own driver', async () => {
    const a = registerRecordingFake();
    const b = registerRecordingFake();
    const driverA = getSessionDriver(a.kind);
    getSessionDriver(b.kind);
    const handle = await driverA.prepare(fixtureSpec());
    handle.onTerminal(() => {});
    expect(a.watches).toBe(1);
    expect(b.watches).toBe(0);
  });

  it('peeking never instantiates', () => {
    resetSessionDriver(null);
    expect(peekSessionDrivers()).toEqual([]);
    expect(peekSessionDriver()).toBeNull();
  });
});

describe('composition on the spawn path', () => {
  const GROUP_ID = 'ag-driver-selection';
  const FOLDER = 'driver-selection-pilot';
  const SESSION_ID = 'sess-driver-selection';
  let root: string;
  let groupVolume: FakeDriverRecord;
  let hostBind: FakeDriverRecord;
  let warn: ReturnType<typeof vi.mocked<typeof log.warn>>;

  const now = () => new Date().toISOString();
  const groupDir = () => path.join(GROUPS_DIR, FOLDER);
  const session = (overrides: Partial<Session> = {}): Session => ({
    id: SESSION_ID,
    agent_group_id: GROUP_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
    ...overrides,
  });

  async function createGroupSession(overrides: Partial<Session> = {}): Promise<Session> {
    const row = session(overrides);
    await createSession(row);
    initSessionFolder(GROUP_ID, row.id);
    return row;
  }

  /** Wake, then report what the spawn refused with (undefined = it spawned). */
  async function wakeAndRefusal(row: Session): Promise<string | undefined> {
    warn.mockClear();
    const woke = await wakeContainer(row);
    if (woke) return undefined;
    const call = warn.mock.calls.find(([message]) => String(message).startsWith('wakeContainer failed'));
    return String((call?.[1] as { err?: Error } | undefined)?.err?.message);
  }

  async function stopIfRunning(sessionId: string): Promise<void> {
    if (!isContainerRunning(sessionId)) return;
    killContainer(sessionId, 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning(sessionId)).toBe(false));
  }

  beforeEach(async () => {
    process.chdir(previous);
    root = previous;
    warn = vi.mocked(log.warn);
    _resetAdoptionRetryStateForTesting();
    groupVolume = registerRecordingFake({ capabilities: FIXTURE_GROUP_VOLUME_CAPABILITIES });
    hostBind = registerRecordingFake();
    await runMigrations(await initTestDb());
    await createAgentGroup({
      id: GROUP_ID,
      name: 'Driver Selection',
      folder: FOLDER,
      agent_provider: null,
      created_at: now(),
    });
    await ensureContainerConfig(GROUP_ID);
    await updateContainerConfigScalars(GROUP_ID, { image_tag: FIXTURE_PINNED_IMAGE });
    await setContainerConfigDriver(GROUP_ID, groupVolume.kind);
  });

  afterEach(async () => {
    await stopIfRunning(SESSION_ID);
    await stopIfRunning('sess-driver-selection-2');
    await closeDb();
    fs.rmSync(groupDir(), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, 'v2-sessions', GROUP_ID), { recursive: true, force: true });
    expect(process.cwd()).toBe(root);
  });

  it('a group-volume group composes NO install-surface, plugins or pond mount, every mount classified', async () => {
    const row = await createGroupSession();
    expect(await wakeAndRefusal(row)).toBeUndefined();
    expect(hostBind.prepared).toHaveLength(0);
    const [spec] = groupVolume.prepared;
    const agent = spec.containers[0];
    const targets = agent.mounts.map((m) => m.containerPath);
    expect(targets).not.toContain('/app/src');
    expect(targets).not.toContain('/app/skills');
    expect(targets).not.toContain('/workspace/agent/plugins');
    expect(targets.some((t) => t.startsWith('/workspace/extra/pond'))).toBe(false);
    expect(agent.mounts.some((m) => m.class === 'install-surface')).toBe(false);
    const byTarget = new Map(agent.mounts.map((m) => [m.containerPath, m.realization]));
    // The subPath rule: root-relative host paths, never container paths.
    expect(byTarget.get('/workspace')).toEqual({
      kind: 'group-volume',
      subPath: `v2-sessions/${GROUP_ID}/${SESSION_ID}`,
    });
    expect(byTarget.get('/workspace/agent')).toEqual({ kind: 'group-volume', subPath: FOLDER });
    expect(byTarget.get('/home/node/.claude')).toEqual({
      kind: 'group-volume',
      subPath: `v2-sessions/${GROUP_ID}/.claude-shared`,
    });
    for (const file of ['/app/.nanoclaw-session.json', '/workspace/agent/container.json']) {
      expect(byTarget.get(file)).toEqual({ kind: 'file-snapshot' });
    }
    expect(agent.mounts.every((m) => m.realization !== undefined)).toBe(true);
    expect(agent.image).toBe(FIXTURE_PINNED_IMAGE);
    expect(spec.runAs).toEqual({ uid: 1000, gid: 1000 });
    expect(spec.providerState).toEqual([
      expect.objectContaining({
        provider: 'claude',
        subPath: `v2-sessions/${GROUP_ID}/.claude-shared`,
        createIfMissing: [expect.objectContaining({ relativePath: 'settings.json' })],
        skillLinks: expect.objectContaining({ relativeDir: 'skills', targetRoot: '/app/skills' }),
      }),
    ]);
    // Baked mode: no surface image configured, none composed.
    expect(agent.surfaceImage).toBeUndefined();
    // The mailbox endpoint is advertised on the driver's declared host address.
    const context = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'v2-sessions', GROUP_ID, '.context', `${SESSION_ID}.json`), 'utf8'),
    ) as { mailbox: { url: string } };
    expect(context.mailbox.url.startsWith(`http://${FIXTURE_GROUP_VOLUME_CAPABILITIES.hostAddress}:`)).toBe(true);
  });

  it('a group with NO driver field composes exactly what it did before: host binds, no realization data', async () => {
    resetSessionDriver(getSessionDriver(hostBind.kind));
    await setContainerConfigDriver(GROUP_ID, null);
    const row = await createGroupSession();
    expect(await wakeAndRefusal(row)).toBeUndefined();
    expect(groupVolume.prepared).toHaveLength(0);
    const [spec] = hostBind.prepared;
    const targets = spec.containers[0].mounts.map((m) => m.containerPath);
    expect(targets).toEqual(expect.arrayContaining(['/app/src', '/workspace/agent/plugins']));
    expect(spec.containers[0].mounts.every((m) => m.realization === undefined)).toBe(true);
    expect(spec.providerState).toBeUndefined();
    expect(spec.containers[0].surfaceImage).toBeUndefined();
    const context = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, 'v2-sessions', GROUP_ID, '.context', `${SESSION_ID}.json`), 'utf8'),
    ) as { mailbox: { url: string } };
    expect(context.mailbox.url).not.toContain(String(FIXTURE_GROUP_VOLUME_CAPABILITIES.hostAddress));
  });

  it('composes the digest-pinned surface image when the install configures one, and refuses a mutable one', async () => {
    process.env.NANOCLAW_SURFACE_IMAGE = FIXTURE_SURFACE_IMAGE;
    try {
      const row = await createGroupSession();
      expect(await wakeAndRefusal(row)).toBeUndefined();
      expect(groupVolume.prepared[0].containers[0].surfaceImage).toEqual({
        image: FIXTURE_SURFACE_IMAGE,
        mounts: [
          { imagePath: 'src', containerPath: '/app/src' },
          { imagePath: 'skills', containerPath: '/app/skills' },
        ],
      });
      await stopIfRunning(SESSION_ID);
      process.env.NANOCLAW_SURFACE_IMAGE = 'ghcr.io/tenequm/nanoclaw-agent-src:dev';
      expect(await wakeAndRefusal(row)).toMatch(/spec-invalid: NANOCLAW_SURFACE_IMAGE .* must be a digest/);
    } finally {
      delete process.env.NANOCLAW_SURFACE_IMAGE;
    }
  });

  const refusals: { name: string; arrange: () => Promise<Partial<Session> | void>; expected: RegExp }[] = [
    {
      name: "the install's local default image",
      arrange: async () => {
        await getDb().run('UPDATE container_configs SET image_tag = NULL WHERE agent_group_id = ?', GROUP_ID);
      },
      expected: /spec-invalid: .*local default image/,
    },
    {
      name: 'a :latest image',
      arrange: () => updateContainerConfigScalars(GROUP_ID, { image_tag: 'ghcr.io/x/agent:latest' }),
      expected: /spec-invalid: .*:latest/,
    },
    {
      name: 'an untagged image',
      arrange: () => updateContainerConfigScalars(GROUP_ID, { image_tag: 'ghcr.io/x/agent' }),
      expected: /spec-invalid: .*untagged/,
    },
    {
      name: 'stamped plugins (named)',
      arrange: async () => {
        fs.mkdirSync(path.join(groupDir(), 'plugins', 'acme-plugin'), { recursive: true });
      },
      expected: /spec-invalid: .*stamped plugins \(acme-plugin\)/,
    },
    {
      name: 'operator additionalMounts (named)',
      arrange: () =>
        updateContainerConfigJson(GROUP_ID, 'additional_mounts', [
          { hostPath: '/tmp', containerPath: '/workspace/extra/tmp', readonly: true },
        ]),
      expected: /spec-invalid: .*additionalMounts \(\/workspace\/extra\/tmp\)/,
    },
    {
      name: 'a provider whose contract the driver does not realize',
      arrange: () => updateContainerConfigScalars(GROUP_ID, { provider: 'opencode' }),
      expected: /spec-invalid: provider 'opencode' has no host contract .* \(supported: claude\)/,
    },
    {
      name: 'a task-series session',
      arrange: async () => ({ thread_id: 'system:tasks:series-1' }),
      expected: /spec-invalid: task-series session .* sessionsPerGroup 'one'/,
    },
    {
      name: 'a wiring that is not agent-shared',
      arrange: async () => {
        await getDb().run(
          "INSERT INTO messaging_groups (id, channel_type, platform_id, instance, created_at) VALUES ('mg-ds', 'cli', 'p-ds', 'cli', ?)",
          now(),
        );
        await getDb().run(
          "INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at) VALUES ('w-ds', 'mg-ds', ?, 'shared', ?)",
          GROUP_ID,
          now(),
        );
      },
      expected: /spec-invalid: .*routed 'shared'.*'agent-shared'/,
    },
  ];

  for (const { name, arrange, expected } of refusals) {
    it(`refuses loudly, before prepare: ${name}`, async () => {
      // initGroupFilesystem creates the folder on the first spawn; a case that
      // stamps into it needs it now.
      fs.mkdirSync(groupDir(), { recursive: true });
      const overrides = (await arrange()) ?? {};
      const row = await createGroupSession(overrides);
      expect(await wakeAndRefusal(row)).toMatch(expected);
      expect(groupVolume.prepared).toHaveLength(0);
    });
  }

  it('refuses pond stores the group reads (named), and composes as plain when it reads none', async (ctx) => {
    const pondDir = path.join(DATA_DIR, 'pond');
    if (fs.existsSync(pondDir)) ctx.skip(); // never touch a real install's pond config
    try {
      fs.mkdirSync(path.join(pondDir, 'stores', 'team'), { recursive: true });
      fs.writeFileSync(
        path.join(pondDir, 'stores.json'),
        JSON.stringify({ stores: { team: { read: [GROUP_ID] }, other: { read: ['ag-else'] } } }),
      );
      const row = await createGroupSession();
      expect(await wakeAndRefusal(row)).toMatch(/spec-invalid: .*reads pond stores \(\/workspace\/extra\/pond\/team\)/);
      expect(groupVolume.prepared).toHaveLength(0);
    } finally {
      fs.rmSync(pondDir, { recursive: true, force: true });
    }
  });

  it('refuses the SQLite mailbox transport: no host mailbox file reaches the runtime', async () => {
    const row = await createGroupSession();
    const spy = vi.spyOn(getAgentMailbox(), 'runnerContext').mockResolvedValueOnce(null);
    try {
      expect(await wakeAndRefusal(row)).toMatch(/spec-invalid: .*HTTP mailbox transport/);
    } finally {
      spy.mockRestore();
    }
    expect(groupVolume.prepared).toHaveLength(0);
  });

  it('holds the group fence: a second session of the group waits while the first is active', async () => {
    const first = await createGroupSession();
    expect(await wakeAndRefusal(first)).toBeUndefined();
    const second = await createGroupSession({ id: 'sess-driver-selection-2' });
    expect(await wakeAndRefusal(second)).toMatch(/already has active session sess-driver-selection/);
    await stopIfRunning(SESSION_ID);
    // Released with the runtime: the second session is admitted now.
    expect(await wakeAndRefusal(second)).toBeUndefined();
    expect(groupVolume.prepared.map((s) => s.key.sessionId)).toEqual([SESSION_ID, 'sess-driver-selection-2']);
  });

  it("holds the group's spawns while its driver changes, and refuses a change while a spawn is in flight", async () => {
    const row = await createGroupSession();
    let midChange: string | undefined;
    await changeGroupDriver(GROUP_ID, hostBind.kind, async () => {
      midChange = await wakeAndRefusal(row);
    });
    // A wake landing between the emptiness check and the write never starts on the old driver.
    expect(midChange).toMatch(/is changing its session runtime driver/);
    expect(groupVolume.prepared).toHaveLength(0);

    const waking = wakeContainer(row);
    await expect(changeGroupDriver(GROUP_ID, hostBind.kind, async () => {})).rejects.toThrow(
      /session sess-driver-selection is starting/,
    );
    await waking;
  });

  it('holds the fence against an old execution still terminating on the runtime', async () => {
    const settling = registerRecordingFake({
      capabilities: FIXTURE_GROUP_VOLUME_CAPABILITIES,
      listRetained: async () => [
        {
          key: { installSlug: INSTALL_SLUG, agentGroupId: GROUP_ID, sessionId: 'sess-old' },
          name: 'ncl-old',
          kind: 'session',
          state: 'stopping',
        },
      ],
    });
    await setContainerConfigDriver(GROUP_ID, settling.kind);
    const row = await createGroupSession();
    expect(await wakeAndRefusal(row)).toMatch(/still has runtime ncl-old of another session/);
    expect(settling.prepared).toHaveLength(0);
  });

  it('refuses a gateway that composes auxiliary containers (capability-gated, Block E)', async () => {
    resetGatewayProvider({
      kind: 'aux-gateway',
      agentSkills: [],
      sessions: {
        async ensure() {
          return {
            contribution: {
              networkAccess: { endpoint: 'proxy', target: { kind: 'session-container', role: 'proxy' } },
              containers: [{ role: 'proxy', image: 'proxy:1', env: {}, mounts: [] }],
            },
          };
        },
      },
      approvals: { subscribe: async () => {} },
    });
    const row = await createGroupSession();
    expect(await wakeAndRefusal(row)).toMatch(/spec-invalid: gateway provider composed auxiliary containers/);
  });

  it('refuses attachment bytes inbound for a group-volume group, visibly', async () => {
    await createGroupSession();
    await writeSessionMessage(GROUP_ID, SESSION_ID, {
      id: 'msg-attach',
      kind: 'chat',
      timestamp: now(),
      platformId: null,
      channelType: 'cli',
      threadId: null,
      content: JSON.stringify({ text: 'see file', attachments: [{ name: 'a.txt', data: 'aGVsbG8=' }] }),
      trigger: false,
    });
    expect(fs.existsSync(path.join(DATA_DIR, 'v2-sessions', GROUP_ID, SESSION_ID, 'inbox', 'msg-attach'))).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Refused inbound attachments'),
      expect.objectContaining({ messageId: 'msg-attach' }),
    );
    expect(await groupRefusesAttachments(GROUP_ID)).toBe(true);
  });

  // --- A1 fix round: astra's BLOCK findings, reproduced ---------------------

  it('refuses a driver change while a spawn is paused in gateway acquisition; the next session stays on the old driver', async () => {
    // Astra's interleaving: the old spawn has selected its driver and waits on
    // the gateway when the operator changes the group's driver.
    await setContainerConfigDriver(GROUP_ID, hostBind.kind);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atGateway = new Promise<void>((resolve) => (reached = resolve));
    resetGatewayProvider({
      kind: 'slow-gateway',
      agentSkills: [],
      sessions: {
        async ensure() {
          reached();
          await gate;
          return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
        },
      },
      approvals: { subscribe: async () => {} },
    });
    try {
      const first = await createGroupSession();
      const waking = wakeContainer(first);
      await atGateway;
      await expect(
        changeGroupDriver(GROUP_ID, groupVolume.kind, () => setContainerConfigDriver(GROUP_ID, groupVolume.kind)),
      ).rejects.toThrow(/session sess-driver-selection is starting/);
      release();
      expect(await waking).toBe(true);
      const second = await createGroupSession({ id: 'sess-driver-selection-2' });
      expect(await wakeAndRefusal(second)).toBeUndefined();
      expect((await sessionDriverForGroup(GROUP_ID)).kind).toBe(hostBind.kind);
      expect(groupVolume.prepared).toHaveLength(0);
      expect(hostBind.prepared.map((spec) => spec.key.sessionId)).toEqual([SESSION_ID, 'sess-driver-selection-2']);
    } finally {
      release();
      resetGatewayProvider(null);
    }
  });

  it('holds a pending-adoption retry behind an in-flight driver change, then reclaims once it is refused', async () => {
    const row = await createGroupSession();
    const survivor = {
      handle: {
        ...fakeHandle(
          fixtureSpec({ key: { installSlug: INSTALL_SLUG, agentGroupId: GROUP_ID, sessionId: SESSION_ID } }),
        ),
        onTerminal: () => {},
      },
      phase: 'running',
    } as unknown as SessionSnapshot;
    let changing = false;
    let wakeDuringChange: Promise<boolean> | undefined;
    const origin = registerRecordingFake({
      listSessions: async () => {
        // The change's emptiness check lists the old driver: wake right there.
        if (changing) wakeDuringChange ??= wakeContainer(row);
        return [survivor];
      },
    });
    await setContainerConfigDriver(GROUP_ID, origin.kind);
    resetSessionDriver(getSessionDriver(hostBind.kind));
    const claim = vi.spyOn(coordination, 'tryClaimSession').mockRejectedValueOnce(new Error('store down'));
    try {
      await adoptRunningSessions();
    } finally {
      claim.mockRestore();
    }
    expect(isContainerRunning(SESSION_ID)).toBe(false);

    changing = true;
    await expect(changeGroupDriver(GROUP_ID, hostBind.kind, async () => {})).rejects.toThrow(/still has/);
    changing = false;
    // The retry selected nothing while the change held the group.
    expect(await wakeDuringChange).toBe(false);
    expect(isContainerRunning(SESSION_ID)).toBe(false);
    // Once the change is gone the surviving container is reclaimed, not re-spawned.
    expect(await wakeContainer(row)).toBe(true);
    expect(isContainerRunning(SESSION_ID)).toBe(true);
    expect(origin.prepared).toHaveLength(0);
  });

  it('admits exactly one of two sessions of a one-session group woken at the same moment', async () => {
    const first = await createGroupSession();
    const second = await createGroupSession({ id: 'sess-driver-selection-2' });
    const woke = await Promise.all([wakeContainer(first), wakeContainer(second)]);
    expect(woke.filter(Boolean)).toHaveLength(1);
    expect(groupVolume.prepared).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'wakeContainer failed — host-sweep will retry',
      expect.objectContaining({
        err: expect.objectContaining({ message: expect.stringMatching(/already has active session/) }),
      }),
    );
  });

  describe('runtime availability', () => {
    const reapOrphans = vi.fn(async () => {});

    beforeEach(() => {
      reapOrphans.mockClear();
      resetGatewayProvider({
        kind: 'availability-gateway',
        agentSkills: [],
        sessions: {
          async ensure() {
            return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
          },
          reapOrphans,
        },
        approvals: { subscribe: async () => {} },
      });
    });

    afterEach(() => {
      _setRuntimeDiscoveryScheduleForTesting();
      _resetAdoptionRetryStateForTesting();
      resetGatewayProvider(null);
    });

    it('a runtime whose listing never settles holds up neither the default runtime nor startup; it stays closed until rediscovered', async () => {
      _setRuntimeDiscoveryScheduleForTesting(50, 60_000);
      let hang = true;
      const slow = registerRecordingFake({ listSessions: () => (hang ? new Promise(() => {}) : Promise.resolve([])) });
      await setContainerConfigDriver(GROUP_ID, slow.kind);
      const stops: string[] = [];
      const orphan = {
        handle: {
          ...fakeHandle(
            fixtureSpec({ key: { installSlug: INSTALL_SLUG, agentGroupId: 'ag-gone', sessionId: 'sess-gone' } }),
          ),
          stop: async (reason: string) => void stops.push(reason),
        },
        phase: 'running',
      } as unknown as SessionSnapshot;
      const defaultFake = registerRecordingFake({ listSessions: async () => [orphan] });
      resetSessionDriver(getSessionDriver(defaultFake.kind));

      // Bounded: startup returns, and the default runtime's orphan was handled.
      expect(await adoptRunningSessions()).toEqual({ adopted: 0, stopped: 1 });
      expect(stops).toEqual(['orphan-at-startup']);
      // The slow runtime's surviving sessions are unseen: no global gateway
      // reap, and its groups are closed to admission (retryable).
      expect(reapOrphans).not.toHaveBeenCalled();
      const row = await createGroupSession();
      expect(await wakeAndRefusal(row)).toMatch(/runtime-unavailable: .*which is not available \(discovery\)/);
      expect(slow.prepared).toHaveLength(0);

      // Still hung: rediscovery leaves it closed, never "nothing there".
      expect(await rediscoverUnavailableRuntimes()).toBe(0);
      expect(await wakeAndRefusal(row)).toMatch(/runtime-unavailable/);

      hang = false;
      expect(await rediscoverUnavailableRuntimes()).toBe(1);
      expect(await wakeAndRefusal(row)).toBeUndefined();
      expect(slow.prepared.map((spec) => spec.key.sessionId)).toEqual([SESSION_ID]);
    });

    it('a single-runtime install lists unbounded and closes nothing, exactly as before', async () => {
      _setRuntimeDiscoveryScheduleForTesting(1, 60_000);
      await setContainerConfigDriver(GROUP_ID, null);
      await getDb().run('DELETE FROM runtime_driver_kinds');
      let answer!: (snapshots: SessionSnapshot[]) => void;
      const defaultFake = registerRecordingFake({
        listSessions: () => new Promise<SessionSnapshot[]>((resolve) => (answer = resolve)),
      });
      resetSessionDriver(getSessionDriver(defaultFake.kind));
      const adopting = adoptRunningSessions();
      await new Promise((resolve) => setTimeout(resolve, 20));
      answer([]);
      expect(await adopting).toEqual({ adopted: 0, stopped: 0 });
      expect(reapOrphans).toHaveBeenCalledTimes(1);
      const row = await createGroupSession();
      expect(await wakeAndRefusal(row)).toBeUndefined();
    });

    it('readiness: a failing default with every group on another, ready runtime closes only the default', async () => {
      const notReady = new Error('docker daemon unreachable');
      const defaultFake = registerRecordingFake({ ensureReady: () => Promise.reject(notReady) });
      resetSessionDriver(getSessionDriver(defaultFake.kind));

      // The group runs on the group-volume fake, which needs no readiness check.
      await expect(ensureSessionRuntimesReady()).resolves.toBeUndefined();
      const row = await createGroupSession();
      expect(await wakeAndRefusal(row)).toBeUndefined();
      expect(groupVolume.prepared).toHaveLength(1);
      await stopIfRunning(SESSION_ID);

      // A group on the default runtime is refused admission, retryably.
      await setContainerConfigDriver(GROUP_ID, null);
      expect(await wakeAndRefusal(row)).toMatch(/runtime-unavailable: .*which is not available \(readiness\)/);
      expect(defaultFake.prepared).toHaveLength(0);
    });

    it('readiness: a failing default stays fatal, with the same error, when no group uses another kind', async () => {
      const notReady = new Error('docker daemon unreachable');
      const defaultFake = registerRecordingFake({ ensureReady: () => Promise.reject(notReady) });
      resetSessionDriver(getSessionDriver(defaultFake.kind));
      await setContainerConfigDriver(GROUP_ID, null);
      await expect(ensureSessionRuntimesReady()).rejects.toBe(notReady);

      // ...and when the only other kind configured is not ready either.
      const alsoDown = registerRecordingFake({ ensureReady: () => Promise.reject(new Error('apiserver down')) });
      await setContainerConfigDriver(GROUP_ID, alsoDown.kind);
      await expect(ensureSessionRuntimesReady()).rejects.toBe(notReady);
    });
  });
});

describe('retained objects and driver changes', () => {
  const GROUP_ID = 'ag-retained';
  const now = () => new Date().toISOString();
  const key = (sessionId: string): SessionKey => ({ installSlug: INSTALL_SLUG, agentGroupId: GROUP_ID, sessionId });

  beforeEach(async () => {
    process.chdir(previous);
    await runMigrations(await initTestDb());
    await createAgentGroup({
      id: GROUP_ID,
      name: 'Retained',
      folder: 'retained',
      agent_provider: null,
      created_at: now(),
    });
    await ensureContainerConfig(GROUP_ID);
    await createSession({
      id: 'sess-live-row',
      agent_group_id: GROUP_ID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
  });

  afterEach(async () => {
    await closeDb();
  });

  it('reaps only retained session objects whose rows are gone; never group storage, never an active row', async () => {
    const fake = registerRecordingFake({
      capabilities: FIXTURE_GROUP_VOLUME_CAPABILITIES,
      listRetained: async () => [
        { key: key('sess-live-row'), name: 'ncl-live', kind: 'session', state: 'stopped' },
        { key: key('sess-deleted'), name: 'ncl-gone', kind: 'session', state: 'stopped' },
        { key: key(''), name: 'ncl-pvc', kind: 'group-storage' },
      ],
    });
    getSessionDriver(fake.kind);
    expect(await reapRetainedSessions()).toBe(1);
    expect(fake.reaped).toEqual([[key('sess-deleted')]]);
  });

  it('reaps nothing when the runtime cannot be read — unreadable is never "gone"', async () => {
    const fake = registerRecordingFake({
      capabilities: FIXTURE_GROUP_VOLUME_CAPABILITIES,
      listRetained: () => Promise.reject(new Error('apiserver unreachable')),
    });
    getSessionDriver(fake.kind);
    expect(await reapRetainedSessions()).toBe(0);
    expect(fake.reaped).toEqual([]);
  });

  it('refuses a driver change while the old driver retains anything for the group, and when it cannot be read', async () => {
    const holding = registerRecordingFake({
      capabilities: FIXTURE_GROUP_VOLUME_CAPABILITIES,
      listRetained: async () => [{ key: key(''), name: 'ncl-pvc', kind: 'group-storage' }],
    });
    await setContainerConfigDriver(GROUP_ID, holding.kind);
    await expect(assertGroupDriverChangeAllowed(GROUP_ID, null)).rejects.toThrow(/retained group-storage ncl-pvc/);

    const unreadable = registerRecordingFake({
      capabilities: FIXTURE_GROUP_VOLUME_CAPABILITIES,
      listSessions: () => Promise.reject(new Error('apiserver unreachable')),
    });
    await setContainerConfigDriver(GROUP_ID, unreadable.kind);
    await expect(assertGroupDriverChangeAllowed(GROUP_ID, null)).rejects.toThrow(/could not be read/);

    const clean = registerRecordingFake({
      capabilities: FIXTURE_GROUP_VOLUME_CAPABILITIES,
      listRetained: async () => [],
    });
    await setContainerConfigDriver(GROUP_ID, clean.kind);
    await expect(assertGroupDriverChangeAllowed(GROUP_ID, null)).resolves.toBeUndefined();
  });

  it('refuses an unregistered kind, naming what is installed', async () => {
    await expect(assertGroupDriverChangeAllowed(GROUP_ID, 'no-such-driver')).rejects.toThrow(/installed: /);
  });

  it('resolves a group to its configured kind, else the install default, and records kinds ever used', async () => {
    const { kind } = registerFake();
    expect((await sessionDriverForGroup(GROUP_ID)).kind).toBe('docker');
    await setContainerConfigDriver(GROUP_ID, kind);
    expect((await sessionDriverForGroup(GROUP_ID)).kind).toBe(kind);
    await setContainerConfigDriver(GROUP_ID, null);
    expect((await sessionDriverForGroup(GROUP_ID)).kind).toBe('docker');
    // Flipped back, but remembered: discovery keeps looking at it.
    expect(await listDriverKindsUsed()).toContain(kind);
  });

  it('startup discovery skips an unreachable runtime without blocking the default one', async () => {
    const unreachable = registerRecordingFake({
      capabilities: FIXTURE_GROUP_VOLUME_CAPABILITIES,
      listSessions: () => Promise.reject(new Error('apiserver unreachable')),
    });
    await recordDriverKindsUsed([unreachable.kind]);
    const reapOrphans = vi.fn(async () => {});
    resetGatewayProvider({
      kind: 'reap-gateway',
      agentSkills: [],
      sessions: {
        async ensure() {
          return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
        },
        reapOrphans,
      },
      approvals: { subscribe: async () => {} },
    });
    const defaultFake = registerRecordingFake({
      listSessions: async () => [
        { handle: fakeHandle(fixtureSpec({ key: key('sess-gone-row') })), phase: 'running' } as SessionSnapshot,
      ],
    });
    resetSessionDriver(getSessionDriver(defaultFake.kind));
    const result = await adoptRunningSessions();
    // The default runtime's orphan was handled; the unreachable one blocked nothing...
    expect(result).toEqual({ adopted: 0, stopped: 1 });
    // ...but its live sessions' gateway resources were not reaped as orphans.
    expect(reapOrphans).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Failed to list existing sessions for adoption',
      expect.objectContaining({ driver: unreachable.kind }),
    );
  });
});

describe('startup discovery edge cases', () => {
  const GROUP_ID = 'ag-discovery';
  const key = (sessionId: string): SessionKey => ({ installSlug: INSTALL_SLUG, agentGroupId: GROUP_ID, sessionId });
  let reapOrphans: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(async () => {
    process.chdir(previous);
    await runMigrations(await initTestDb());
    reapOrphans = vi.fn(async () => {});
    resetGatewayProvider({
      kind: 'discovery-gateway',
      agentSkills: [],
      sessions: {
        async ensure() {
          return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
        },
        reapOrphans,
      },
      approvals: { subscribe: async () => {} },
    });
  });

  afterEach(async () => {
    await closeDb();
  });

  it('treats a recorded kind whose driver cannot be built as unconsidered: no gateway orphan reap', async () => {
    await recordDriverKindsUsed(['kind-whose-overlay-was-removed']);
    const defaultFake = registerRecordingFake();
    resetSessionDriver(getSessionDriver(defaultFake.kind));
    await adoptRunningSessions();
    expect(log.error).toHaveBeenCalledWith(
      'Session runtime unavailable for discovery; its sessions are left untouched, not treated as gone',
      expect.objectContaining({ driver: 'kind-whose-overlay-was-removed' }),
    );
    expect(reapOrphans).not.toHaveBeenCalled();
  });

  it('leaves two copies on ONE runtime to the pre-selection path: no cross-runtime arbitration', async () => {
    const copy = (name: string) =>
      ({
        handle: { ...fakeHandle(fixtureSpec({ key: key('sess-no-row') })), name },
        phase: 'running',
      }) as SessionSnapshot;
    const defaultFake = registerRecordingFake({ listSessions: async () => [copy('one'), copy('two')] });
    resetSessionDriver(getSessionDriver(defaultFake.kind));
    expect(await adoptRunningSessions()).toEqual({ adopted: 0, stopped: 2 });
    expect(log.error).not.toHaveBeenCalledWith(
      'Session discovered on two runtimes; stopping the copy that lost arbitration',
      expect.anything(),
    );
    expect(reapOrphans).toHaveBeenCalledTimes(1);
  });

  it('treats a failed read of the kinds this install used as incomplete discovery: no gateway orphan reap', async () => {
    const read = vi.spyOn(containerConfigs, 'listDriverKindsUsed').mockRejectedValueOnce(new Error('db locked'));
    try {
      const defaultFake = registerRecordingFake();
      resetSessionDriver(getSessionDriver(defaultFake.kind));
      await adoptRunningSessions();
    } finally {
      read.mockRestore();
    }
    expect(log.warn).toHaveBeenCalledWith(
      'Could not read the driver kinds this install has used; discovering the install default only',
      expect.anything(),
    );
    expect(reapOrphans).not.toHaveBeenCalled();
  });

  it('a failed WRITE of the kinds record alone leaves discovery complete: the read already named every kind', async () => {
    const write = vi.spyOn(containerConfigs, 'recordDriverKindsUsed').mockRejectedValueOnce(new Error('db read-only'));
    try {
      const defaultFake = registerRecordingFake();
      resetSessionDriver(getSessionDriver(defaultFake.kind));
      await adoptRunningSessions();
    } finally {
      write.mockRestore();
    }
    expect(reapOrphans).toHaveBeenCalledTimes(1);
  });

  it('arbitrates duplicates without building the selected kind: a missing selected overlay plus copies on two runtimes', async () => {
    let builds = 0;
    const missing = `fake-${++uniqueKind}`;
    registerSessionDriver(missing, () => {
      builds += 1;
      throw new Error('overlay removed');
    });
    await createAgentGroup({
      id: GROUP_ID,
      name: 'Discovery',
      folder: 'discovery',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await ensureContainerConfig(GROUP_ID);
    await setContainerConfigDriver(GROUP_ID, missing);
    const stops: string[] = [];
    const copy = (name: string) =>
      ({
        handle: {
          ...fakeHandle(fixtureSpec({ key: key('sess-dup') })),
          name,
          stop: async (reason: string) => void stops.push(`${name}:${reason}`),
        },
        phase: 'running',
      }) as unknown as SessionSnapshot;
    const other = registerRecordingFake({ listSessions: async () => [copy('other')] });
    await recordDriverKindsUsed([other.kind]);
    const defaultFake = registerRecordingFake({ listSessions: async () => [copy('default')] });
    resetSessionDriver(getSessionDriver(defaultFake.kind));
    expect(await adoptRunningSessions()).toEqual({ adopted: 0, stopped: 2 });
    // Discovery tried the missing kind once; arbitration never built it again.
    expect(builds).toBe(1);
    expect(stops.filter((stop) => stop.endsWith(':duplicate-at-startup'))).toHaveLength(1);
  });
});

describe('adaptSpecToDriver', () => {
  const agentGroup = { id: 'g1', name: 'G', folder: 'agent-one' } as AgentGroup;
  const context = { driverKind: 'fake', provider: 'claude', selectedSkills: () => [], agentGroup, env: {} };

  it('returns the composed spec untouched for a driver declaring none of the gated capabilities', () => {
    const spec = fixtureSpec();
    const before = structuredClone(spec);
    expect(adaptSpecToDriver(spec, HOST_BIND_CAPABILITIES, context)).toBe(spec);
    expect(spec).toEqual(before);
  });

  it('accepts a digest or a non-latest tag on a pinned-images driver', () => {
    const caps = { ...HOST_BIND_CAPABILITIES, pinnedImages: true };
    for (const image of [FIXTURE_PINNED_IMAGE, 'registry:5000/agent:v1', 'agent:dev-abc123']) {
      const spec = fixtureSpec();
      spec.containers[0].image = image;
      expect(() => adaptSpecToDriver(spec, caps, context)).not.toThrow();
    }
    const spec = fixtureSpec();
    spec.containers[0].image = 'registry:5000/agent';
    expect(() => adaptSpecToDriver(spec, caps, context)).toThrow(/untagged/);
  });
});
