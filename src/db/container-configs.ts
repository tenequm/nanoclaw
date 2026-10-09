import { DEFAULT_AGENT_PROVIDER } from '../config.js';
import type { ContainerConfigRow } from '../types.js';
import { getDb } from './connection.js';

const SCALAR_COLUMNS = new Set([
  'provider',
  'model',
  'effort',
  'image_tag',
  'assistant_name',
  'max_messages_per_prompt',
  'auto_compact_window',
  'cli_scope',
  'timezone',
  'speed',
  'rich_messages',
]);
const JSON_COLUMNS = new Set(['skills', 'mcp_servers', 'packages_apt', 'packages_npm', 'additional_mounts']);

export async function getContainerConfig(agentGroupId: string): Promise<ContainerConfigRow | undefined> {
  return getDb().get<ContainerConfigRow>('SELECT * FROM container_configs WHERE agent_group_id = ?', agentGroupId);
}

export async function getAllContainerConfigs(): Promise<ContainerConfigRow[]> {
  return getDb().all<ContainerConfigRow>('SELECT * FROM container_configs');
}

/** Insert a new config row. Caller must supply all JSON fields (use defaults for empty). */
export async function createContainerConfig(config: ContainerConfigRow): Promise<void> {
  await getDb().run(
    `INSERT INTO container_configs (
        agent_group_id, provider, model, effort, image_tag, assistant_name,
        max_messages_per_prompt, auto_compact_window, skills, mcp_servers, packages_apt, packages_npm,
        additional_mounts, cli_scope, timezone, speed, rich_messages, updated_at
      ) VALUES (
        @agent_group_id, @provider, @model, @effort, @image_tag, @assistant_name,
        @max_messages_per_prompt, @auto_compact_window, @skills, @mcp_servers, @packages_apt, @packages_npm,
        @additional_mounts, @cli_scope, @timezone, @speed, @rich_messages, @updated_at
      )`,
    config,
  );
}

/**
 * Create a config row if one doesn't exist, stamping the provider. Idempotent —
 * no-ops if the row already exists, so an existing group's provider is never
 * overwritten (load-bearing: this is how the global default stays "new groups
 * only" for groups that already have a row).
 *
 * An absent `provider` takes the instance default (`DEFAULT_AGENT_PROVIDER`);
 * `claude` and an absent value that resolves to claude are stored as NULL — the
 * column means "follows the built-in default", matching pre-feature rows.
 */
export async function ensureContainerConfig(agentGroupId: string, provider?: string | null): Promise<void> {
  // Single chokepoint for the instance default: a fresh row with no explicit
  // provider is stamped with DEFAULT_AGENT_PROVIDER, so every new-group creation
  // path inherits it without each having to remember. INSERT OR IGNORE keeps an
  // EXISTING row untouched — so this stays "new groups only" for any group that
  // already has a config row (backfillContainerConfigs seeds one for every group
  // at host startup; a non-claude default would only reach a row-less *legacy*
  // group if a creation script reused it before that first backfill ran). Callers
  // that know the provider (subagent → parent's, spawn → resolved) pass it
  // explicitly and override the default.
  // `claude` (the built-in default) and casing normalize to NULL/lowercase so the
  // column matches what resolution lowercases to.
  const normalized = (provider ?? DEFAULT_AGENT_PROVIDER).toLowerCase();
  const stamped = normalized && normalized !== 'claude' ? normalized : null;
  await getDb().run(
    `INSERT INTO container_configs (agent_group_id, provider, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (agent_group_id) DO NOTHING`,
    agentGroupId,
    stamped,
    new Date().toISOString(),
  );
}

/** Update scalar fields on a config row. Only touches fields present in `updates`. */
export async function updateContainerConfigScalars(
  agentGroupId: string,
  updates: Partial<
    Pick<
      ContainerConfigRow,
      | 'provider'
      | 'model'
      | 'effort'
      | 'image_tag'
      | 'assistant_name'
      | 'max_messages_per_prompt'
      | 'auto_compact_window'
      | 'cli_scope'
      | 'timezone'
      | 'speed'
      | 'rich_messages'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { agent_group_id: agentGroupId };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      if (!SCALAR_COLUMNS.has(key)) throw new Error(`Invalid scalar column: ${key}`);
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  fields.push('updated_at = @updated_at');
  values.updated_at = new Date().toISOString();

  await getDb().run(`UPDATE container_configs SET ${fields.join(', ')} WHERE agent_group_id = @agent_group_id`, values);
}

/** Overwrite a JSON column wholesale. Used for skills, mcp_servers, packages_*, additional_mounts. */
export async function updateContainerConfigJson(
  agentGroupId: string,
  column: 'skills' | 'mcp_servers' | 'packages_apt' | 'packages_npm' | 'additional_mounts',
  value: unknown,
): Promise<void> {
  if (!JSON_COLUMNS.has(column)) throw new Error(`Invalid JSON column: ${column}`);
  const now = new Date().toISOString();
  await getDb().run(
    `UPDATE container_configs SET ${column} = ?, updated_at = ? WHERE agent_group_id = ?`,
    JSON.stringify(value),
    now,
    agentGroupId,
  );
}

export async function deleteContainerConfig(agentGroupId: string): Promise<void> {
  await getDb().run('DELETE FROM container_configs WHERE agent_group_id = ?', agentGroupId);
}

/**
 * The group's configured session runtime kind, or undefined for "the install
 * default". A missing config row is the default too: spawn materializes the
 * row, and a group that has none has never been moved off the default.
 */
export async function getContainerConfigDriver(agentGroupId: string): Promise<string | undefined> {
  const row = await getDb().get<{ driver: string | null }>(
    'SELECT driver FROM container_configs WHERE agent_group_id = ?',
    agentGroupId,
  );
  return row?.driver || undefined;
}

/**
 * Set (or clear, with null) a group's runtime kind and record it as used. The
 * caller owns the refusal rules (registered kind, no live or retained objects
 * on the old driver); this only writes.
 */
export async function setContainerConfigDriver(agentGroupId: string, driver: string | null): Promise<void> {
  await getDb().run(
    'UPDATE container_configs SET driver = ?, updated_at = ? WHERE agent_group_id = ?',
    driver,
    new Date().toISOString(),
    agentGroupId,
  );
  if (driver) await recordDriverKindsUsed([driver]);
}

/** Add kinds to the kinds-ever-used record (migration 029). Never removes. */
export async function recordDriverKindsUsed(kinds: readonly string[]): Promise<void> {
  const now = new Date().toISOString();
  for (const kind of new Set(kinds.filter(Boolean))) {
    await getDb().run(
      'INSERT INTO runtime_driver_kinds (kind, first_used_at) VALUES (?, ?) ON CONFLICT (kind) DO NOTHING',
      kind,
      now,
    );
  }
}

/** Every kind this install has ever configured, oldest first. */
export async function listDriverKindsUsed(): Promise<string[]> {
  const rows = await getDb().all<{ kind: string }>(
    'SELECT kind FROM runtime_driver_kinds ORDER BY first_used_at, kind',
  );
  return rows.map((row) => row.kind);
}

/** Every kind a group's config row names today (distinct, non-null). */
export async function listConfiguredDriverKinds(): Promise<string[]> {
  const rows = await getDb().all<{ driver: string }>(
    "SELECT DISTINCT driver FROM container_configs WHERE driver IS NOT NULL AND driver <> ''",
  );
  return rows.map((row) => row.driver);
}
