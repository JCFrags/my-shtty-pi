---
title: Provider-owned persistence and complete transfer
audience: [agents, maintainers, operators]
status: implemented, selection-dependent
purpose: Define durable commits, branch resolution, explicit import, and non-lossy replacement contracts.
related:
  - memory.md
  - todo-notes-workplan.md
  - ../../../packages/pi-context-kit/state-store/API.md
---

# Provider-owned persistence and complete transfer

## No central state database

Memory, Todo, Notes, and Workplan have separate roots, store instances, locks, and lifecycle. A shared library can supply validators or storage primitives without becoming a shared mutable service.

Memory uses a namespace database and direct physical-session bindings. Todo and Notes use bounded immutable roots. Workplan separates a manifest, per-plan objects, and projection objects so ordinary target operations avoid unrelated plan bodies.

Canonical stores, source files, logical routing, and derived lookup caches have different recovery requirements. Do not classify every generated file as disposable.

## A durable native write

For Todo, Notes, and Workplan, the owner follows this sequence:

1. Resolve the exact source session and leaf. Validate native revisions and complete operation bounds.
2. Publish the immutable owned payload, root, and prepared receipt.
3. Append a small `context-kit:state-anchor:v1` Pi custom entry.
4. Verify its exact live identity and bounded on-disk append. Synchronize the source and required directories.
5. Publish the durable binding, expose the committed state, and emit normal provider notifications.

Memory has the same visibility principle with a prepared SQLite operation, `context-memory-commit-v1` anchor, and final revision/head transaction.

Pi's `message_end` occurs before all persistence work is complete. It is not a durable acknowledgment. Tool results are not the provider's persistence mechanism.

An unbound prepared object is an orphan, not current state. An uncertain append remains pending until reconciled against the original operation. Retrying without checking that boundary can duplicate or overwrite work. Existing corrupt objects, unsafe routes, and missing expected stores refuse rather than create empty state.

The state-store library has a separately explicit volatile policy for integrators. The shipped owned providers require disk-backed success and do not advertise ephemeral state as durable.

## Bounded branch resolution

Direct bindings avoid normal full-history replay. When needed, an owner reads a bounded ancestry page and retains exact progress for that view. Native operations or a settled lifecycle event can advance another page. No hidden unlimited startup loop is implied.

Empty state is valid only after complete relevant ancestry proves no prior state. Legacy state instead requires explicit import. A changed leaf can reuse a saved cursor only at an ancestor reached on the selected native ancestry, with the same source key and a matching native head signature. The current view keeps its own head and combines both legacy flags. This retains bounded progress across ordinary appends and cold owners, but does not guarantee one-call completion or catch-up when appends consume the page budget. Common-ancestor progress is reusable after a tree selection. A cursor on an unvisited sibling suffix is not. These shortcuts retain the existing stable-ancestry and private-index assumptions, not a complete source-prefix proof.

Native fork/clone can re-chain inherited anchors. Their original provenance remains intact. New writes bind the new source view rather than rewriting the inherited receipt.

Context connectors do not perform restoration, import, or pending-operation recovery. A query reports pending or unavailable and leaves healthy other providers usable.

## Explicit legacy import

Import creates separate owned state and evidence. It does not rewrite legacy JSONL or silently turn tool results into new durable state.

Todo and Notes advance at most 128 whole source entries within an 8 MiB page per command. Workplan advances a 32-entry source page or at most four replayed native events per command. Progress is resumable for the exact source identity and leaf. Freeze that branch during import.

Receipts retain normalized native-entry evidence and digest chains. These detached entries omit optional in-memory `undefined` fields as Pi JSON does. They are not claimed as exact copies of original JSONL whitespace. The original bytes remain in the source file.

Memory import is different: it explicitly reads a selected V2 sidecar, preserves its exact bytes and mixed legacy hash formats, and publishes accepted data only after final anchoring. See the [Memory reference](memory.md).

## Complete transfer is not Recall

The asynchronous V2 transfer contract requests named providers at a pinned session/leaf. It has a 5-second default wait and 30-second maximum. Each provider allows one capture in progress.

| Provider | Required transfer content |
| --- | --- |
| Todo, Notes, Workplan | Complete `grounded-state-checkpoint-v1`, optionally accompanied by validated `context-kit:owner-binding:v1` provenance. |
| Memory | `context-kit:owner-binding:v1` containing a verified logical-store binding. The retained store is still required. |

All requested owners must respond. Missing, duplicate, malformed, changed-scope, pending, corrupt, cancelled, or oversized content refuses. Admission is 8 MiB per provider and 16 MiB aggregate, with whole-state structural limits. Neither cards nor clipped display output can substitute for complete state.

A valid owner binding is not permission to trust arbitrary root paths. Providers validate native state and binding integrity. Workplan owner metadata preserves provenance, not an unchecked direct root selection.

Fresh checkpoint-only bootstraps require the complete bounded ancestry and the expected checkpoint without ordinary provider events around it. A checkpoint appended after older provider state is not a supported way to replace that state.

## Reversibility

Before migration, retain original source and stores. Before selecting legacy writers after new owned writes, create a fresh replacement with complete current native checkpoints. Memory additionally needs an explicit verified reverse V2 export to the actual fresh target sidecar and a companion preserving unsupported metadata and proposals.

A code-selection rollback can leave owned stores intact but does not make their new data visible to old providers. A data rollback must transfer the latest state. If complete transfer or export cannot fit, refuse before switching writers.

Never remove a live owner's lock, discard an uncertain operation, or delete an old source to force recovery. Use the [activation](../operations/activation-and-migration.md) and [rollback](../operations/troubleshooting-and-rollback.md) procedures.

[State index](README.md) · [State-store API](../../../packages/pi-context-kit/state-store/API.md) · [Transfer protocol](../../../packages/pi-context-kit/protocol/README.md#complete-native-transfer)
