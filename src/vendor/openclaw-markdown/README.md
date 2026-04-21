# Vendored: openclaw markdown → Telegram HTML pipeline

Source: https://github.com/openclaw/openclaw
Pinned commit: `fb7bfb411cdb2b6b094fc47317d63a33c3e31da9` (2026-04-21)
License: MIT (see `LICENSE`)

## Files

| Dest here                      | Source in upstream                        |
| ------------------------------ | ----------------------------------------- |
| `ir.ts`                        | `src/markdown/ir.ts`                      |
| `render.ts`                    | `src/markdown/render.ts`                  |
| `render-aware-chunking.ts`     | `src/markdown/render-aware-chunking.ts`   |
| `fences.ts`                    | `src/markdown/fences.ts`                  |
| `code-spans.ts`                | `src/markdown/code-spans.ts`              |
| `tables.ts`                    | `src/markdown/tables.ts`                  |
| `format.ts`                    | `extensions/telegram/src/format.ts`       |
| `auto-linked-file-ref.ts`      | `src/shared/text/auto-linked-file-ref.ts` |
| `string-coerce.ts`             | `src/shared/string-coerce.ts`             |
| `chunk.ts`                     | trimmed from `src/auto-reply/chunk.ts` (only `chunkText` + inline helpers; config resolution stripped) |
| `text-chunking.ts`             | `src/shared/text-chunking.ts`             |
| `types.ts`                     | extracted subset of `src/config/types.base.ts` (`MarkdownTableMode` only) |

Imports flattened to `./filename.js` — upstream uses `src/markdown/`, `src/shared/`, etc.; we keep one directory.

## Contract

Consumed by `src/channels/telegram-render.ts`, which calls
`markdownToTelegramChunks(markdown, limit, { tableMode })` and picks the
`tableMode` based on an empirical ~48-char width gate that upstream does not
ship (see openclaw issue #36323).

## Bumping

1. `git fetch` upstream at a newer commit.
2. Copy files again, re-flatten imports.
3. Update the pinned commit SHA above.
4. Re-run tests.

Do not hand-edit. Fixes belong upstream.
