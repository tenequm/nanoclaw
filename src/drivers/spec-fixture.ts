/**
 * The one session spec every driver test starts from.
 *
 * Shared so assertions about two drivers are demonstrably about the same
 * input — which is what makes the conformance cases mean anything. Only the
 * Docker driver ships in this tree; an out-of-tree driver plugs its harness
 * into the same suite against this same fixture.
 *
 * `fixtureSpec()` is the agent-only session this tree's realization actually
 * runs. `fixtureSpecWithAux()` adds an overlay-composed auxiliary container:
 * it exercises the multi-container contract rules (identity-material custody
 * and per-role mount checks) through `validateSpec` and each driver's declared
 * auxiliary-container capability.
 */
import type { ContainerSpec, DriverCapabilities, MountPolicy, MountSpec, SessionSpec } from './types.js';

export const FIXTURE_POLICY: MountPolicy = {
  groupsRoot: '/install/groups',
  dataRoot: '/install/data',
  surfaceRoots: ['/install/container/agent-runner/src', '/install/container/skills', '/install/container/CLAUDE.md'],
  materialsRoot: '/install/data/session-materials',
  gatewayTrustRoot: '/install/data/gateway-trust',
};

export function fixtureSpec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  const spec: SessionSpec = {
    key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' },
    labels: {
      'nanoclaw-container-name': 'nanoclaw-v2-agent-one-1700000000000',
      // D9: composition stamps the group folder for admission to join on.
      'nanoclaw-group-folder': 'agent-one',
    },
    containers: [
      {
        role: 'agent',
        image: 'nanoclaw-agent:spike-p0',
        env: { TZ: 'UTC', HTTPS_PROXY: 'http://127.0.0.1:15001' },
        command: ['bash', '-c'],
        args: ['exec bun run /app/src/index.ts'],
        labels: { 'session-channel': 'channel-abc' },
        mounts: [
          {
            class: 'group-state',
            hostPath: '/install/data/v2-sessions/g1/s1',
            containerPath: '/workspace',
            mode: 'rw',
            groupScope: 'g1',
          },
          {
            class: 'install-surface',
            hostPath: '/install/container/agent-runner/src',
            containerPath: '/app/src',
            mode: 'ro',
            groupScope: 'g1',
          },
          {
            class: 'install-surface',
            hostPath: '/install/container/CLAUDE.md',
            containerPath: '/app/CLAUDE.md',
            mode: 'ro',
            groupScope: 'g1',
          },
        ],
      },
    ],
    network: 'shared-private',
    networkAccess: { endpoint: 'host.internal', target: { kind: 'host' } },
    hardening: 'standard',
    resources: { shmSizeMb: 1024, pidsLimit: 2048 },
    runtimeTier: 'container',
    runAs: { uid: 501, gid: 1000 },
    stopGraceSeconds: 1,
    ...overrides,
  };
  return spec;
}

/**
 * An overlay-composed auxiliary container: exercises every multi-container
 * rule (identity-material custody, per-role mount checks) without this tree
 * shipping such a composer itself.
 */
export function fixtureAuxContainer(): ContainerSpec {
  return {
    role: 'egress-proxy',
    image: 'example-egress-proxy:test',
    env: { PROXY_LISTEN_ADDR: '0.0.0.0:15001' },
    mounts: [
      {
        class: 'identity-material',
        hostPath: '/install/data/session-materials/channel-abc-XXXX/session-key.pem',
        containerPath: '/run/session/session-key.pem',
        mode: 'ro',
        groupScope: 'g1',
      },
      {
        // A deployment CA from outside the material root — NOT the material
        // root. A fixture where every auxiliary mount shared one root could
        // not distinguish a correct classification from a uniform one, and a
        // uniform one shipped: it denied every spawn on the node while this
        // suite stayed green.
        class: 'allowlisted-extra',
        hostPath: '/pki/upstream-ca.pem',
        containerPath: '/run/session/upstream-ca.pem',
        mode: 'ro',
        groupScope: 'g1',
      },
    ],
  };
}

/** The two-container session an overlay composes; see the module comment. */
export function fixtureSpecWithAux(overrides: Partial<SessionSpec> = {}): SessionSpec {
  const spec = fixtureSpec({
    networkAccess: { endpoint: 'egress-proxy', target: { kind: 'session-container', role: 'egress-proxy' } },
    ...overrides,
  });
  spec.containers = [...spec.containers, fixtureAuxContainer()];
  return spec;
}

/**
 * The capabilities a driver with no view of the host filesystem declares
 * (the kubernetes MVP, brief section 3). Composition tests register a fake
 * driver with these; the real driver's declaration must match them field for
 * field, so a gate proven against the fake is the gate the driver gets.
 */
export const FIXTURE_GROUP_VOLUME_CAPABILITIES: DriverCapabilities = {
  isolationTiers: ['container'],
  admissionEnforced: false,
  networkPolicy: 'declarative',
  encryptedVolumes: false,
  unrealized: ['pidsLimit'],
  sharedNetworkNamespace: true,
  auxiliaryContainers: false,
  imageBuild: false,
  imageCarriedSurfaces: true,
  storage: 'group-volume',
  providerContracts: ['claude'],
  sessionsPerGroup: 'one',
  pinnedImages: true,
  hostAddress: '192.168.97.254',
};

