# Configuration Reference

## Files and load order

The extension reads these files:

1. Package file: `progressive-tools.config.json`.
2. User file: `~/.pi/agent/progressive-tools.json`.
3. Project file: `<cwd>/.pi/progressive-tools.json`.

The project file is read only when `ctx.isProjectTrusted()` is true.

Arrays append in load order. Search and audit scalar values from later files replace earlier values.

## Root fields

### `version`

Required. The current value is `1`.

### `areas`

A short list of capability areas for the model-visible search guidance.

Example:

    "areas": [
      "GitHub and code review",
      "browser automation",
      "PostgreSQL inspection"
    ]

Keep this list short. A reload is required to refresh the list in the provider-visible `search_tools` description. In the first version, only package and user areas enter that stable description. Project-only areas still improve search after project trust, but they do not change the loader description. Put broad project domains in the user file when the model must know that they exist.

### `alwaysActive`

Rules for non-built-in tools that must stay active.

Use this for small gateway tools or tools that another extension requires at all times.

### `managed`

Rules for tools that the broker may hide and activate.

A managed tool starts hidden. `search_tools` can activate it.

### `blocked`

Rules for non-built-in tools that must not be active.

Blocked has higher priority than `alwaysActive` and `managed`.

Pi built-in tools and the broker's own `search_tools` tool cannot be blocked by this package.

### `aliases`

Extra search terms for tools. Alias rules do not change policy state.

### `search`

Search settings:

- `defaultLimit`: Result limit when the model does not give a limit.
- `maxLimit`: Hard maximum result limit.
- `minimumScore`: Minimum local word-match score.
- `showUnmanagedHints`: Tell the model that matching unmanaged tools exist when no approved managed tool matches. Their names and descriptions stay out of model context. Use `/tool-audit` to inspect them.

### `audit`

Audit settings:

- `largeSchemaTokens`: Approximate token threshold for the `large-schema` warning.

## Rule selectors

A rule can use these selectors:

- `name`
- `source`
- `path`
- `scope`
- `origin`

Each selector accepts one string or an array of strings.

Patterns are case-insensitive. They support:

- `*` for any number of characters.
- `?` for one character.

Selectors inside one rule use AND logic. Values inside one selector array use OR logic.

Example:

    {
      "source": "npm:@company/pi-github*",
      "scope": ["user", "project"]
    }

This rule matches a tool only when both the source and scope match.

## Rule metadata

A policy rule can also contain:

- `area`: Short capability area.
- `aliases`: Extra task and service words.
- `note`: Audit note.

Example:

    {
      "name": "github_pr_*",
      "area": "GitHub pull request review",
      "aliases": [
        "GitHub",
        "pull request",
        "PR",
        "review threads",
        "unresolved comments",
        "checks"
      ],
      "note": "Reviewed as a small read-focused workflow set"
    }

## Alias-only rules

Alias rules use the same selectors and add `terms`:

    {
      "name": "get_threads",
      "terms": [
        "GitHub review comments",
        "pull request threads",
        "unresolved review feedback"
      ]
    }

This improves search without making the tool managed.

## Precedence

Policy uses this order:

1. Pi built-in tool or `search_tools`: core. Active built-ins are preserved, inactive built-ins remain inactive, and `search_tools` is force-activated.
2. Explicit blocked match: blocked.
3. Non-built-in replacement of a core tool name: unmanaged and flagged.
4. `alwaysActive` match: core.
5. `managed` match: managed.
6. No match: unmanaged.

## Source rules and future tools

A source rule applies to every current and future tool with the same matching source data.

This is useful for a trusted extension that adds tools dynamically. It is also broader than a name rule. Use it only after review.

## Example user file

See `examples/progressive-tools.user.example.json`.
