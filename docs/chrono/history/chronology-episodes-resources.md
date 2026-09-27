---
title: Chronology, episodes, resources, and rollups
audience: [agents, maintainers]
status: current reference
purpose: Explain derived historical representations and prevent false current-state or completion claims.
related:
  - indexing-and-exact-recovery.md
  - ../context/retention-and-projections.md
  - ../state/memory.md
---

# Chronology, episodes, resources, and rollups

## Why keep chronology

Order often changes meaning. An old proposal followed by a correction is not two equally current choices. A failure followed by an assistant's claim of repair is not automatically a verified success. Chrono therefore retains source order and links when it selects or shortens history.

Important events can receive more detail. Routine repeated output can receive less. This changes selection and representation, not the original sequence or the authority of the speaker.

## Event capsules and decoded chunks

An event capsule is a bounded derived representation of a source body. It can contain a useful cue or a reduced alternative produced by a deterministic reducer. It is lossy and is labeled as such.

Exact decoded chunks are separate. They preserve decoded text in fixed 32,768 UTF-16-unit chunks with validated source bindings. Raw JSONL remains the route for exact original bytes, including serialization.

Immutable segments and their content manifests use stable hashes. Publication makes payloads durable before a database checkpoint can reference them. Batch size and restart timing must not change canonical closed content. Per-job receipts can differ because they record progress rather than content identity.

The capsule store is separate from the source catalog. This lets either layer change schema or rebuild without silently modifying the other's identity. Existing mismatched or corrupt bytes are refused, not overwritten at the same hash name.

## Episodes

An episode groups source-local work beginning at an original user request. The first body/block of that request starts a new episode and closes the preceding interval. Members retain event and descriptor order.

Closure means that a later boundary exists. It does not mean that the task is complete, verified, deployed, or accepted. This is not a general model-selected topic segmentation or time-gap engine.

## Historical state

The indexed `state-v4.sqlite` layer derives source-backed items such as restrictions, goals, decisions, unfinished work, blockers, approvals, and resource observations. This is historical extraction, not the independent Memory store or native Todo state.

Each item retains its evidence span, source identity, category, authority, confidence, and effective cut. Lifecycle rules are conservative:

- A supported new item can be current or unresolved.
- Supported explicit restriction replacement can supersede the exact matching proposition under the same authority.
- A tool failure can create a blocker. A later successful execution does not automatically resolve every earlier failure.
- Assistant implementation and deployment statements remain assistant reports.
- Retention hints and Memory metadata remain advisory.

Body progress, metadata progress, and `knownThroughCut` are separate. Extraction completion does not prove that every natural-language obligation was understood.

Large bodies continue through bounded windows and clause batches. A state job handles at most 32 recognized states in one transaction. That is a batch limit, not permission to discard all later clauses. Pending cursor identity must remain compatible across restart.

Older processed gaps are not silently repaired by new continuation. Exact-descriptor repair and explicit user supersession have separate validated protocols. See the retained [state protocol detail](../../chrono-v3/episodes-and-state.md). Those procedures change derived state and are not ordinary read operations.

## Resource observations

Resource recall shows what the source said about a file, path, command result, or other supported resource, including declared revisions where available. It can help reconstruct why a resource changed and which event supplied evidence.

It does not monitor every external change or reconstruct universal file versions. A later mention is not proof of current bytes. An unknown current revision remains unknown. Use the actual resource interface when a present-state answer is needed.

## Rollups

A rollup is a bounded summary of closed episode intervals. It reads maintained state pages rather than rescanning lifetime history. The implemented fanout is eight children, with up to eight members in a leaf fragment. Open history stays outside the represented closed range.

Rollups preserve source-linked navigation cues, child routes, protected references, and omission counts. A parent keeps bounded cues from its immediate children. Node-size pressure reduces copied detail. An old node without a useful cue still exposes its expansion route and reports the missing cue.

Use `history_recall({"query":"","level":"rollup"})` for bounded browsing. Continue with returned expansion or cursor data at the same level. Follow exact recovery for original wording.

`rollupShadowEnabled` is a different, older replay-comparison path. It is not the switch for indexed `rollup-v3` composition. Likewise, a ready closed-prefix rollup does not imply full coverage of the current open tail.

Explicit rollup repair stages a new store and publishes it only against the expected prior route. Old stores and handles remain preserved. Use [operations](../operations/troubleshooting-and-rollback.md) before considering repair.

## Practical interpretation

Treat a capsule as a cue, an episode as an interval, a state item as source-backed extraction, a resource record as an observation, and a rollup as a partial navigation summary. None replaces current native state or exact source when the distinction matters.

[History index](README.md) · [Exact recovery](indexing-and-exact-recovery.md) · [Architecture decisions](../design/evolution-and-decisions.md)
