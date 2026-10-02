# Pi Progressive Tools

A concise catalog keeps tool names visible while policy-managed schemas load on
request. Version 0.2.0 replaced `search_tools` with exact-name `tool_help`.
Version 0.2.1 uses Pi's structured prompt sections, checked with Pi 0.87.1.

- Status: active canonical
- Pi entrypoint: `extensions/index.ts`
- Load form: source-loaded

## Fresh setup

Use Node 22.19.0 or later and a Pi host with the structured prompt-options API.
The section hook was checked with Pi 0.87.1. Older hosts without that API are not
supported. Keep the checkout at any stable location that Pi can read:

```sh
git clone https://github.com/JCFrags/my-shtty-pi.git
cd my-shtty-pi
pi --version
pi install "$PWD/packages/pi-progressive-tools"
```

The package loads TypeScript source directly. It needs no build, package-local
`npm install`, sibling package, or workstation-specific symlink. Pi supplies
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` from the
host. `pi install` records the local source without copying it or preparing
its dependencies. Do not move or delete that checkout while it is selected.
For a source-only trial without a persistent registration, use:

```sh
pi -e "$PWD/packages/pi-progressive-tools"
```

For an existing installation, replace only its verified Progressive Tools
package source, at the same list position. Do not add a second registration or
restore an old complete settings file. Preserve the user policy and every
unrelated package. Keep the previous source until running sessions and scoped
rollback no longer need it. A new Pi process uses the selection. Existing
sessions need a safe reload with an empty editor and no jobs that reload would
interrupt. A settings or link change does not replace loaded code.

This package does not install WebX or browser tools. Their separate owners
supply those registrations. Hints for tools that are not registered do not add
them to the catalog.

## Model tools

- `list_tools({})` returns registered names, short usage hints, and active status.
  It does not return schemas or change activation.
- `tool_help({"names":["web_read","web_search"]})` returns short usage hints and
  the requested tools' complete registered `promptGuidelines`. Names are exact
  and case-sensitive. Aliases and task queries are not accepted.
- Help enables matching managed tools additively inside `execute()`. Pi supplies
  their schemas on the next model response. Call the native tool separately
  after that response starts. Help never runs the requested operation.
- Repeated or already-active names are harmless. Unregistered, blocked, and
  inactive unmanaged names produce clear errors. The full request is checked
  before activation, so an invalid name prevents partial additions.

Before each agent run, `before_agent_start` assigns the catalog to
`systemPromptOptions.sections.progressive_tools`. Pi records changes to that
named section without a whole-prompt override. This requires Pi's structured
prompt-options API. The extension preserves other sections and does not rewrite
provider requests. The catalog and `list_tools` include active tools and inactive
managed tools. They omit blocked tools and do not advertise inactive unmanaged
tools. A custom system prompt still receives the catalog section. A separate
extension's forced whole-prompt override can still hide or flatten sections.

## Configuration

Configuration layers load in this order:

1. Package `progressive-tools.config.json`.
2. `progressive-tools.json` in Pi's agent directory.
3. `progressive-tools.json` in the project's Pi config directory, only when
   `ctx.isProjectTrusted()` is true.

The config version remains `1`. Rule arrays append across layers. Existing
policy precedence is unchanged: the help and inventory tools remain active,
blocked rules take priority for other tools, built-ins are not auto-managed,
and explicit `alwaysActive` rules precede `managed` rules. Core-name extension
overrides stay unmanaged unless blocked. Unknown tools keep their active or
inactive state. A summary does not authorize activation.

`summaries` maps exact registered tool names to one- or two-sentence usage hints:

```json
{
  "version": 1,
  "summaries": {
    "web_read": "Read a known public URL, API, or document. Use web_search when the URL is unknown.",
    "subagent_channel": "Report progress or results for the assigned agent run. Use its exact run ID and assignment generation."
  }
}
```

Later layers override individual summary keys and preserve other keys. Empty or
non-string values are ignored. Missing summaries use registered descriptions,
so new or child-only tools are not omitted for lack of a manual summary. Hints
use the first two sentences, with a 300-character limit. Complete registered
prompt guidelines are returned by help without that summary limit.

Legacy `search` settings remain accepted but do not affect exact-name help.
Areas and aliases remain available for audit filtering, not model-side ranking.

## Commands and scope

This package registers only `list_tools` and `tool_help`. It does not implement
or persist Todo, Notes, or Workplan. The independent [Context Kit
providers](../pi-context-kit/README.md) own those tools and stores in the Chrono
context-state stack. Chrono consumes their evidence and requests complete
rollover checkpoints. It does not own their persistence. Context Kit supplies the
only supported current registrations. Retained older [Grounded
writers](../grounded-tools/README.md#native-state-ownership) are historical
installations, not Progressive Tools providers. Catalog hints and schema policy
do not change that ownership.

- `/tool-audit` shows non-built-in tools, policy decisions, sources, config errors,
  and approximate schema costs. Add `all` to include built-ins, or use a text
  filter. Its report remains a session entry that is not sent to the model.
- `/tool-reset` clears managed activations and reapplies the base policy. New,
  resumed, forked, and reloaded sessions also reset managed activations.

Policy scans remain at session start and user input. The catalog, help, list,
and audit read Pi's admitted live registry. This extension does not scan package
folders, restore excluded tools, or continuously intercept runtime registration.
Tools registered during an ongoing run can remain active until the next policy
scan. The prompt catalog refreshes on the next agent run; `list_tools` can show
the current inventory sooner.

Pi's native deferred loading is used when the provider supports it. Otherwise,
Pi sends the updated active schema list normally. Help returns registered prompt
guidelines explicitly, without depending on a prompt rebuild. Structured sections
permit provider-dependent prefix preservation. This package does not guarantee
cache hits or token savings, including after resume or compaction.

## Verification

From the repository root, use the workflow in the [root README](../../README.md).
Stage only the intended changes before verification because it reads Git index
blobs, not unstaged work.

```sh
npm test
npm run verify:static
npm run verify -- --product pi-progressive-tools
```

These checks do not activate the extension. Exercise `list_tools`, an exact-name
help call, and a subsequent native tool call in the intended Pi installation.
`DEPLOYED.sha256` is historical evidence and is not regenerated for this update.
