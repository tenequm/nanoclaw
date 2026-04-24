/**
 * Ask-question inline keyboard builder.
 *
 * Telegram caps callback_data at 64 bytes (UTF-8). We encode as
 * `ncq:<questionId>:<value>` to match the `ncq:` prefix handler in
 * chat-sdk-bridge.ts and index.ts. Options whose encoded data overflow 64
 * bytes are skipped with a log warning — we can't silently truncate or the
 * host's onAction handler would receive a garbled value.
 */
import { InlineKeyboard } from 'grammy';

import type { NormalizedOption } from '../ask-question.js';

const CALLBACK_DATA_LIMIT = 64;

/** Encode an ask-question option into the 64-byte callback_data slot. */
export function encodeCallbackData(questionId: string, value: string): string {
  return `ncq:${questionId}:${value}`;
}

export interface BuildKeyboardResult {
  keyboard: InlineKeyboard;
  skippedLabels: string[];
}

/**
 * Build an inline keyboard with one row per option.
 *
 * Telegram doesn't auto-wrap long rows; we give each option its own row so
 * long labels render consistently across mobile/desktop. If a consumer
 * wants side-by-side buttons, they can batch options in the payload.
 */
export function buildAskQuestionKeyboard(questionId: string, options: readonly NormalizedOption[]): BuildKeyboardResult {
  const kb = new InlineKeyboard();
  const skippedLabels: string[] = [];
  let first = true;
  for (const opt of options) {
    const data = encodeCallbackData(questionId, opt.value);
    if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_LIMIT) {
      skippedLabels.push(opt.label);
      continue;
    }
    if (!first) kb.row();
    kb.text(opt.label, data);
    first = false;
  }
  return { keyboard: kb, skippedLabels };
}

/** Parse the `ncq:<questionId>:<value>` callback data produced by the keyboard. */
export function parseCallbackData(data: string): { questionId: string; value: string } | null {
  if (!data.startsWith('ncq:')) return null;
  const colon = data.indexOf(':', 4);
  if (colon === -1) return null;
  return { questionId: data.slice(4, colon), value: data.slice(colon + 1) };
}
