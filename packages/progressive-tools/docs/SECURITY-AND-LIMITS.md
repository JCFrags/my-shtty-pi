# Security and Limits

## Extensions have full process permissions

This package changes which tool schemas the model receives. It is not a sandbox and it is not a permission system.

A Pi extension can execute code with the permissions of the Pi process. Install only trusted extensions. Use a container or another sandbox when you need a hard security boundary.

## Activation is not authorization

A managed tool can become active after search. This does not mean that every action is allowed.

Destructive or sensitive tools still need their own checks, such as:

- User confirmation.
- Read-only modes.
- Environment restrictions.
- Credential scopes.
- Path restrictions.
- Service-side permissions.

## Unknown tools stay unmanaged

The broker does not hide or activate a tool unless a rule controls it.

This protects compatibility with new extensions, SDK tools, and unusual runtime tools. It also means that an unknown active tool can still add context until you review and manage it.

When search finds an unmanaged match, it reports only that a match exists. It does not send the unknown tool name or description to the model. `/tool-audit` shows that metadata only in the user interface.

## Project configuration needs project trust

A project can contain `.pi/progressive-tools.json`. The extension ignores this file until Pi reports that the project is trusted.

A project configuration can still change which approved tools are active. Review project files before trust.

## Core tools

The package does not hide active Pi built-ins and does not activate built-ins that Pi or the user left inactive. This preserves `--tools`, `--exclude-tools`, and Pi's default active-tool selection.

A non-built-in tool that replaces a core name is left unmanaged and receives a `core-name-override` audit warning. An explicit blocked rule can disable that override.

## Prompt limits

The broker can inspect data from `getAllTools()`, including:

- Name.
- Description.
- Parameter schema.
- Prompt guidelines.
- Source information.

It cannot see every prompt change through this API. In particular, the audit cannot assign all direct system-prompt text or every `promptSnippet` to its source extension.

A bad extension can therefore cause prompt growth even when its tools are hidden.

## Large schemas

Dynamic loading changes when a schema enters context. It does not reduce the schema size.

When a large tool becomes active, the model still receives the large schema. Patch, split, or adapt the tool when this cost is too high.

## Cache behavior

Search activation is additive. This gives Pi the best chance to use cache-friendly deferred loading.

Tool removal is not additive. `/tool-reset`, policy changes, and blocked rules can cause the next request to use Pi's normal fallback and can reduce provider cache reuse.

## Search errors

Simple word matching can miss a tool or select a weak match.

Use a small result limit. Add aliases from real failures. Keep permissions separate from activation.
