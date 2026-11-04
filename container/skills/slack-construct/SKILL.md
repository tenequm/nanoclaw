---
name: slack-construct
description: Standing context for Slack rooms - mention-driven engagement, owner-presence access, and DM history. Ships as instructions.md composed into the group's CLAUDE.md at spawn; there is no workflow to invoke.
---

# Slack construct - standing context

A carrier for standing context, not an on-demand workflow. The payload is
`instructions.md` in this directory: the Slack room, access, and
DM-history rules an agent needs the moment it wakes in a Slack conversation.
The host composes every container skill's `instructions.md` into each group's
CLAUDE.md at spawn (`src/project-doc-compose.ts`), so from inside a session
those rules are already standing instructions - nothing to load or run here.

One scope note for maintainers:

- Skill fragments compose into **every** group, regardless of the group's
  `cli_scope`. The content therefore never names host-CLI (`ncl`) commands -
  groups with CLI access get that guidance from the CLI module's own
  instructions fragment, which the host includes only where `ncl` is enabled.
