# ADR-012 — Versioned rollup repair publication

Status: implemented candidate. Integration, packaging, deployment, and live-store use are not authorized by this record.
Scope: explicit bounded repair of the M08 derived rollup store.

## Context

The legacy `rollup-v3.sqlite` route supports bounded materialization and immutable publication handles, but it has no safe corruption-repair path. Rebuilding at the same path could replace valid publications, break pinned handles, or expose a partial database. Query-time repair would also make reads unbounded and unpredictable.

## Decision

A repair uses four explicit worker requests: `start`, `step`, `status`, and `publish`. Each request runs under the existing rollup publication mutex. A command runs one request only. It never loops automatically.

`start` creates or validates an owner-only stage in `rollup-repair-v1`. The stage binds the repair ID, complete search identity, catalog view, rollup ruleset, state generation, represented state cuts, target store ID, and prior active store ID. A retry validates the same stage and target. It does not reset either one.

The target is a separate `stores/rollup-<storeId>.sqlite` database. It uses the existing fixed-fanout materializer and source-page cursor. Each `step` accepts the existing leaf limit and commits one resumable transition. The target adds `publications_cut(lineage,eventCut DESC,generation DESC)`. Historical status lookup uses this exact index order. Legacy stores keep their existing exact-head status behavior and schema.

`publish` requires a complete target at the exact requested cut and bound state generation. It validates the store, root node, route identity, ruleset, and expected prior active store. It then compares-and-swaps owner-only `active.json` through an fsynced temporary file and atomic rename while the mutex is held. A crash before the pointer rename leaves the old route. A crash after the rename selects the complete replacement.

A handle with no `storeId` always selects legacy `rollup-v3.sqlite`. A replacement handle includes its immutable `storeId`. No repair operation deletes or rewrites a legacy, active, failed, state, search, capsule, catalog, or source store.

## Consequences

New unpinned rollup status and materialization requests follow the active route after publication. Exact old handles remain recoverable. Failed and incomplete targets remain for diagnosis or a later explicit retry. Reads never initiate repair.

Repair requires existing valid state pages and exact source availability. It refuses source change, unsafe ownership or mode, symlinks, invalid pointers, corrupt targets, incomplete targets, identity mismatch, and publication conflicts. There is no lifetime publication scan and no automatic cleanup.

## Reversal path

Do not publish the staged target, or atomically restore a previously recorded active store ID through a separately authorized route operation. All physical stores and immutable handles remain present. This candidate does not implement deletion or broad cleanup.
