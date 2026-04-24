/**
 * Concrete service wirings for the telegram-grammy adapter.
 *
 * The adapter runs inside a Promise-based host, so every Layer here is a
 * thin bridge: `Effect.tryPromise` or `Effect.sync` around the existing
 * imperative modules (telegram-pairing, transcription, group-folder,
 * messaging-groups, permissions/users, permissions/user-roles).
 *
 * BotLayer is the resourceful one — it opens the grammY `Bot` via
 * `Effect.acquireRelease` inside `Layer.effect` (v4's replacement for
 * `Layer.scoped`). When the ManagedRuntime disposes, the finalizer stops
 * the bot.
 */
import { Effect, Layer, Schedule } from 'effect';
import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';

import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../../db/messaging-groups.js';
import { resolveGroupFolderForPlatformId } from '../../group-folder.js';
import { grantRole, hasAnyOwner } from '../../modules/permissions/db/user-roles.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { transcribeAudio } from '../../transcription.js';
import { tryConsume } from '../telegram-pairing.js';
import type { PairingRecord } from '../telegram-pairing.js';

import { GrammyNetworkError, PairingFailed } from './errors.js';
import { makePendingSeenRef } from './reactions.js';
import {
  AdapterConfigService,
  BotService,
  GroupFolderService,
  PairingService,
  TranscriptionService,
} from './services.js';

const stopBotSafely = (b: Bot): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      if (b.isRunning()) await b.stop();
    },
    catch: (cause) => cause,
  }).pipe(Effect.catchCause(() => Effect.void));

/** grammY Bot + getMe + lifecycle hooks. `Layer.effect` is scoped in v4. */
export const BotLayer = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const config = yield* AdapterConfigService;

    const bot = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const b = new Bot(config.token);
        b.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
        return b;
      }),
      (b) => stopBotSafely(b),
    );

    const me = yield* Effect.tryPromise({
      try: () => bot.api.getMe(),
      catch: (cause) => new GrammyNetworkError({ method: 'getMe', cause }),
    }).pipe(Effect.retry({ schedule: Schedule.exponential('500 millis'), times: 3 }));

    const pendingSeen = yield* makePendingSeenRef();

    return {
      bot,
      me,
      start: (opts) =>
        Effect.tryPromise({
          try: () => bot.start(opts),
          catch: (cause) => new GrammyNetworkError({ method: 'bot.start', cause }),
        }),
      stop: () => stopBotSafely(bot),
      pendingSeen,
    };
  }),
);

/** Pairing — wraps tryConsume + the DB persistence the legacy adapter had inlined. */
export const PairingLayer = Layer.succeed(PairingService, {
  tryConsume: (input) =>
    Effect.tryPromise({
      try: () => tryConsume(input),
      catch: (cause) => new PairingFailed({ platformId: input.platformId, cause }),
    }),
  persistConsumed: (record: PairingRecord, platformId: string) =>
    Effect.try({
      try: () => {
        const consumed = record.consumed;
        const name = consumed?.name ?? null;
        const isGroup = consumed?.isGroup ?? false;
        const existing = getMessagingGroupByPlatform('telegram', platformId);
        if (existing) {
          updateMessagingGroup(existing.id, { is_group: isGroup ? 1 : 0 });
        } else {
          createMessagingGroup({
            id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            channel_type: 'telegram',
            platform_id: platformId,
            name,
            is_group: isGroup ? 1 : 0,
            unknown_sender_policy: 'strict',
            created_at: new Date().toISOString(),
          });
        }

        // Legacy non-null-asserted adminUserId. We guard it — if the
        // pairing record has no admin user (e.g. a group pairing without
        // an addressable sender), skip the upsertUser + grantRole step
        // rather than fabricate a 'telegram:unknown' ghost.
        const adminUserId = consumed?.adminUserId;
        if (!adminUserId) return;

        const pairedUserId = `telegram:${adminUserId}`;
        upsertUser({
          id: pairedUserId,
          kind: 'telegram',
          display_name: null,
          created_at: new Date().toISOString(),
        });
        if (!hasAnyOwner()) {
          grantRole({
            user_id: pairedUserId,
            role: 'owner',
            agent_group_id: null,
            granted_by: null,
            granted_at: new Date().toISOString(),
          });
        }
      },
      catch: (cause) => new PairingFailed({ platformId, cause }),
    }),
});

/** Best-effort voice-to-text. Errors swallowed — transcription is optional. */
export const TranscriptionLayer = Layer.succeed(TranscriptionService, {
  transcribe: (filePath) =>
    Effect.tryPromise({
      try: () => transcribeAudio(filePath),
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(null))),
});

/** Messaging-group → agent-group folder lookup. Purely synchronous DB reads. */
export const GroupFolderLayer = Layer.succeed(GroupFolderService, {
  resolveForPlatformId: (platformId) => Effect.sync(() => resolveGroupFolderForPlatformId('telegram', platformId)),
});
