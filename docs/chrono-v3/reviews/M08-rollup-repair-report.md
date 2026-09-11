# M08 bounded rollup repair report

## Candidate

This source-only candidate starts at `b0e98fb3aeaeb64699bcd00ea68e4a2438553d4f`. It adds a separate versioned repair store and an atomic active-route record. It does not change package metadata, generated output, shared settings, installed code, live stores, or active campaigns.

The public worker contract and `/chrono-rollup-repair` command expose one finite `start`, `step`, `status`, or `publish` transition. The history adapter resolves the requested persisted leaf and submits that transition through existing worker admission. Callers must explicitly repeat `step`.

The implementation preserves storeless legacy handles. Replacement handles contain `storeId`. New replacement databases add the bounded publication index `(lineage,eventCut DESC,generation DESC)` and use the matching status order. Existing databases are not migrated and keep exact-head status behavior.

## Focused verification

Two local checks ran after implementation:

1. Package typecheck passed with `tsc -p tsconfig.json --noEmit`.
2. The existing persisted metadata/rollup fixture passed as one selected test. Its added repair lifecycle exercised a partial step, start retry without reset, status resume, incomplete publish refusal, completion through explicit bounded steps, corrupt-target publish refusal, atomic publication, active-route status, old storeless-handle recovery, and unchanged source bytes.

The focused test result was one pass, zero failures, in approximately 9.1 seconds. No broad suite, campaign, package build, push, deployment, or live-store operation ran.

## Limits

This is synthetic persisted-fixture evidence, not live repair evidence. Routine continuous integration, integration review, packaging, deployment, and any live repair remain parent-controlled. Failed targets are preserved and no cleanup command is provided. The active pointer supports compare-and-swap publication, but this candidate does not expose a general rollback command.
