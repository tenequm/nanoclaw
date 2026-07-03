/**
 * Pond recall mounts — skill-owned logic behind the single `buildMounts`
 * reach-in (.claude/skills/add-pond).
 *
 * Decides which pond stores a group's container may see. The decision is
 * host-side and filesystem-driven, never agent-influenced:
 *
 * - Own store (`data/pond/groups/<agent_group_id>`): mounted whenever it
 *   exists. It only ever contains this group's own transcripts, so it is
 *   exactly as private as the `.claude-shared` mount it derives from.
 * - Shared store (`data/pond/shared`, union of every group's transcripts)
 *   and an operator store (an external pond, e.g. your personal one): both
 *   cross a group-isolation boundary, so they are mounted only for groups
 *   explicitly granted in `data/pond/access.json` — a host-only file no
 *   container can reach or edit.
 *
 * Everything is read-only; pond's MCP surface is read-only by design and the
 * ro mount enforces it even against a direct `pond` invocation in the shell.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

import type { VolumeMount } from './providers/provider-container-registry.js';

/** Container-side root; `pond-mcp.ts` in the agent-runner probes these paths. */
export const POND_CONTAINER_ROOT = '/workspace/extra/pond';

/** Embedding model pond embeds queries with; synced stores carry its vectors. */
const POND_MODEL_CACHE_SUBPATH = path.join(
  '.cache',
  'huggingface',
  'hub',
  'models--intfloat--multilingual-e5-small',
);

interface PondAccessConfig {
  shared?: { groups?: string[] };
  operator?: { path?: string; groups?: string[] };
}

function readAccessConfig(pondDir: string): PondAccessConfig {
  const accessPath = path.join(pondDir, 'access.json');
  try {
    return JSON.parse(fs.readFileSync(accessPath, 'utf8')) as PondAccessConfig;
  } catch {
    // Absent or malformed access file → no cross-group grants. Own-store
    // mounting never depends on this file, so the safe default is silent.
    return {};
  }
}

/**
 * Pond mounts for one agent group. Returns [] until the operator has run a
 * first sync (no store directories yet), so the reach-in is a no-op on
 * installs without the skill configured.
 */
export function pondMounts(agentGroupId: string, dataDir: string): VolumeMount[] {
  const pondDir = path.join(dataDir, 'pond');
  const mounts: VolumeMount[] = [];

  const ownStore = path.join(pondDir, 'groups', agentGroupId);
  if (fs.existsSync(ownStore)) {
    mounts.push({
      hostPath: ownStore,
      containerPath: `${POND_CONTAINER_ROOT}/own`,
      readonly: true,
    });
  }

  const access = readAccessConfig(pondDir);

  const sharedStore = path.join(pondDir, 'shared');
  if (access.shared?.groups?.includes(agentGroupId) && fs.existsSync(sharedStore)) {
    mounts.push({
      hostPath: sharedStore,
      containerPath: `${POND_CONTAINER_ROOT}/shared`,
      readonly: true,
    });
  }

  const operatorStore = access.operator?.path;
  if (operatorStore && access.operator?.groups?.includes(agentGroupId)) {
    const resolved = operatorStore.startsWith('~/')
      ? path.join(os.homedir(), operatorStore.slice(2))
      : operatorStore;
    if (fs.existsSync(resolved)) {
      mounts.push({
        hostPath: resolved,
        containerPath: `${POND_CONTAINER_ROOT}/operator`,
        readonly: true,
      });
    }
  }

  // Query-side embedding model: pond embeds the *query* at search time, so
  // vector search inside the (offline) container needs the model weights the
  // host sync already downloaded. Only the one model directory is mounted —
  // never the whole HF cache, which can hold an auth token.
  if (mounts.length > 0) {
    const hostModelCache = path.join(os.homedir(), POND_MODEL_CACHE_SUBPATH);
    if (fs.existsSync(hostModelCache)) {
      mounts.push({
        hostPath: hostModelCache,
        containerPath: path.join('/home/node', POND_MODEL_CACHE_SUBPATH),
        readonly: true,
      });
    }
  }

  return mounts;
}
