---
name: pond-recall
description: Search your own past sessions (and any additionally granted pond stores) with the pond MCP tools. Use when you need context from an earlier conversation, a past decision, or anything that happened beyond your current context window.
---

# Pond recall

If a `pond` MCP server is present, you have lossless search over past sessions. Stores are mounted read-only under `/workspace/extra/pond`; the tools are read-only by design. pond is MCP-native and self-documenting: the tool descriptions (`pond_search`, `pond_get`, `pond_sql_query`) and resources (`schema://pond`, `stats://pond`) carry everything you need.

- `pond_search` for concepts and paraphrases; `pond_get` to read a full message or session; `pond_sql_query` with `contains_tokens` for exact strings, identifiers, or error messages.
- A zero or weak search result is not proof of absence: try another phrasing, a date filter, or a SQL token match before concluding "nothing found".
- Servers named `pond_<store>` are additional stores you were granted; same tools, different corpus.
