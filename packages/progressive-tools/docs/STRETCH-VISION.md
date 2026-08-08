# Stretch Vision

The stretch vision is a general capability system for Pi. Tools are only one resource type in this system.

## 1. Extension capability manifests

Each extension publishes a small manifest through `pi.events`.

A manifest can contain:

- Capability name.
- Short purpose.
- Service names.
- Common user tasks.
- Tool names.
- Related skills and reference files.
- Risk level.
- URL patterns.
- Project file signals.
- Runtime start and stop hooks.

The broker asks for manifests at session start. Extensions publish them again after reload. This avoids hard-coded tool lists and extension load-order problems.

## 2. Hierarchical discovery

Discovery has four levels:

1. Domain, such as GitHub, browser, database, or cloud.
2. Workflow, such as pull request review or schema inspection.
3. Small tool bundle for that workflow.
4. Detailed skill or reference instructions.

The model sees only the current level. It does not receive every detail at once.

## 3. High-confidence automatic routing

A local router examines the raw user request in Pi's `input` event.

It activates a small capability bundle only when the signal is clear. Strong signals include:

- An exact service name.
- A known service URL.
- A pull request or issue reference.
- A known project file.
- A clear action and domain pair.

Unclear requests still use `search_tools`.

The router activates tools. It does not execute tools or grant permission.

## 4. Workflow bundles

The broker activates a small group of tools that work together.

A pull request review bundle can include:

- Pull request details.
- Changed files.
- Review threads.
- CI results.

It does not activate every tool in the GitHub extension.

## 5. Context budget

The broker measures the approximate schema size of each active tool and capability bundle.

It can enforce limits such as:

- Maximum optional tool count.
- Maximum active schema tokens.
- Maximum active bundles.

Activation remains additive during one agent run. Old bundles can be removed only between user turns and only when the budget needs it.

## 6. Lazy runtime startup

Capability manifests can include runtime hooks.

An extension can delay expensive work until first use:

- Start an MCP server.
- Open a browser process.
- Connect to a database.
- Start a file watcher.
- Open a network connection.

The runtime can stop during `session_shutdown` or after a safe idle period.

## 7. Progressive instructions and knowledge

The same broker can discover more than tools:

- Pi skills.
- Architecture documents.
- API references.
- Runbooks.
- Database schemas.
- Project decisions.

Search first returns a short summary. A second step loads only selected instructions or document sections.

## 8. Adapter and gateway tools

A poorly designed extension can be placed behind a small adapter.

The adapter can expose:

- One small domain gateway.
- Several small workflow tools.
- Better descriptions and aliases.
- Delayed runtime initialization.

A gateway cannot repair an arbitrary tool without access to its execution service. The original extension or adapter must provide that integration.

## 9. Better ranking after real evidence

Start with word matching and explicit aliases.

After enough real failures, add one improvement at a time:

- BM25 search.
- Local embeddings.
- Project-specific signals.
- Learned aliases from accepted results.
- A small routing model for ambiguous cases.

Do not add a second model until simple routing data shows a clear need.

## 10. Policy and permission separation

The final system keeps these controls separate:

- Discovery: Does the capability exist?
- Activation: Does the model receive its schema?
- Authorization: May the tool perform this action?
- Execution: Run the approved operation.

Tool activation must never be treated as permission for a destructive action.

## End state

The model sees the shape of the installed capability space. It receives full schemas, instructions, and runtime resources only for the current task.
