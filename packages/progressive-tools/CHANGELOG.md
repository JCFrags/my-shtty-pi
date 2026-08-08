# Changelog

## 0.1.2 — 2026-07-30

- Make the `search_tools` provider schema the single source of discovery guidance.
- Remove Progressive Tools prompt snippets and guidelines so activation cannot change Pi's system-prompt text.
- Keep configured capability areas in the stable loader description.

## 0.1.1 — 2026-07-30

- Preserve Pi's initial built-in tool selection instead of force-activating every registered built-in.
- Consolidate `search_tools` prompt guidance and remove its redundant prompt snippet.
- Apply the search result limit before partitioning active and hidden matches, so repeating the same search does not activate weaker unrelated tools.
- Add regression coverage for inactive built-ins, repeated activation, reset, and restart behavior.

## 0.1.0 — 2026-07-29

- Add one always-visible `search_tools` loader.
- Read Pi's live tool catalog before each search and user turn.
- Add conservative `core`, `managed`, `unmanaged`, and `blocked` policy states.
- Keep unknown tools unchanged and keep unknown metadata out of model context.
- Add additive activation for managed search results.
- Add layered package, user, and trusted-project configuration.
- Add `/tool-audit` and `/tool-reset` commands.
- Detect tools that reuse an existing name from a new source.
- Add tool aliases, capability areas, source rules, schema-size warnings, and policy tests.
