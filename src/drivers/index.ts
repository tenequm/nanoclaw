/**
 * Driver selection.
 *
 * `NANOCLAW_RUNTIME_DRIVER` is read once, at first use, and defaults to
 * `docker` — so an install that never sets it behaves exactly as it did before
 * the seam existed. It is the INSTALL default: a group may name another kind
 * in `container_configs.driver` (ratified D1), resolved per group by
 * `sessionDriverForGroup`, one memoized instance per kind. Nothing above this module may branch on the driver's
 * identity: features gate on `capabilities()`, never on `kind`.
 *
 * Selection is a registry, not a switch. Drivers self-register by kind; this
 * module pre-registers `docker`, the only realization that ships here. An
 * overlay adds its own with one `registerSessionDriver(...)` call and one
 * appended import — the same shape as the provider container-config barrel
 * (`src/providers/index.ts`) and the session-egress factory. Nothing outside
 * this file has to be rewritten to install a driver, so an overlay never has to
 * keep a patch of this file's internals in sync with it.
 *
 * A configured kind with no registered driver throws, uniformly. There is no
 * "recognized but uninstalled" tier and no typo tolerance, because there is no
 * difference worth encoding between the two: `=vm` on a host with no vm
 * driver and `=dcoker` on any host are the same operator error — a host
 * configured for one runtime that would otherwise silently run another. A
 * fallback here surfaces later as anything but a configuration problem.
 *
 * CAVEAT for whoever debugs this at 3am: a startup throw under a service
 * manager configured `Restart=always` is a crash loop, and `systemctl is-active`
 * reports `active` throughout one — the loud failure is invisible in the status
 * command an operator reaches for first. The discriminator is the boot-scoped
 * `Session runtime driver selected` line below: a unit that reports active with
 * no such line in the current boot is a host whose driver selection is
 * throwing. That log.info is load-bearing for this reason; do not demote it to
 * debug.
 *
 * Settings are read from `.env` with `process.env` taking precedence. That
 * precedence is not decoration: the host service has no `EnvironmentFile=`,
 * it parses `.env` in-process, so a setting that only consulted `process.env`
 * would be silently ignored when written to the file where every other
 * NanoClaw setting lives.
 */
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { getContainerConfigDriver } from '../db/container-configs.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from '../egress-lockdown.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import '../provider-contracts/index.js';
import { protectedProviderDocumentSourcePaths } from '../provider-contracts/realize.js';

import { DockerSessionDriver, agentContainerName } from './docker-driver.js';
import {
  getSessionDriverFactory,
  listSessionDriverKinds,
  registerSessionDriver,
  type DriverKind,
} from './driver-registry.js';
// Side-effect import: the barrel overlays append their driver's registration to.
// Everything it pulls in registers before this module's body runs, which is the
// whole reason the registry lives in its own module — see `driver-registry.ts`.
import './installed.js';
import { withSessionEvents, type SessionEventsDriver } from './session-events.js';
import type { MountPolicy, SessionDriver, SessionSpec } from './types.js';

const DEFAULT_DRIVER_KIND = 'docker';

const SETTINGS = ['NANOCLAW_RUNTIME_DRIVER', 'NANOCLAW_SESSION_MATERIAL_ROOT'] as const;

/** `process.env` wins, then `.env`, then the default. */
export function readSetting(key: (typeof SETTINGS)[number], env: NodeJS.ProcessEnv = process.env): string {
  return env[key]?.trim() || readEnvFile([...SETTINGS])[key]?.trim() || '';
}

/**
 * Docker's network topology, decided at spawn: the egress-lockdown network
 * when the flag is on (throws rather than spawning with open egress), else the
 * host-gateway mapping Linux needs to reach host services. Injected at
 * registration — the driver stays constructible without it in tests, and
 * composition never sees an argv-shaped network selection: `spec.network`
 * states the intent, this realizes it, and nothing rides between them.
 */
