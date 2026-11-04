### Sending an album (`send_media_group`)

Use `mcp__nanoclaw__send_media_group({ to, items })` to deliver 2-10 files as one album; each item is `{ path, caption? }` with the same path rules as `send_file`. Photos and videos render as a gallery, other types as a grouped list. Use `send_file` for a single file.

