/**
 * Command-grant computation for popup registration (setMyCommands).
 *
 * Popups are admin-only. This function reads the central DB (user_roles +
 * messaging group wirings) and returns the list of grants describing WHICH
 * scopes should carry the command popup:
 *
 *   - Group chats: one `chat_member` grant per (admin user, chat). "Admin"
 *     means owner, global admin, or a scoped admin of ANY agent wired to that
 *     chat.
 *   - Private DM chats: one `chat` grant when the DM's own user is an
 *     admin/owner over an agent wired to that chat. (A Telegram DM's chat id
 *     equals the user's numeric id, so the mg platform_id already identifies
 *     the DM user.)
 *
 * Grants are PER CHAT, never per topic: Telegram command scopes cannot target
 * a forum topic. Multiple messaging groups (topics) that share one chat id are
 * folded together and their wired-agent admin sets are unioned.
 *
 * This lives in the telegram adapter: it is telegram-specific (channel filter,
 * topic-suffix stripping, the DM-id-equals-chat-id convention). scope-sync.ts
 * consumes it.
 *
 * Typography: ASCII only in strings/comments.
 */
import { getAllMessagingGroups, getMessagingGroupAgents } from '../../../db/messaging-groups.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from '../../../modules/permissions/db/user-roles.js';
import { COMMAND_ORDER, type CommandName } from '../../../commands/index.js';

const TELEGRAM_CHANNEL = 'telegram';

export type CommandGrantKind = 'chat_member' | 'chat';

/**
 * One popup-registration entry. scope-sync turns these into setMyCommands
 * calls scoped by chat / chat_member.
 *
 * - `chat_member`: an admin (userId) gets the commands in a specific group
 *   chat. Emitted once per (admin, chat).
 * - `chat`: the whole chat (a private DM whose user is an admin/owner) gets
 *   the commands. No userId, because a DM's scope is the single user.
 *
 * `chatPlatformId` is always the per-CHAT id with any topic suffix stripped,
 * because Telegram command scopes are per chat, never per topic.
 */
export interface CommandGrant {
  chatPlatformId: string;
  kind: CommandGrantKind;
  userId?: string;
  commands: readonly CommandName[];
}

/**
 * Strip a telegram topic suffix from a platform id, yielding the per-chat id.
 * `telegram:-100123:465` -> `telegram:-100123`; `telegram:95307956` is
 * unchanged (only two colon-parts).
 */
function stripTelegramTopic(platformId: string): string {
  const parts = platformId.split(':');
  return parts.slice(0, 2).join(':');
}

interface ChatAccumulator {
  chatPlatformId: string;
  /** True when any messaging group folded into this chat is a group chat. */
  isGroup: boolean;
  agentGroupIds: Set<string>;
}

/**
 * Compute the command-grant list for all telegram chats wired to an agent.
 *
 * Deterministic ordering: chats sorted by chatPlatformId, then chat grants
 * before chat_member grants, then chat_member grants sorted by userId. This
 * keeps a stable diff for the scope-sync janitor across restarts.
 */
export function computeCommandGrants(): CommandGrant[] {
  // Global admin set (owners + global admins) applies to every wired chat.
  const globalAdminUserIds = new Set<string>();
  for (const r of getOwners()) globalAdminUserIds.add(r.user_id);
  for (const r of getGlobalAdmins()) globalAdminUserIds.add(r.user_id);

  // Fold messaging groups into per-chat accumulators (topics collapse).
  const chats = new Map<string, ChatAccumulator>();
  for (const mg of getAllMessagingGroups()) {
    if (mg.channel_type !== TELEGRAM_CHANNEL) continue;
    const wirings = getMessagingGroupAgents(mg.id);
    if (wirings.length === 0) continue;

    const chatPlatformId = stripTelegramTopic(mg.platform_id);
    let acc = chats.get(chatPlatformId);
    if (!acc) {
      acc = { chatPlatformId, isGroup: false, agentGroupIds: new Set() };
      chats.set(chatPlatformId, acc);
    }
    if (mg.is_group === 1) acc.isGroup = true;
    for (const w of wirings) acc.agentGroupIds.add(w.agent_group_id);
  }

  // Cache scoped-admin lookups per agent group.
  const scopedAdminCache = new Map<string, string[]>();
  const scopedAdminsOf = (agentGroupId: string): string[] => {
    let ids = scopedAdminCache.get(agentGroupId);
    if (!ids) {
      ids = getAdminsOfAgentGroup(agentGroupId).map((r) => r.user_id);
      scopedAdminCache.set(agentGroupId, ids);
    }
    return ids;
  };

  const grants: CommandGrant[] = [];
  for (const acc of chats.values()) {
    const admins = new Set(globalAdminUserIds);
    for (const agId of acc.agentGroupIds) {
      for (const uid of scopedAdminsOf(agId)) admins.add(uid);
    }

    if (acc.isGroup) {
      // One chat_member grant per admin, sorted for a stable diff.
      for (const userId of [...admins].sort((a, b) => a.localeCompare(b))) {
        grants.push({
          chatPlatformId: acc.chatPlatformId,
          kind: 'chat_member',
          userId,
          commands: COMMAND_ORDER,
        });
      }
    } else {
      // Private DM: the chat's own user is the mg platform_id. Emit a chat
      // grant only when that user is an admin/owner over a wired agent.
      const dmUserId = acc.chatPlatformId;
      if (admins.has(dmUserId)) {
        grants.push({
          chatPlatformId: acc.chatPlatformId,
          kind: 'chat',
          commands: COMMAND_ORDER,
        });
      }
    }
  }

  grants.sort((a, b) => {
    const byChat = a.chatPlatformId.localeCompare(b.chatPlatformId);
    if (byChat !== 0) return byChat;
    if (a.kind !== b.kind) return a.kind === 'chat' ? -1 : 1;
    return (a.userId ?? '').localeCompare(b.userId ?? '');
  });

  return grants;
}
