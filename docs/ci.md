# CI and protected integration

[Repository verification](../README.md#verification) owns the commands. [CI scope](../README.md#ci-scope) defines routing. This runbook covers delivery, not local package activation.

## Check the expected scope

1. Read `scripts/ci-scope.mjs` and `.github/workflows/verify.yml` from accepted `main`.
2. Keep the complete feature and its useful documentation together. Place product-specific checks under the product that owns them. Do not remove safety documentation to obtain a smaller CI route.
3. Synchronize accepted `main` into a clean committed branch with a normal merge. Preserve other work.
4. Run this data-only prediction from the repository root:

   ```sh
   base=$(git rev-parse origin/main)
   head=$(git rev-parse HEAD)
   EVENT_NAME=push REF=refs/heads/main \
     BEFORE_SHA="$base" AFTER_SHA="$head" CHECKOUT_SHA="$head" \
     node scripts/ci-scope.mjs
   ```

   The prediction reads Git data. It is not a hosted check, a push to `main`, or permission to run tests outside the user's scope. The actual PR validates its event's base/head and exact checkout merge parents. The workflow uses lighter execution for routine main pushes, so inspect its conditions as well as the router output.
5. If the prediction conflicts with the approved scope, report the exact paths and reason before opening the PR. Do not add commit-specific exceptions or bypass required checks.

## Use the normal protected gate

Documentation runs indexed static/privacy checks without dependency installs or product/browser builds. Known runtime changes select the combined transitive consumers. Shared runtime, CI controls, dependencies, unknown ownership, and uncertain evidence retain full checks. The exact LSP lane has its separate contract. Wednesday scheduled and manual runs verify the full repository.

A selected failure, cancellation, or unexpected skip blocks `verify`. Read the failed job and correct the reproduced problem. Do not ignore the failure or weaken branch protection. Use `workflow_dispatch` only when full verification is intended, not to preview a narrow route.

A newer run cancels obsolete checks only for the same PR and verification workflow. Independent PRs and main/manual/scheduled runs remain separate. Cancellation does not mean a newer run passed.

## Coordinate final merges

Coding and independent PR checks can remain parallel. One integration owner coordinates final protected merges for overlapping deliveries:

1. Confirm the current source owners, pending PRs, and integration window. Silence or an idle pane does not grant a window.
2. Refresh accepted remote `main`. If it advanced, update the branch normally and require checks on the current merge base. Do not repeat checks on a knowingly stale branch.
3. Inspect the exact outgoing diff, commit metadata, and PR text for secrets, personal identifiers, and private local paths.
4. Merge only the exact checked head through the protected PR. Do not force-push shared history or bypass `verify`.
5. Verify the accepted remote main commit and the selected post-merge jobs. Routine known changes use static/history checks rather than repeat product/browser builds. Shared or uncertain changes still run full verification.

Local package-selection windows are separate from GitHub source integration. Follow [activation and rollback](activation.md) after source acceptance. A successful CI run or merged PR does not prove that an installed process loaded the change.