/** A legal 63-byte folder: its lineage container-name label (12 + 63 + 14 bytes) must be projected. */
export const FIXTURE_LONG_GROUP_FOLDER = `agent-${'x'.repeat(56)}1`;

/** The digest-pinned agent image a group on a pull-by-reference runtime must name. */
export const FIXTURE_PINNED_IMAGE =
  'ghcr.io/tenequm/nanoclaw-agent-k8s@sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff';

export const FIXTURE_SURFACE_IMAGE =
  'ghcr.io/tenequm/nanoclaw-agent-src@sha256:aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233';

/**
 * What composition hands a 'group-volume' driver for one plain session: no
 * install-surface, plugins, pond or operator mounts; group-state directories
 * classified onto the group volume by the subPath rule; the session context,
 * container.json, project document and the gateway's trust material and
 * credential stub as read-only file snapshots; the agent image's own user;
 * Claude provider state to initialize.
 *
 * `longFolder` swaps in `FIXTURE_LONG_GROUP_FOLDER` (lineage-label projection);
 * `surfaceImage` adds the ImageVolume surfaces (ruling 8b.4; absent = baked).
 */
export function fixtureGroupVolumeSpec(
  overrides: Partial<SessionSpec> = {},
  options: { longFolder?: boolean; surfaceImage?: boolean } = {},
): SessionSpec {
  const folder = options.longFolder ? FIXTURE_LONG_GROUP_FOLDER : 'agent-one';
  const vol = (hostPath: string, containerPath: string, subPath: string): MountSpec => ({
    class: 'group-state',
    hostPath,
    containerPath,
    mode: 'rw',
    groupScope: 'g1',
    realization: { kind: 'group-volume', subPath },
  });
  const file = (cls: MountSpec['class'], hostPath: string, containerPath: string): MountSpec => ({
    class: cls,
    hostPath,
    containerPath,
    mode: 'ro',
    groupScope: 'g1',
    realization: { kind: 'file-snapshot' },
  });
  const agent: ContainerSpec = {
    role: 'agent',
    image: FIXTURE_PINNED_IMAGE,
    env: {
      TZ: 'UTC',
      HOME: '/home/node',
      NANOCLAW_WAKE_REASON: 'message',
    },
    contributedEnv: {
      HTTPS_PROXY: 'http://x:placeholder@192.168.97.254:10255',
      ANTHROPIC_BASE_URL: 'http://192.168.97.254:10255',
      SSL_CERT_FILE: '/tmp/onecli-combined-ca.pem',
    },
    command: ['bash', '-c'],
    args: ['exec bun run /app/src/index.ts'],
    mounts: [
      vol('/install/data/v2-sessions/g1/s1', '/workspace', 'v2-sessions/g1/s1'),
      file('group-state', '/install/data/v2-sessions/g1/.context/s1.json', '/app/.nanoclaw-session.json'),
      vol(`/install/groups/${folder}`, '/workspace/agent', folder),
      file('group-state', `/install/groups/${folder}/container.json`, '/workspace/agent/container.json'),
      file('group-state', `/install/groups/${folder}/CLAUDE.md`, '/workspace/agent/CLAUDE.md'),
      vol('/install/data/v2-sessions/g1/.claude-shared', '/home/node/.claude', 'v2-sessions/g1/.claude-shared'),
      file('allowlisted-extra', '/install/data/onecli/ca-0123abcd.pem', '/tmp/onecli-proxy-ca.pem'),
      file('allowlisted-extra', '/install/data/onecli/combined-4567cdef.pem', '/tmp/onecli-combined-ca.pem'),
      file('allowlisted-extra', '/install/data/onecli/stub-89abef01.json', '/home/node/.config/gh/hosts.yml'),
    ],
    ...(options.surfaceImage && {
      surfaceImage: {
        image: FIXTURE_SURFACE_IMAGE,
        mounts: [
          { imagePath: 'src', containerPath: '/app/src' },
          { imagePath: 'skills', containerPath: '/app/skills' },
        ],
      },
    }),
  };
  return {
    key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' },
    labels: {
      'nanoclaw-container-name': `nanoclaw-v2-${folder}-1700000000000`,
      'nanoclaw-group-folder': folder,
    },
    containers: [agent],
    network: 'shared-private',
    networkAccess: { endpoint: '192.168.97.254', target: { kind: 'runtime', identity: 'onecli' } },
    hardening: 'standard',
    resources: { shmSizeMb: 1024, pidsLimit: 2048 },
    runtimeTier: 'container',
    runAs: { uid: 1000, gid: 1000 },
    stopGraceSeconds: 1,
    providerState: [
      {
        provider: 'claude',
        subPath: 'v2-sessions/g1/.claude-shared',
        createIfMissing: [{ relativePath: 'settings.json', content: '{\n  "autoMemoryEnabled": false\n}\n' }],
        skillLinks: { relativeDir: 'skills', targetRoot: '/app/skills', names: ['welcome', 'agent-browser'] },
      },
    ],
    ...overrides,
  };
}