function dockerNetworkArgs(spec: SessionSpec): string[] {
  if (spec.networkAccess.target.kind === 'session-container') return [];
  if (ensureEgressNetwork(spec.networkAccess)) {
    log.info('Egress lockdown active', { containerName: agentContainerName(spec), network: EGRESS_NETWORK });
    return egressNetworkArgs();
  }
  return os.platform() === 'linux' ? [`--add-host=${spec.networkAccess.endpoint}:host-gateway`] : [];
}

registerSessionDriver(
  DEFAULT_DRIVER_KIND,
  (policy) =>
    new DockerSessionDriver({
      ...policy,
      networkArgsFor: dockerNetworkArgs,
      reconcileNetworkAccess: (access) => {
        if (access.target.kind !== 'session-container') ensureEgressNetwork(access);
      },
    }),
);

export function configuredDriverKind(env: NodeJS.ProcessEnv = process.env): DriverKind {
  return readSetting('NANOCLAW_RUNTIME_DRIVER', env).toLowerCase() || DEFAULT_DRIVER_KIND;
}

/**
 * The mount policy every driver enforces. `surfaceRoots` is an enumerated list,
 * never a bare install-root prefix: in this layout the state roots nest inside
 * the project root, so a prefix check would admit the central DB as a
 * mountable "surface".
 */
export function mountPolicy(env: NodeJS.ProcessEnv = process.env): MountPolicy {
  // `config.ts` derives every root from `process.cwd()` (the unit's
  // WorkingDirectory) and does not export it; `buildMounts` reads it the same
  // way, so the two cannot disagree.
  const projectRoot = process.cwd();
  return {
    groupsRoot: GROUPS_DIR,
    dataRoot: DATA_DIR,
    surfaceRoots: [
      path.join(projectRoot, 'container', 'agent-runner', 'src'),
      path.join(projectRoot, 'container', 'skills'),
      // Base documents are read by the host composer, not mounted. Declared
      // protected sources stay here so an overlapping operator mount cannot
      // make prompt-defining install content writable.
      ...protectedProviderDocumentSourcePaths(projectRoot),
    ],
    // Must resolve to the same path an egress overlay's provisioner writes
    // material to, and a provisioner reads this key from `.env`. Reading it
    // from `process.env` alone would leave the two agreeing only by
    // coincidence of their defaults: move it in `.env` and every
    // identity-material mount is denied by a policy naming a path that looks
    // correct.
    materialsRoot: readSetting('NANOCLAW_SESSION_MATERIAL_ROOT', env) || path.join(DATA_DIR, 'session-materials'),
    gatewayTrustRoot: path.join(DATA_DIR, 'gateway-trust'),
  };
}

/**
 * One wrapped instance per kind (ratified D1). Each instance carries its own
 * session-events hub — handles from two drivers are never merged into one
 * key-indexed hub, because the same key can legitimately exist on both while a
 * group moves between them (adoption arbitrates; see container-runner).
 */
const instances = new Map<DriverKind, SessionEventsDriver>();
const createdListeners = new Set<(driver: SessionEventsDriver) => void>();
/** The install default, read once at first use like the selection always was. */
let defaultKind: DriverKind | undefined;

/** The install default kind (`NANOCLAW_RUNTIME_DRIVER`), as selection resolves it. */
export function defaultSessionDriverKind(): DriverKind {
  return (defaultKind ??= configuredDriverKind());
}

/**
 * The memoized driver for `kind`, built on first use; no kind = the install
 * default (`NANOCLAW_RUNTIME_DRIVER`). Per-group selection resolves the kind
 * through `sessionDriverForGroup`; callers that already hold a handle use the
 * driver it came from, never a fresh lookup from mutable group config.
 */
export function getSessionDriver(kind?: DriverKind): SessionEventsDriver {
  const resolved = kind || defaultSessionDriverKind();
  let driver = instances.get(resolved);
  if (!driver) {
    driver = createSessionDriver(resolved);
    instances.set(resolved, driver);
    for (const listener of createdListeners) listener(driver);
  }
  return driver;
}

