---
name: add-telegram-bot-api-server
description: Lift the Telegram 20 MB inbound / 50 MB outbound file caps by running a self-hosted Telegram Bot API server (tdlib/telegram-bot-api) in `--local` mode. Use when the user reports that large files (PDFs, videos, screenshots) sent via Telegram never reach the agent, or when they explicitly ask to support files >20 MB. Triggers on "telegram large files", "20 MB telegram", "self-hosted bot api", "telegram-bot-api docker", "files too large telegram".
---

# Add Self-Hosted Telegram Bot API Server (`--local` mode)

Telegram's cloud Bot API hard-limits bot file transfers: **20 MB inbound** (via `getFile`) and **50 MB outbound**. The only supported way around this is to run your own [Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server) in **`--local` mode** (the `--local` flag is what actually lifts the cap; without it the server is just a transparent proxy with the same 20 MB limit). That gets you up to **2 GB** in both directions (4 GB down with Telegram Premium senders).

This skill is **opt-in** and **standalone**. The default `/add-telegram` flow is unchanged — only run this skill if a user has explicitly hit the 20 MB ceiling and wants to lift it.

## How it works (so you can debug it later)

```
Telegram cloud
    ↓ (MTProto, owns the 2 GB protocol cap)
docker: aiogram/telegram-bot-api  --local --dir=/var/lib/telegram-bot-api
    ↓ (HTTP localhost:8081 for getMe/sendMessage/etc.)
    ↓ (bind-mounted ./files for inbound file bytes — `--local` mode means
    ↓  getFile returns absolute container paths like
    ↓  /var/lib/telegram-bot-api/<bot_id>:<...>/documents/...pdf)
nanoclaw host (TELEGRAM_API_ROOT + TELEGRAM_LOCAL_FILES_DIR)
    ↓ (@grammyjs/files plugin's buildFilePath remaps container path
    ↓  → host path, then fs.copyFile into the agent's attachments folder)
agent
```

## Pre-flight

Confirm Telegram is already set up:

```bash
grep -q '^TELEGRAM_BOT_TOKEN=' .env && echo "ok" || echo "run /add-telegram first"
```

If the bot token isn't there, stop and run `/add-telegram` first.

Confirm Docker is available:

```bash
docker --version
```

## 1. Get `api_id` and `api_hash`

These come from the user's Telegram **account** (not the bot). Free, one-time, reusable across every bot the user owns.

Tell the user:

1. Open <https://my.telegram.org/apps> in a browser.
2. Sign in with their Telegram phone number (Telegram sends a code to the app).
3. Fill out "Create new application" — any title/description works (e.g. "nanoclaw-self-host").
4. Copy:
   - **App api_id** (numeric)
   - **App api_hash** (32-char hex)

Have them paste both back. Stash as shell vars:

```bash
read -p "api_id: " TG_API_ID
read -p "api_hash: " TG_API_HASH
```

## 2. Create the docker-compose layout

We use a **bind mount** (not a named volume) because nanoclaw needs to read files from the bot-api server's working directory. We also run the container as the host user so file permissions Just Work.

```bash
mkdir -p data/telegram-bot-api/files
HOST_UID=$(id -u)
HOST_GID=$(id -g)
PROJECT_ROOT=$(pwd)

# Write data/telegram-bot-api/.env (gitignored — credentials)
cat > data/telegram-bot-api/.env <<EOF
TELEGRAM_API_ID=$TG_API_ID
TELEGRAM_API_HASH=$TG_API_HASH
HOST_UID=$HOST_UID
HOST_GID=$HOST_GID
EOF
chmod 600 data/telegram-bot-api/.env

# Write the compose file
cat > data/telegram-bot-api/docker-compose.yml <<'EOF'
services:
  telegram-bot-api:
    image: aiogram/telegram-bot-api:9.6
    # Container name must NOT start with `nanoclaw-` — nanoclaw's
    # orphan-cleanup at startup (`src/container-runtime.ts`) filters by
    # that prefix and would stop this server.
    container_name: tg-bot-api
    restart: unless-stopped
    user: "${HOST_UID}:${HOST_GID}"
    ports:
      - "127.0.0.1:8081:8081"
    environment:
      TELEGRAM_API_ID: ${TELEGRAM_API_ID}
      TELEGRAM_API_HASH: ${TELEGRAM_API_HASH}
      TELEGRAM_LOCAL: 1   # any non-empty value triggers --local
      TELEGRAM_STAT: 1
    volumes:
      - ./files:/var/lib/telegram-bot-api
EOF
```

> **Why no `volumes:` named volume?** With `--local` mode, the server returns absolute *container* paths in `getFile`. Nanoclaw needs to read those bytes; the only way to bridge is a host bind-mount so the path resolves on both sides. The plugin's `buildFilePath` hook does the prefix swap (`/var/lib/telegram-bot-api/...` → `<project>/data/telegram-bot-api/files/...`).

