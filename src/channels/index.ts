// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with one default channel — `cli`, the always-on local-terminal
// channel. Other channel skills (/add-slack, /add-discord, /add-whatsapp,
// ...) copy their module from the `channels` branch and append a
// self-registration import below.

import './cli.js';

// Telegram — grammY + Effect-TS v4 implementation. Parse-error-immune (sends
// entities[] instead of parse_mode, so Telegram never runs a parser).
import './telegram-grammy/index.js';
