# First Design

## Goal

Keep the initial model context small without hiding the existence of optional capabilities.

## Main flow

1. Pi loads all installed extensions.
2. Each extension registers its tools with Pi.
3. This package reads the live catalog with `getAllTools()`.
4. Policy rules divide tools into core, managed, unmanaged, and blocked groups.
5. Managed tools are inactive at the start of a session.
6. The model always sees `search_tools` and a short search rule.
7. The model sends a task description to `search_tools`.
8. The broker searches the current live catalog.
9. The broker adds a small set of matching managed tools to the active set.
10. Pi sends the new tool definitions on the next model request.

## Why the package uses explicit approval

Tool discovery and tool control are different actions.

The broker can safely inspect all tool metadata. It should not automatically hide or activate every tool from an unknown extension.

A new tool therefore starts as unmanaged. It becomes managed only when a rule approves its name, source, path, scope, or origin.

## How the model knows when to search

The provider-visible `search_tools` description carries the small stable discovery policy:

- Hidden approved tools can exist.
- Search by task or service name.
- An exact tool name is not required.
- Search before saying that a specialized tool is unavailable.

The user configuration can add a short capability-area list to that description. The extension does not duplicate this guidance through `promptSnippet` or `promptGuidelines`, and it does not add all hidden tool names or schemas.

## Search method

The first version uses simple local word matching. It searches:

- Tool name.
- Tool description.
- Tool parameter schema text.
- Source and path.
- Configured capability area.
- Configured aliases.

It gives more weight to names, aliases, and exact phrases. It does not use another model, embeddings, a database, or a network service.

## Activation method

The broker adds matching tools to the current active list. It does not remove tools in the same loader call.

This additive change is important. Pi can use native deferred loading on supported models. Other models still receive the active tool list on the next request.

Loaded managed tools stay active until one of these events occurs:

- The session restarts.
- Pi reloads extensions.
- The user runs `/tool-reset`.

## Live tool updates

The broker scans the tool catalog again before each search and before each user turn.

This finds tools that another extension registers after startup. The policy then applies to the new tool.

## What this version does not do

- It does not route tasks automatically.
- It does not group tools into workflow bundles.
- It does not use semantic embeddings.
- It does not start or stop external processes.
- It does not remove prompt text added directly by another extension.
- It does not change tool permissions.
- It does not trust a project configuration before Pi trusts the project.

These limits keep the first version small and predictable.
