---
title: Independent source-linked Memory
audience: [agents, maintainers]
status: implemented, selection-dependent
purpose: Explain accepted knowledge, proposals, provenance, time, retention, and Memory ownership.
related:
  - persistence-and-transfer.md
  - ../operations/activation-and-migration.md
  - ../../../packages/pi-context-kit/memory/README.md
---

# Independent source-linked Memory

Memory owns ordinary accepted knowledge for one logical Pi session. It does not ingest all conversation history, replace Notes, or assign instruction authority. It can operate without Chrono, Recall, Telemetry, or Grounded Tools.

Accepted knowledge and proposals share the explicit logical namespace across tree moves. Unrelated sessions and projects do not automatically share that namespace. Todo, Notes, and Workplan remain branch-local.

## One owner

Chrono historically owns seven `memory_*` tools and a V2 sidecar. Independent Memory keeps those names and adds `memory_proposal`.

Set Chrono's startup `memoryOwner: "context-kit"` before loading the independent provider. This handoff suppresses legacy tool registration, automatic promotion writes, and pinned legacy reads together. Changing configuration without a safe reload does not change the loaded owner. Do not load both writers.

Owner selection does not import an existing sidecar. Existing data needs the explicit [migration procedure](../operations/activation-and-migration.md).

## Native operations

| Operation | Meaning |
| --- | --- |
| `memory_remember` | Accept ordinary knowledge with provenance. Optional supersession can replace an existing ordinary head atomically. |
| `memory_update` | Append a correction. `expectedRevision` can reject a stale write. |
| `memory_forget` | Demote accepted knowledge from working use without deleting source or revisions. |
| `memory_promote` | Reactivate accepted knowledge and add a bounded ranking boost. It does not accept a proposal. |
| `memory_get` | Read current state, an exact revision, or what was recorded before a given time. |
| `memory_list`, `memory_search` | Read bounded pages of accepted knowledge with coverage and omissions. |
| `memory_proposal` | Propose, inspect, accept, or reject a separate candidate. Acceptance/rejection requires its expected revision. |

A proposal can target a correction. Acceptance then requires the expected target revision too. The accepted revision and resolved proposal commit together. Pending or rejected proposals are not accepted facts.

New mutations return a revision hash and compact commit receipt. This hash is not a legacy V2 event hash. Imported legacy integrity metadata remains separately labeled.

## Provenance and time

A revision retains the original source origin, the current operation origin, source links with verification labels, recording time/order, declared event time, and declared validity.

- **Event time** asks when the described event occurred.
- **Recording time** asks when Memory recorded the statement or correction.
- **Validity** asks when the statement is declared applicable.

Unknown values remain unknown. `recordedBefore` answers what Memory had recorded then, not what was factually valid then. An expired interval is reported as expired. A verified tool-call origin proves the operation's source, not the truth of the text. Supplied evidence links can remain unverified.

Legacy protected records retain mutation refusal. That protection does not create fresh instruction authority.

## Retention and bounded reads

Independent accepted heads do not automatically expire or demote as conversation turns pass. Explicit validity and explicit forgetting remain separate. Promotion gives an eight-Memory-commit ranking tie-break boost, unlike V2's eight-conversation-turn behavior.

Text is limited to 8 KiB and a complete record to 16 KiB. A record has at most eight source links, including its operation origin. Native pages scan at most 512 indexed heads, return at most 100 records, and fit a 32 KiB complete result. Ranking is within the admitted page, not the full namespace at once.

Continuation binds namespace, filters, and store revision. A changed store rejects a stale cursor. Excluded matches and incomplete scanning remain visible. No result count proves perfect recall.

## Persistence and initialization

Memory owns one SQLite database per logical namespace using Node's built-in SQLite. It does not use Chrono's compiled catalog driver or set SQLite's process-global heap limit. Its initial limits include a 2 MiB connection cache, no memory mapping, a 50 ms busy wait, full synchronization, and a 256 MiB database-page ceiling.

A mutation prepares payloads, appends and verifies a durable Pi anchor, then publishes the revision transaction. Prepared revisions are not visible. Recovery of uncertain operations requires valid source evidence and a released or dead original owner.

Initialization is lazy and requires a persisted session. A provisional startup does not create an empty store. Direct bindings or a bounded bootstrap lookup select an existing logical namespace. A missing or corrupt existing store is unavailable, not empty.

`/memory-init` explicitly creates a fresh namespace for an appropriate unbound persisted session. It is not an import or a repair of an existing store. Context queries never initialize or recover canonical state.

## Rollover and rollback

Rollover transfers a verified same-store binding, not a database snapshot. Keep the store and its source/binding assets. Missing store bytes cannot be reconstructed from the bootstrap entry.

Forward V2 import preserves original sidecar bytes, mixed hash formats, revisions, and provenance. Post-write rollback requires explicit reverse V2 export to a fresh target, full accepted-head comparison, and a complete companion for proposals and native metadata. Export does not select an old writer.

The [package procedure](../../../packages/pi-context-kit/memory/README.md) owns exact import/export arguments, admission bounds, native checks, and refusal cases. A return after later V2 writes needs reconciliation. It must not silently revive stale independent heads.

[State index](README.md) · [Persistence and transfer](persistence-and-transfer.md) · [Migration](../operations/activation-and-migration.md)
