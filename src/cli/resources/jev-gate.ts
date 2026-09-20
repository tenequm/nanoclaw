/**
 * `ncl jev-gate get|update` — the operator surface for the Jev ambient
 * wake-gate's per-wiring config (`data/jev-gate.json`).
 *
 * Config lives in a file, not a table, so no generic CRUD verb is enabled and
 * `table` is never queried. `update` is approval-gated: an agent asking to
 * loosen its own wake gate is exactly the request a human should see, and the
 * guard's group-scope rule (cli/guard.ts) pins it to its own group.
 */
import { DEFAULT_ENTRY, gateConfigPath, loadGateConfig, writeGateEntry } from '../../modules/jev-gate/index.js';
import { registerResource } from '../crud.js';
import type { JevGateEntry, JevGatePatch, JevThresholds } from '../../modules/jev-gate/index.js';

function requireGroup(args: Record<string, unknown>): string {
  const group = args.group;
  if (typeof group !== 'string' || group.length === 0) throw new Error('--group <agent-group-id> is required');
  return group;
}

function renderEntry(data: unknown): string {
  const row = data as { agent_group_id: string; config: JevGateEntry; configured: boolean };
  const c = row.config;
  const thresholds = Object.entries(c.thresholds)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return [
    `agent_group_id=${row.agent_group_id} configured=${row.configured}`,
    `enabled=${c.enabled} mode=${c.mode} daily_cap=${c.daily_cap} cooldown_minutes=${c.cooldown_minutes} max_consecutive_bot=${c.max_consecutive_bot}`,
    `thresholds: ${thresholds}`,
    `file: ${gateConfigPath()}`,
  ].join('\n');
}

registerResource({
  name: 'jev-gate',
  plural: 'jev-gate',
  // No generic operations: the config is a JSON file, so nothing here is SQL.
  table: '',
  description:
    'Jev ambient wake-gate config, per wiring (data/jev-gate.json). With engage_mode=pattern and pattern ".", every message engages and this gate decides which ones are worth waking the agent for; the rest are stored as silent context. No entry = gate off = upstream behavior.',
  idColumn: 'agent_group_id',
  columns: [
    { name: 'agent_group_id', type: 'string', description: 'The wired agent group this gate config applies to.' },
    { name: 'enabled', type: 'boolean', description: 'Off = router behaves exactly as upstream.' },
    {
      name: 'mode',
      type: 'string',
      enum: ['live', 'shadow'],
      description:
        'shadow suppresses every ambient message (the pre-gate baseline) while annotating what live would have done.',
    },
    { name: 'daily_cap', type: 'number', description: 'Max gate-granted wakes per local day. 0 = no cap.' },
    { name: 'cooldown_minutes', type: 'number', description: 'Quiet period after a granted wake. 0 = no cooldown.' },
    {
      name: 'max_consecutive_bot',
      type: 'number',
      description: 'Consecutive bot-authored gate wakes (no human in between) before the loop guard silences. 0 = off.',
    },
    {
      name: 'thresholds',
      type: 'json',
      description: 'Noul cut-offs: direct_invitation, unresolved, already_answered, human_pingpong.',
    },
  ],
  operations: {},
  customOperations: {
    get: {
      access: 'open',
      description:
        'Show the gate config for one agent group. Reports the defaults with configured=false when the file has no entry for it.',
      args: [{ name: 'group', type: 'string', required: true, description: 'Agent group id.' }],
      examples: ['ncl jev-gate get --group 9ecd6254-8ff5-4f2b-bdba-d56e320af3a7'],
      handler: async (args) => {
        const group = requireGroup(args);
        const entry = loadGateConfig()[group];
        return { agent_group_id: group, configured: entry !== undefined, config: entry ?? DEFAULT_ENTRY };
      },
      formatHuman: renderEntry,
    },
    update: {
      access: 'approval',
      description:
        'Create or change the gate config for one agent group. Only the flags you pass change; the rest keep their current (or default) value.',
      args: [
        { name: 'group', type: 'string', required: true, description: 'Agent group id.' },
        { name: 'enabled', type: 'boolean', description: 'Turn the gate on or off.' },
        {
          name: 'mode',
          type: 'string',
          enum: ['live', 'shadow'],
          description: 'live applies verdicts; shadow only annotates.',
        },
        { name: 'daily_cap', type: 'number', description: 'Max gate-granted wakes per local day. 0 = no cap.' },
        {
          name: 'cooldown_minutes',
          type: 'number',
          description: 'Quiet period after a granted wake. 0 = no cooldown.',
        },
        { name: 'max_consecutive_bot', type: 'number', description: 'Bot-loop guard length. 0 = off.' },
        {
          name: 'thresholds',
          type: 'json',
          description: 'Partial JSON object of Noul cut-offs, e.g. \'{"direct_invitation":0.75}\'.',
        },
      ],
      examples: [
        'ncl jev-gate update --group 9ecd6254-8ff5-4f2b-bdba-d56e320af3a7 --enabled true --mode shadow',
        'ncl jev-gate update --group 9ecd6254-8ff5-4f2b-bdba-d56e320af3a7 --mode live --daily-cap 50',
        'ncl jev-gate update --group 9ecd6254-8ff5-4f2b-bdba-d56e320af3a7 --thresholds \'{"unresolved":0.7}\'',
      ],
      handler: async (args) => {
        const group = requireGroup(args);
        const patch: JevGatePatch = {};
        if (typeof args.enabled === 'boolean') patch.enabled = args.enabled;
        if (args.mode !== undefined) {
          if (args.mode !== 'live' && args.mode !== 'shadow') throw new Error('--mode must be live or shadow');
          patch.mode = args.mode;
        }
        for (const key of ['daily_cap', 'cooldown_minutes', 'max_consecutive_bot'] as const) {
          if (typeof args[key] === 'number') {
            if (args[key] < 0) throw new Error(`--${key.replace(/_/g, '-')} must be 0 or more`);
            patch[key] = args[key] as number;
          }
        }
        if (args.thresholds !== undefined) {
          const raw = args.thresholds;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error('--thresholds must be a JSON object');
          const thresholds: Partial<JevThresholds> = {};
          for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
            if (!(key in DEFAULT_ENTRY.thresholds)) throw new Error(`unknown threshold "${key}"`);
            if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
              throw new Error(`threshold "${key}" must be a number between 0 and 1`);
            }
            thresholds[key as keyof JevThresholds] = value;
          }
          patch.thresholds = thresholds;
        }
        const config = writeGateEntry(group, patch);
        return { agent_group_id: group, configured: true, config };
      },
      formatHuman: renderEntry,
    },
  },
});