> **Why pin `:9.6`?** Current release on Docker Hub at install time. `:latest` aliases to it. Update by bumping this number when a new minor version stabilizes.

## 3. Log the bot out of the cloud Bot API (one-way switch)

A bot can only be connected to one Bot API server at a time. Before pointing it at the local server, log it out from `api.telegram.org`:

```bash
TOKEN=$(awk -F= '$1=="TELEGRAM_BOT_TOKEN" {print $2}' .env | tr -d '"' | tr -d "'")
curl -fsS "https://api.telegram.org/bot${TOKEN}/logOut"
```

Expected response: `{"ok":true,"result":true}`.

**This is one-way for this session.** To switch back to the cloud API later, the user will need to call `/logOut` against the *local* server before the cloud will accept the bot again. See the rollback section.

## 4. Start the local Bot API server

```bash
cd data/telegram-bot-api && docker compose up -d && cd -
sleep 3
```

Sanity check:

```bash
curl -fsS "http://localhost:8081/bot${TOKEN}/getMe"
```

Should return `{"ok":true,"result":{...bot info...}}`. Common failures:
- `Bad Request: bot was not authorized` → step 3's `logOut` didn't take. Re-run.
- `connection refused` → container isn't up. Check `docker compose -f data/telegram-bot-api/docker-compose.yml ps`.

## 5. Tell nanoclaw to use the local server

Persist two env vars to `.env` (idempotent upserts):

```bash
LOCAL_FILES_DIR="${PROJECT_ROOT}/data/telegram-bot-api/files"

upsert_env() {
  local key="$1"
  local val="$2"
  if grep -q "^${key}=" .env; then
    awk -v k="$key" -v v="$val" '$0 ~ "^"k"=" {print k"="v; next} {print}' .env > .env.tmp && mv .env.tmp .env
  else
    echo "${key}=${val}" >> .env
  fi
}

upsert_env TELEGRAM_API_ROOT "http://localhost:8081"
upsert_env TELEGRAM_LOCAL_FILES_DIR "$LOCAL_FILES_DIR"

# Optional: cap below 2 GB, e.g. 500 MB
# upsert_env TELEGRAM_MAX_FILE_MB "500"
```

Sync to container env directory if used:

```bash
mkdir -p data/env && cp .env data/env/env
```

Restart nanoclaw so the new env vars are picked up:

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw
```

## 6. Verify

In `logs/nanoclaw.log` after restart you should see:

```
Channel adapter started channel=telegram type=telegram
```

— with no `TelegramConfigInvalid` errors. If you see `TELEGRAM_LOCAL_FILES_DIR ... directory does not exist`, step 4 didn't run; the bind-mount target needs to exist on the host before nanoclaw starts.

Have the user send a >20 MB file in Telegram. Confirm:
- The file appears under `data/telegram-bot-api/files/<bot_id>:<...>/documents/...` (the bot-api cache).
- The agent receives it as a real attachment (not a `failed:` placeholder) and can read it.

If the file still fails:
- `docker logs tg-bot-api` — auth errors (bad `api_id`/`api_hash`) or the `logOut` step missed.
- `grep TELEGRAM_API_ROOT .env` and `grep TELEGRAM_LOCAL_FILES_DIR .env` — confirm both env vars are persisted.
- `ls -la data/telegram-bot-api/files/` — confirm the bot-api server is writing here (should see a directory named `<bot_id>:<token_fragment>`).

## Rollback

To go back to the cloud Bot API:

```bash
# 1. Log the bot out of the local server
curl -fsS "http://localhost:8081/bot${TOKEN}/logOut"

# 2. Stop the docker container (keep `-v` off if you want the file cache)
cd data/telegram-bot-api && docker compose down && cd -

# 3. Optional: drop the cached files (safe; bot-api would just re-download)
rm -rf data/telegram-bot-api/files

# 4. Remove the two new env vars from .env
sed -i.bak '/^TELEGRAM_API_ROOT=/d; /^TELEGRAM_LOCAL_FILES_DIR=/d; /^TELEGRAM_MAX_FILE_MB=/d' .env && rm -f .env.bak

# 5. Sync env and restart
mkdir -p data/env && cp .env data/env/env
systemctl --user restart nanoclaw   # or: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

The bot will reconnect to `api.telegram.org` on the next restart.

## Notes

- **No nanoclaw code change is needed to switch back** — both env vars are runtime config.
- **VPS recommended** — the Bot API server is heavyweight (TDLib client per bot). It will crash or drop messages on serverless / low-memory hosts. ~512 MB RAM minimum, ~10 GB disk for cached files (grows linearly with file traffic — no auto-cleanup).
- **Polling stays the same.** `apiRoot` only swaps the HTTP base URL; grammY's long-polling loop works unchanged.
- **Outbound limit is also lifted to 2 GB** by `--local` mode. No nanoclaw code change needed for outbound — `InputFile` POSTs through the configured `apiRoot`.
