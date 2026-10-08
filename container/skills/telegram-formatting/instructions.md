# Telegram formatting

Write ordinary markdown in Telegram messages; the integration converts it to
Telegram's own formatting and splits long text, so your job is only the shape.

- **Renders as written:** `**bold**`, `_italic_`, `__underline__`,
  `~~strike~~`, `||spoiler||`, `` `code` ``, fenced code with a language,
  `[label](https://...)`, `> quote`, and lists, including nested lists and
  `- [ ]` / `- [x]` tasks.
- **Mentions:** `[Name](tg://user?id=123)` notifies that person by Telegram id.
- **Collapsible detail:** start a quote with `> [!fold]` so long logs or
  sources stay folded until the reader opens them.
- **Times:** `[Fri 15:00](tg://time?unix=1792162800&format=wDT)` shows each
  reader the time in their own timezone; `format=r` shows it relative
  ("in 2 hours"). Use it whenever you state a time for someone else.
- **Degrades:** headings become bold lines, tables become a small monospace
  grid or bullets when wide, and markdown images become links. Prefer short
  bullets over wide tables, and send pictures with `send_file`.
- **Bold vs italic:** a single `*x*` renders bold here, so write italic as `_x_`.
