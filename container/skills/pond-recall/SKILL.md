---
name: pond-recall
description: Recall past sessions — yours and, when granted, other corpora — via the pond MCP tools (pond_search, pond_get, pond_sql_query). Use when asked about past conversations, earlier decisions, "what did we discuss/decide", recurring topics, or to recover context after compaction.
---

# Pond Recall

pond is a durable, searchable archive of past agent sessions. If `mcp__pond__*` tools are available, your past sessions are indexed there — including ones long since rotated out of your own transcript files. If they are not available, this skill does not apply; do not shell out to a `pond` binary looking for stores.

## Which corpus is which

You may see up to three pond servers; each is a separate corpus:

- `mcp__pond__*` — **your own past sessions** (this agent group only). Always safe to search; treat it as your long-term memory.
- `mcp__pond_shared__*` — sessions of **all agent groups** on this install. Only present if the operator granted it. Other groups may serve other people; quote from it only when relevant and never relay another conversation's private details into a chat with a different audience.
- `mcp__pond_operator__*` — the **operator's personal pond** (e.g. their own coding sessions). Same caution applies.

## Workflow

1. `pond_search` with a semantic query (concepts, not keywords). Scope with filters — `from_date` / `to_date`, `session_id` — not by stuffing the query.
2. `pond_get` on a `message_id` for full context around a hit, or on a `session_id` to read a whole session (`session_from: "end"` for the most recent turns — useful to recover context after compaction).
3. For exact strings, identifiers, or error messages, search is the wrong tool: use `pond_sql_query` with `WHERE contains_tokens(search_text, '...')`.

## Honesty rules

- Every search response reports how many searchable messages were in scope. **Zero in scope means your filters excluded everything — not "this was never discussed."** Widen the filters before concluding absence.
- A weak result is not proof of absence either; try the SQL path for exact terms before saying something never happened.
- Scores are relative within one response; do not compare them across queries.
- The corpus is past sessions, not the live conversation. What the user just said is in your context, not in pond.
