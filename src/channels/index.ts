// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with one default channel — `cli`, the always-on local-terminal
// channel. Other channel skills (/add-slack, /add-discord, /add-whatsapp,
// ...) copy their module from the `channels` branch and append a
// self-registration import below.

import './cli.js';

// Telegram adapter — two implementations, one channel_type ('telegram').
// Uncomment exactly one. Both read TELEGRAM_BOT_TOKEN. Leaving both
// uncommented causes whichever imports last to silently override in the
// registry, so keep exactly one active.
//
// Legacy implementation — delegates to @chat-adapter/telegram (bridge).
// Kept as a fallback in case the grammY implementation regresses.
// import './telegram.js';
//
// grammY + Effect-TS v4 implementation — parse-error-immune (entities[]
// instead of parse_mode). Default since the MarkdownV2 parse-failure
// incidents in upstream.
import './telegram-grammy/index.js';
