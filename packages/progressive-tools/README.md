# Pi Progressive Tools

This Pi package keeps optional tools out of the model context until the model needs them.

It uses Pi's built-in tool functions:

- `getAllTools()` reads the live tool catalog.
- `getActiveTools()` reads the active tool list.
- `setActiveTools()` hides or activates tools.
- Additive activation lets Pi use deferred tool loading when the model supports it.

The package uses a conservative policy. It discovers every registered tool, but it controls only tools that you approve in configuration.

## What this first design does

- Keeps one small tool active: `search_tools`.
- Keeps discovery guidance in the provider-visible `search_tools` schema instead of duplicating it in Pi's system prompt.
- Searches by task, service name, tool description, parameter names, aliases, and source data.
- Activates a small number of matching tools.
- Reads Pi's live catalog before every search and every user turn.
- Finds tools that other extensions register after startup.
- Preserves Pi's active built-in selection without hiding active built-ins or activating inactive ones.
- Keeps unknown tools unchanged.
- Does not echo unknown tool metadata into model context.
- Hides approved managed tools until search activates them.
- Can block explicitly selected non-built-in tools.
- Shows a TUI-only audit with `/tool-audit`.
- Resets loaded managed tools with `/tool-reset`.

## Safe default

The package starts with no managed tools.

This means installation alone does not hide tools from other extensions. First run the audit. Then approve exact tool names, paths, or sources.

This default is intentional. A tool broker must not take control of an unknown extension without an explicit rule.

## Requirements

- Pi 0.83.x or 0.84.x. The package was tested with Pi 0.84.1.
- Node.js 22.19.0 or newer.
- This is a package-only extension. It uses the current Pi extension API. It does not implement or claim accepted Pi-core integration.

## Install

Unpack this folder. Then run:

    pi install /absolute/path/to/pi-progressive-tools

Start Pi again, or use `/reload` in an active Pi session.

For a quick test without installation:

    pi -e /absolute/path/to/pi-progressive-tools/extensions/index.ts

## First setup

### 1. Inspect the live tool catalog

Run:

    /tool-audit

This shows non-built-in tools. It includes:

- Tool name.
- Active or hidden state.
- Policy state.
- Source and path.
- Approximate schema size.
- Prompt-guideline warnings.
- Core-tool name overrides.

Use this form to include Pi built-ins:

    /tool-audit all

Use a word to filter the report:

    /tool-audit github

### 2. Create your user configuration

Copy the example:

    mkdir -p ~/.pi/agent
    cp /absolute/path/to/pi-progressive-tools/examples/progressive-tools.user.example.json ~/.pi/agent/progressive-tools.json

Edit the copied file. Use exact names, sources, or paths from `/tool-audit`.

### 3. Start with one approved source or a few exact tool names

A name rule is the safest start:

    {
      "version": 1,
      "areas": ["GitHub and code review"],
      "managed": [
        {
          "name": ["github_pr_get", "github_pr_threads", "github_pr_checks"],
          "area": "GitHub and code review",
          "aliases": ["GitHub", "pull request", "PR", "review comments", "CI checks"]
        }
      ]
    }

A source rule also manages tools that the same approved extension adds later:

    {
      "version": 1,
      "managed": [
        {
          "source": "the exact source value from tool-audit",
          "area": "GitHub and code review",
          "aliases": ["GitHub", "pull request", "issue", "review", "checks"]
        }
      ]
    }

Use a source rule only when you trust the complete extension source.

### 4. Reload Pi

Use:

    /reload

The broker reads policy files on each user turn and search. A reload is still useful because it refreshes the short capability-area list in the `search_tools` description. Project-only areas improve search after project trust but do not enter that stable loader description in this first version.

### 5. Test discovery

Ask for a task that needs a hidden tool. For example:

    Review the unresolved comments on this pull request.

The model should call `search_tools`. The tool should activate only the best matching approved tools.

## Configuration locations

The package loads configuration in this order:

1. `progressive-tools.config.json` in this package.
2. `~/.pi/agent/progressive-tools.json`.
3. `<project>/.pi/progressive-tools.json`, only when Pi says the project is trusted.

Arrays append across files. Later scalar search and audit settings replace earlier values.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for all fields and rule behavior.

## Policy states

### Core

Pi built-in tools are protected from broker policy: active built-ins stay active, while built-ins that Pi or the user left inactive remain inactive. `search_tools` and tools matched by `alwaysActive` are force-activated.

### Managed

The broker hides these tools until `search_tools` activates them.

### Unmanaged

The broker can see these tools but does not change their active state. Every unknown tool starts here.

### Blocked

The broker removes these non-built-in tools from the active set. A blocked rule has higher priority than an `alwaysActive` or `managed` rule.

## New tools and tools from other sources

The broker does not keep one fixed snapshot.

It calls `getAllTools()` again before each search and before each user turn. A new registered tool therefore appears in the next live scan.

- A new tool from an approved managed source becomes managed and hidden at the next scan.
- A new tool with an approved name becomes managed and hidden at the next scan.
- A new tool from an unknown source stays unmanaged.
- A new tool with a blocked match becomes blocked.

This behavior supports dynamic tools without giving unknown extensions automatic control.

## Poorly designed extensions

This package can delay a large tool schema, but it cannot make that schema small after activation.

It also cannot safely remove text that another extension adds directly to the system prompt. `getAllTools()` exposes tool descriptions, schemas, prompt guidelines, and source data. It does not expose every prompt modification made by another extension.

Use `/tool-audit` to find these common problems:

- Large tool schemas.
- Active prompt guidelines.
- A non-built-in tool that replaces a core tool name.
- New tools from a source you did not approve.

For a bad extension, the best fix is usually one of these actions:

- Patch the extension.
- Split one large tool into smaller tools.
- Remove `promptSnippet` and `promptGuidelines` from lazy tools.
- Add a small adapter or gateway tool.
- Leave the extension unmanaged.
- Disable the extension.

## Commands

`/tool-audit [all|filter]`

Shows a TUI-only report. The report is stored as a custom session entry and is not sent to the model.

`/tool-reset`

Removes tools that `search_tools` loaded in the current session. Tool removal is not additive, so it can reduce prompt-cache reuse on the next request.

## Files

- `extensions/index.ts`: Pi extension entry point.
- `extensions/config.ts`: Config loading and validation.
- `extensions/policy.ts`: Policy matching and inventory.
- `extensions/search.ts`: Simple task search.
- `extensions/audit.ts`: Audit report.
- `progressive-tools.config.json`: Safe package defaults.
- `progressive-tools.schema.json`: JSON Schema.
- `docs/FIRST-DESIGN.md`: First design details.
- `docs/STRETCH-VISION.md`: Long-term design.
- `docs/NEXT-STEPS.md`: Immediate work after installation.
- `docs/CONFIGURATION.md`: Configuration reference.
- `docs/SECURITY-AND-LIMITS.md`: Boundaries and risks.
- `tests/policy-search.test.ts`: Pure policy and search tests.

## Design boundary

Pi provides registration, active-tool control, and deferred delivery. This package provides policy, search, and conservative routing.

The model knows that hidden capabilities exist. It does not receive each hidden tool schema until the task needs it.

## Local checks

Run the pure policy and search tests with:

    npm test

The package has no build step. Pi loads the TypeScript extension directly.
