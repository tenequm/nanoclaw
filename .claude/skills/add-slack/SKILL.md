---
name: add-slack
description: Add Slack channel integration via Chat SDK.
---

# Add Slack Channel

Adds Slack support via the Chat SDK bridge. NanoClaw doesn't ship channels in
trunk — this skill copies the Slack adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent
reads the prose and applies them, and a parser can apply them deterministically
from the same document. Every directive is idempotent, so the whole skill is
safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter and its registration test

Fetch the `channels` branch and copy the Slack adapter and its registration test
into `src/channels/` (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/slack.ts
src/channels/slack-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './slack.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
@chat-adapter/slack@4.26.0
```

### 4. Build and validate

Build first: it guards the typed `createChatSdkBridge(...)` core call and proves
the dependency is installed. Then run the one integration test.

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/slack-registration.test.ts
```

`slack-registration.test.ts` imports the real channel barrel and asserts the
registry contains `slack`. It goes red if the import line is deleted or drifts,
if the barrel fails to evaluate, or if `@chat-adapter/slack` isn't installed (the
import throws) — so it also covers the dependency from step 3. End-to-end
delivery against a real workspace is verified manually once the service runs.

## Credentials

Walk the operator through creating the Slack app, then collect the two secrets it
hands back. The adapter is already installed and registered — it just can't
receive a message until this is done. Tell the user:

```nc:operator
Create the Slack app:
1. Go to api.slack.com/apps → Create New App → From scratch. Name it (e.g. "NanoClaw") and pick your workspace.
2. OAuth & Permissions → add these Bot Token Scopes: chat:write, im:write, channels:history, groups:history, im:history, channels:read, groups:read, users:read, reactions:write, files:read, files:write.
3. App Home → enable the Messages Tab, and check "Allow users to send Slash commands and messages from the messages tab."
4. Install to Workspace, then copy the Bot User OAuth Token (starts with xoxb-).
5. Basic Information → copy the Signing Secret.
```

Collect the two secrets and store them (the bridge reads them from `.env`):

```nc:prompt bot_token secret validate:^xoxb-
Paste the Bot User OAuth Token — OAuth & Permissions, starts with `xoxb-`.
```
```nc:prompt signing_secret secret validate:^[a-fA-F0-9]{16,}$
Paste the Signing Secret — Basic Information.
```
```nc:env-set
SLACK_BOT_TOKEN={{bot_token}}
SLACK_SIGNING_SECRET={{signing_secret}}
```
```nc:env-sync
```

The bridge serves the webhook on port 3000 at `/webhook/slack` automatically; to
receive replies, that port must be reachable from the internet and registered
with Slack. Tell the user:

```nc:operator
Set up event delivery (needs a public HTTPS URL for port 3000 — ngrok, a Cloudflare Tunnel, or a reverse proxy on a VPS):
1. Event Subscriptions → Enable Events. Set the Request URL to https://<your-public-host>/webhook/slack and wait for the challenge to pass.
2. Subscribe to bot events: message.channels, message.groups, message.im, app_mention. Save Changes.
3. Interactivity & Shortcuts → toggle Interactivity on, set the same Request URL, Save Changes, then reinstall the app when Slack prompts.
```

## Restart

Restart the service so it loads the Slack adapter and the credentials you just
stored, and wait for its CLI socket before wiring:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Resolve your DM channel

The agent talks to you in your direct-message channel with the bot. Resolve its
address so the owner-wiring step can target it. You'll need your Slack member ID:
open your profile (your avatar, bottom-left), then **⋮** → **Copy member ID** — it
starts with `U`.

```nc:prompt owner_handle validate:^U[A-Z0-9]{8,}$
Your Slack member ID (Profile → ⋮ → "Copy member ID"; starts with U).
```

Confirm the bot token works — `auth.test` should come back `ok`:

```nc:run effect:fetch
curl -sf -X POST https://slack.com/api/auth.test -H "Authorization: Bearer {{bot_token}}" | jq -e .ok >/dev/null
```

Open the DM with `conversations.open` and take the channel id it returns as the
conversation address `slack:<channelId>` (if Slack returns no channel, the bot is
missing the `im:write` scope — add it and reinstall):

```nc:run capture:platform_id effect:fetch
curl -s -X POST https://slack.com/api/conversations.open -H "Authorization: Bearer {{bot_token}}" -H "Content-Type: application/json" -d '{"users":"{{owner_handle}}"}' | jq -er '"slack:" + .channel.id'
```

`owner_handle` and `platform_id` are what the owner-wiring step needs. The
greeting goes out over `chat.postMessage`, which works right away; to receive
replies, finish the Event Subscriptions and Interactivity steps above.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire
this channel with `/init-first-agent` (or `/manage-channels`).

## Channel Info

- **type**: `slack`
- **terminology**: Slack has "workspaces" containing "channels." Channels can be public (#general) or private. The bot can also receive direct messages.
- **platform-id-format**: `slack:{channelId}` for channels (e.g., `slack:C0123ABC`), `slack:{dmId}` for DMs (e.g., `slack:D0ARWEBLV63`)
- **how-to-find-id**: Right-click a channel name > "View channel details" — the Channel ID is at the bottom (starts with C). For DMs, the ID starts with D. Or copy the channel link — the ID is the last segment of the URL.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team channels or direct messages
- **default-isolation**: Same agent group for channels where you're the primary user. Separate agent group for channels with different teams or sensitive contexts.
