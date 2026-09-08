# ChronoCompact local development deployment

## Purpose

Use this checklist to deploy one verified local ChronoCompact build to Pi. Every future ChronoCompact code task must complete local deployment or report a deployment blocker.

## Build

Run the package build from `<repository>/packages/chrono-compact` only after focused and full tests pass. Confirm that `package-lock.json` and dependencies did not change unless the task explicitly requires them.

## Find the installed package

Use `pi list`, Pi settings, installed package metadata, and the resolved extension entry. Do not scan unrelated directories. Record the package version, installation type, entry-file hash, and package metadata hash before deployment.

## Supported installation types

Pi can load a direct local path, a symbolic link, a copied local package, a local npm package, or a managed Git package. Do not guess the type. Stop and report a blocker when the type or target is unclear.

## Deploy

Deploy only after tests and required benchmarks pass.

- For a direct worktree path, build the worktree and do not copy files.
- For a symbolic link, verify its target before updating that target.
- For a copied package, stage required package files beside the installed package. Verify staged hashes. Replace the installed directory atomically when supported.
- For a local npm package, use the existing offline local installation method.

Preserve user configuration, session sidecars, unrelated extensions, and installed package ownership. Never replace a real session JSONL file.

## Verify

Compare source and installed hashes. Start a new short-lived Pi process in offline and ephemeral mode. Confirm that ChronoCompact loads, its expected command is registered, the shadow setting defaults to off, and no scheduler or worker residue remains. Do not call a model only for verification.

## Restart

A running Pi process does not normally load new files automatically. Restart is required unless Pi has a documented reload command. Pi supports `/reload` for loaded extensions, but do not reload or stop an existing process during an automated deployment check.

## Receipt

Write an owner-only receipt outside Git. Include the repository commit, package version, deployment time, installation type, source and installed entry hashes, source and installed `package.json` hashes, smoke-test status, and restart requirement. Do not include session data or credentials.

## Safety rules

- Keep ChronoCompact retrospective.
- Keep shadow evaluation off by default.
- Do not change user settings during deployment.
- Do not change session sidecars.
- Do not replace real session JSONL files.
- Do not use the network for local deployment or smoke tests.
- Keep one private backup of a copied package until verification passes. Remove it after success.

## Background value-worker deployment check

Keep `value-worker mode` off during deployment and smoke testing. Preserve `.chrono-value-advice-v1`, candidate stores, source ledgers, rollup stores, and every real session sidecar. A copied-package smoke test must register `/chrono-value-worker-status` and `/chrono-value-worker-reset` without creating an advice store or value-model scheduler file. Do not make a provider call for deployment verification.

The repository catalog classifies `dist/src/pi-extension.js` as a build entry. Package tests require `packages/chrono-compact/dist`, but the repository classification check expects generated build entries to be absent. The public-tree check also rejects a package-local `node_modules` directory, even when Git ignores it. Run package tests first. Remove only the generated package `dist` directory. When package-local dependencies are present, move that complete generated directory to an owner-only location outside the repository for the root check. Restore it only for a required offline build. Remove the outside copy after the verified deployment preserves its runtime dependencies. Do not install dependencies during this gate. Rebuild from the clean committed package before copied-package staging.
