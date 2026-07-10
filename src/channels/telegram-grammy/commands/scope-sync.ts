/**
 * Startup command-scope janitor.
 *
 * Nanoclaw never called setMyCommands before this feature, but the bot token
 * was inherited from a previous install that DID (63 commands at the default
 * scope, more at all_private_chats). This janitor reconciles Telegram's
 * server-side command scopes with the current admin grants:
 *
 *   1. Compute the current grants (computeCommandGrants -> per admin x chat).
 *   2. Load the scopes THIS install last applied (telegram_command_scopes).
 *   3. deleteMyCommands for the always-stale broad scopes (default,
 *      all_private_chats, all_group_chats, all_chat_administrators) plus every
 *      previously-applied per-chat scope that is no longer granted.
 *   4. setMyCommands for each current grant scope (admin-only popups).
 *   5. Persist the applied scope set for the next run's diff.
 *
 * Direct Bot API calls (not commandGroup.setCommands): the plugin couples a
 * command's popup scope to its handler scope, which would leak a default-scope
 * popup to every user once the commands carry default handlers. Doing the
 * registration here keeps popups admin-only while the CommandGroup handles the
 * commands for everyone. The command set / descriptions still come from the
 * single source of truth (COMMAND_ORDER + COMMANDS).
 *
 * Every Telegram call is individually tolerant: a failure is logged and the
 * janitor moves on. The whole thing is wrapped so a Telegram outage at
 * startup can never crash the (long-running) host.
 *
 * Typography: ASCII only ('-', '...', '->').
 */
import { Effect } from 'effect';
import type { Api } from 'grammy';
import type { BotCommand, BotCommandScope } from 'grammy/types';

import { COMMANDS, COMMAND_ORDER } from '../../../commands/index.js';
import {
  getAppliedCommandScopes,
  replaceAppliedCommandScopes,
  type AppliedCommandScope,
} from '../../../db/telegram-command-scopes.js';
import { log } from '../../../log.js';

import { computeCommandGrants, type CommandGrant } from './grants.js';

/** Broad scopes we always clear (the inherited OpenClaw registrations live here). */
const ALWAYS_PURGE_SCOPES: BotCommandScope[] = [
  { type: 'default' },
  { type: 'all_private_chats' },
  { type: 'all_group_chats' },
  { type: 'all_chat_administrators' },
];

/** The command list pushed to every admin scope (canonical order + descriptions). */
function commandList(): BotCommand[] {
  return COMMAND_ORDER.map((name) => ({ command: name, description: COMMANDS[name].description }));
}

/** Numeric id out of a `telegram:<id>` platform/user id. NaN-safe (returns null). */
function numericId(namespaced: string | undefined): number | null {
  if (!namespaced) return null;
  const part = namespaced.split(':')[1] ?? '';
  const n = Number(part);
  return part !== '' && Number.isFinite(n) ? n : null;
}

export interface ResolvedScope {
  scopeKey: string;
  scope: BotCommandScope;
}

/** Turn a channel-agnostic grant into a Telegram scope + a stable diff key. */
export function grantToScope(grant: CommandGrant): ResolvedScope | null {
  const chatId = numericId(grant.chatPlatformId);
  if (chatId == null) return null;
  if (grant.kind === 'chat') {
    return { scopeKey: `chat:${chatId}`, scope: { type: 'chat', chat_id: chatId } };
  }
  const userId = numericId(grant.userId);
  if (userId == null) return null;
  return {
    scopeKey: `chat_member:${chatId}:${userId}`,
    scope: { type: 'chat_member', chat_id: chatId, user_id: userId },
  };
}

const deleteScope = (api: Api, scope: BotCommandScope): Effect.Effect<void> =>
  Effect.tryPromise({ try: () => api.deleteMyCommands({ scope }), catch: (err) => err }).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning('telegram-grammy: deleteMyCommands failed', { scope, cause })),
  );

const setScope = (api: Api, commands: BotCommand[], scope: BotCommandScope): Effect.Effect<void> =>
  Effect.tryPromise({ try: () => api.setMyCommands(commands, { scope }), catch: (err) => err }).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning('telegram-grammy: setMyCommands failed', { scope, cause })),
  );

/** Parse a persisted scope JSON blob, or null when it is malformed. */
function parseScopeJson(scopeJson: string): BotCommandScope | null {
  try {
    return JSON.parse(scopeJson) as BotCommandScope;
  } catch {
    return null;
  }
}

/**
 * Run the janitor. Total: any failure is logged, never thrown. The independent
 * Telegram round-trips run with bounded concurrency, and installChatCommands
 * forks this so adapter setup never waits on it:
 *
 *   1. One parallel batch of deletes (revoked per-chat scopes + the always-stale
 *      broad scopes).
 *   2. One parallel batch of setMyCommands (one per current admin scope).
 *   3. Persist the applied scope set for the next run's diff.
 *
 * The persist step waits for both batches so a crash mid-sync cannot record
 * scopes that were never actually applied.
 */
export const syncCommandScopes = (api: Api): Effect.Effect<void> =>
  Effect.gen(function* () {
    const grants = computeCommandGrants();
    const resolved: ResolvedScope[] = [];
    for (const g of grants) {
      const r = grantToScope(g);
      if (r) resolved.push(r);
    }
    const currentKeys = new Set(resolved.map((r) => r.scopeKey));

    // Deletes: revoked per-chat scopes (applied before, not granted now) plus
    // the inherited broad scopes we always clear. One bounded-parallel batch.
    const previous = getAppliedCommandScopes();
    const revokedScopes = previous
      .filter((prev) => !currentKeys.has(prev.scopeKey))
      .map((prev) => parseScopeJson(prev.scopeJson))
      .filter((scope): scope is BotCommandScope => scope != null);
    const deletes = [...revokedScopes, ...ALWAYS_PURGE_SCOPES].map((scope) => deleteScope(api, scope));
    yield* Effect.all(deletes, { concurrency: 4, discard: true });

    // Register current admin scopes. One bounded-parallel batch.
    const commands = commandList();
    yield* Effect.all(
      resolved.map((r) => setScope(api, commands, r.scope)),
      { concurrency: 4, discard: true },
    );

    // Persist for the next run's diff.
    const applied: AppliedCommandScope[] = resolved.map((r) => ({
      scopeKey: r.scopeKey,
      scopeJson: JSON.stringify(r.scope),
    }));
    yield* Effect.sync(() => replaceAppliedCommandScopes(applied));

    log.info('telegram-grammy: command scopes synced', {
      granted: applied.length,
      revoked: previous.filter((p) => !currentKeys.has(p.scopeKey)).length,
    });
  }).pipe(Effect.catchCause((cause) => Effect.logError('telegram-grammy: command scope janitor failed', { cause })));
