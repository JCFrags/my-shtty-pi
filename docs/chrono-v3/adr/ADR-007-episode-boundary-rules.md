# ADR-007: Deterministic episode boundaries

Status: records the implemented state-v4 boundary rule, not universal task segmentation. See the [documentation boundary](../README.md#current-documentation-boundary).

## Context

The timeline needs bounded units for recall and rollup construction. A boundary must remain reproducible across ingestion batches, restarts, and branch cuts without claiming that the preceding task succeeded.

## Decision

Start an episode at the first body/block of an original user request. Close the prior open episode at that next boundary. Preserve member event/descriptor order, objective evidence, and source references. Repeated decoded windows do not create repeated episode membership.

Compaction-continuation classification exists in the reducer, but the current store does not implement all proposed time-gap, resource-transition, or model-selected boundaries. [Episodes and state](../episodes-and-state.md) links the exact reducer/store behavior. Only closed intervals feed [rollups](../rollups.md).

## Alternatives

- Time-gap boundaries depend on an arbitrary inactivity policy and are not implemented here.
- Tool-cluster or resource-change boundaries can split one user objective and need additional explicit rules.
- Model-selected boundaries add optional-provider dependence and authority questions that A-0004 defers.
- Closing at every worker page makes episode meaning depend on scheduling.

## Consequences

An episode can remain open for a long request. Rollup materialization excludes that open tail and must report it. Episode closure means a chronological interval ended, not task completion, blocker resolution, or approval. Other bounded state/recent-memory selections remain necessary.

## Migration

Store boundary and membership changes under the state schema/ruleset identity. Do not reinterpret existing closed nodes under a different rule or rewrite source. A new incompatible ruleset needs explicit reconstruction from declared source-linked inputs.

## Reversal path

Stop consuming the affected episode/rollup selection and retain the prior compatible stores. Exact catalog and chunk retrieval remain independent. Restore a validated prior route/package through [recovery](../recovery.md); do not reopen closed history by modifying JSONL.
