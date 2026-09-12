# M08/M09 bounded state-gap repair

## Scope and identity

This 2.0.33 increment builds on protected main `4c0c2676cd32832e1927f47f30be53694a61151d`. It includes four separate source changes:

- `4b76ee0`: resume recognized state clauses in batches of at most 32.
- `55e93db`: page bounded delta metadata without changing its source-read ceiling.
- `4a7be4a`: stage and publish exact historical state-gap repairs.
- `e8fdb0d`: distinguish verified non-user `custom_message` bodies, including body descriptor zero.

The package version, runtime identity, compiled JavaScript, deployment manifest, and independent package-tree pins are updated together. Required CI and protected merge remain delivery gates. This report does not claim deployment or V3 acceptance.

## Behavior

The new explicit `repairState` operation uses `status`, `start`, `step`, and `publish`. It binds an exact body source, completed view, prior coverage hash, and expected state generation. Each step pages at most 32 legacy rows or processes one bounded decoded window and clause batch. Normal state writers cannot advance a pending repair.

Repair matches exact legacy evidence and retains its existing lifecycle. Missing states remain invisible until publication. Publication adds a later cut and a versioned coverage receipt. It does not overwrite original coverage, revive superseded obligations, resolve tasks, or change non-target state. Ambiguous evidence and unsupported lifecycle transitions refuse.

A parsed, source-bound `custom_message` type identifies a non-user extension message. It does not supply a user or assistant role. Its body remains in chronological memory and exact recovery, but it does not create instruction state or resource observations. Missing-role messages and insufficient type evidence remain qualified. Descriptor zero is accepted for repair only when the catalog verifies an exact body, not arbitrary metadata. Supersession remains restricted to verified original-user authority.

See [episodes and state](../episodes-and-state.md) for the protocol and [migration](../migration.md) for compatibility limits.

## Focused verification

The preceding continuation checks recovered 70 whole-body states in four jobs and 96 large-body states in five jobs. Each batch retained at most 32 states.

The persisted historical-repair fixture passed in 16.3 seconds. It used 15 steps, accounted for 96 states, matched 32 legacy rows, inserted 64 missing rows, and preserved one superseded legacy state. Restart, historical state pins, original coverage and cuts, source identity, head positions, and a historical rollup handle remained valid. Mandatory representation overflow remained reported after category accounting was repaired.

The paired custom-message fixture passed in 3.2 seconds. It repaired body descriptor zero in 12 steps, emitted no advisory instruction states, preserved the real user restriction, and retained the unknown-message gap. A fabricated metadata body, custom-message supersession, and repair of the unknown message refused. Exact chronological recovery and historical coverage remained valid.

The implementing agent ran these focused checks. The parent inspected the source changes and exact results. No independent review is claimed. Test compilation, the candidate build, the locked native SQLite build and allocation probe, generated-map validation, and independent static package identity passed. An initial deployment-check invocation used the repository directory instead of the package directory. The corrected invocation verified all 135 manifest records without rebuilding.

## CI fixture correction

Initial PR75 CI passed 680 of 681 Chrono tests. The existing timeout fixture waited for a synthetic child marker even though its 500 ms waiter deadline includes startup. The waiter can expire before that marker exists. The correction awaits the timeout result directly and retains the exact `worker-timeout` assertion. Abort still requires the child readiness marker. No runtime code, deadline, or timeout was changed.

The affected credential, timeout, abort, and crash fixture passed in 1.7 seconds. The first local launch used the non-emitting typecheck configuration, so no test ran. The corrected launch used the existing test-build configuration. No broad local suite or unchanged CI retry ran.

## Overlapping-window correction, 2.0.34

The first private 157-target application verified its online backup, then stopped after 19 worker calls with no published target. Its pending stage, original coverage, bindings, and refusal receipts remain intact.

A bounded read-only simulation identified the failure. The same exact clause inherited different revision labels from overlapping windows. Its legacy row hash and every other comparison still matched. Repair now permits only this contextual revision difference when the exact clause has no explicit revision. It preserves the existing row and revision. Clause-local revision mismatches and all other evidence and lifecycle checks still refuse. Reducer output, state order, checkpoints, and repair bindings do not change.

The SQLite transaction wrapper also masked the specific repair refusal as a generic store failure. Its explicit error-code allowlist now retains known repair codes while discarding private diagnostic text and unknown codes.

Two focused checks passed. The transaction check verified rollback and diagnostic sanitization. The persisted repair check completed 15 steps, accounted for 96 states, matched 32 legacy rows, inserted 64 rows, and preserved one supersession. It also verified staged-overlap preservation and explicit-revision refusal. These are focused checks, not a successful retry of the private application. Required CI, delivery, and the unchanged campaign's guarded continuation remain separate.

## Compatibility and remaining work

Explicit repair opts the store into `episode-state-exact-v4-gap-repair-v1`. Compatible readers retain historical pins and handles. Actual pre-repair 2.0.32 code refused both reads and writes on the opted-in fixture store. Its native wrapper reported `search-v3-state-store-failed`. This refusal is not exercised rollback. Do not discard a pending stage or relabel the store for an older binary.

A bounded private inventory found 157 mandatory-gap rows: 14 original-user bodies and 143 extension-message bodies. These are prepared repair targets, not completed repairs. Optional-only gaps and mandatory scan, representation, response, and combined-context limits remain separate. A successful repair of one descriptor does not establish complete selection coverage.

The active M11 campaign retains its separate immutable runtime and existing progress. No campaign restart or scale pass is claimed here. Existing-session repair, normal local adoption, exercised compatible rollback, M08/M09 qualification, and M11/M12 acceptance remain required before 3.0.0.