/**
 * The memoized driver for the group's kind — its `container_configs.driver`,
 * else the install default. Every capability gate about a group resolves here.
 */
export async function sessionDriverForGroup(agentGroupId: string): Promise<SessionEventsDriver> {
  const configured = await getContainerConfigDriver(agentGroupId);
  if (configured) assertGroupDriverKindRegistered(configured, `group ${agentGroupId}`);
  return getSessionDriver(configured);
}

/**
 * A kind named per group rather than by `NANOCLAW_RUNTIME_DRIVER` gets its own
 * refusal, so the operator is pointed at the group's setting, not the install's.
 */
export function assertGroupDriverKindRegistered(kind: DriverKind, subject: string): void {
  if (getSessionDriverFactory(kind)) return;
  throw new Error(
    `${subject} selects driver '${kind}' (container_configs.driver) but no driver is registered for '${kind}'; ` +
      `installed: ${listSessionDriverKinds().join(', ')}. ` +
      'Install the driver skill, or return the group to the install default with `--driver ""`.',
  );
}

export function createSessionDriver(kind: DriverKind, overrides: Partial<MountPolicy> = {}): SessionEventsDriver {
  const factory = getSessionDriverFactory(kind);
  if (!factory) {
    // Name the fix in the first line: the setting, the value it holds, and what
    // this build can actually run. An operator reading only this line has to be
    // able to act on it.
    throw new Error(
      `NANOCLAW_RUNTIME_DRIVER='${kind}' but no driver is registered for '${kind}'; ` +
        `installed: ${listSessionDriverKinds().join(', ')}. ` +
        'Other drivers arrive as overlays — install the driver skill or unset the variable.',
    );
  }
  const policy = { ...mountPolicy(), ...overrides };
  // The session-events hub wraps whatever the factory produced — overlays
  // included — so `onTerminal`/stop-intent semantics are trunk-owned, never
  // re-implemented per driver (see `session-events.ts`).
  const driver: SessionEventsDriver = withSessionEvents(factory(policy));
  // Boot-scoped marker; see the crash-loop caveat at the top of this file.
  log.info('Session runtime driver selected', { driver: driver.kind, capabilities: driver.capabilities() });
  return driver;
}

/**
 * The already-selected default driver, or null — never instantiates. The
 * default-first anchor of `peekSessionDrivers`: a unit suite that never
 * selected a runtime sees null instead of triggering selection as a side effect.
 */
export function peekSessionDriver(): SessionEventsDriver | null {
  return instances.get(defaultSessionDriverKind()) ?? null;
}

/** Every driver instantiated so far, default first when it exists — never instantiates. */
export function peekSessionDrivers(): SessionEventsDriver[] {
  const fallback = peekSessionDriver();
  return [...new Set([...(fallback ? [fallback] : []), ...instances.values()])];
}

/**
 * Run `listener` for every driver instantiated from now on (a kubernetes
 * group's first spawn after the sweep armed, say). Returns the unsubscribe.
 */
export function onSessionDriverCreated(listener: (driver: SessionEventsDriver) => void): () => void {
  createdListeners.add(listener);
  return () => createdListeners.delete(listener);
}

/**
 * Test seam: drop every memoized driver so a suite can select another one. A
 * `next` stands in for the install default's kind.
 */
export function resetSessionDriver(next: SessionDriver | null = null): void {
  // Tests may inject raw fakes; the probe (isSessionEventsDriver) guards resync,
  // and fake handles carry their own onTerminal where flows need it.
  instances.clear();
  defaultKind = undefined;
  if (next) instances.set(defaultSessionDriverKind(), next as SessionEventsDriver);
}

export * from './driver-registry.js';
export * from './label-projection.js';
export * from './session-events.js';
export * from './types.js';
