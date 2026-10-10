---
title: Startup authorization before code selection
audience: [operators, agents, maintainers]
status: source procedure, execution not established
purpose: Install exact-root authorization before replacing one Chrono registration.
related:
  - activation-and-migration.md
  - troubleshooting-and-rollback.md
  - ../../../packages/pi-chrono-compaction/README.md
---

# Startup authorization before code selection

Chrono startup authorization binds the exact package path, accepted runtime bytes, source commit, and worker-configuration projection. A changed package cannot use an older authorization. `pi install` alone does not prepare that record. The startup client reads bounded structured refusals from the startup entry's stderr. It exposes only a safe refusal code, not raw diagnostics.

## Use the explicit selection command

Run this command only in an approved code-selection window. Exclude other settings writers and new loaders until selection finishes. Settle useful jobs and preserve unsent drafts before any later reload. Keep the previous package root, its authorization, configuration, and stores.

1. Prepare a new retained full Git checkout at the reviewed accepted commit. Its Chrono package must be clean, and its installed runtime files must match that commit. Do not patch a root used by running workers.
2. Keep the current worker policy unchanged. `CHRONO_CONFIG` must contain explicit valid worker slots, timeout, nice level, and `isolatedWorkerEnabled: true`.
3. Identify the exact existing Chrono source string in the chosen Pi settings file. Set `PREVIOUS_CHRONO_SOURCE` to that value. Use an existing owner-only mode-0700 `PRIVATE_BACKUP` directory outside the checkout.
4. Run from the accepted checkout root:

   ```sh
   node packages/pi-chrono-compaction/scripts/select-authorized-chrono.mjs \
     --checkout "$CHECKOUT" --commit "$ACCEPTED_COMMIT" \
     --config "$CHRONO_CONFIG" --settings "$PI_SETTINGS" \
     --from "$PREVIOUS_CHRONO_SOURCE" --backup-directory "$PRIVATE_BACKUP"
   ```

Use absolute real paths for the checkout, configuration, settings, and backup directory. `ACCEPTED_COMMIT` is the reviewed 40-character checkout HEAD. The old registration must resolve to an existing local Chrono package. The new retained package root must differ from that old root.

The command reuses the prepare-only generator's exact accepted-byte and configuration checks. It creates or verifies the mode-0600 authorization at `chrono-deployments/<SHA-256 of the exact package path>/startup-authorization.json`, beside the configuration. A differing existing authorization refuses. It never overwrites that record or authorizes arbitrary live changes.

Only after authorization succeeds does the command atomically replace the one named package-list source. It preserves that entry's options, its position, and all unrelated settings values. It compares the complete original settings bytes and configuration again before selection. Private settings backup and journal files record the before/after hashes and selection phase. This command replaces a separate `pi install` step for this existing registration.

## Limits and recovery

The command does not start workers, reload Pi, change worker policy, initialize admission, or read or repair provider stores. It does not prove a healthy runtime. Startup retains its ownership, path, policy, resource, quiescence, and data guards.

The command covers one existing package-list registration in one settings file. It does not replace the complete loader comparison for project settings, extension aliases, other package registrations, or command-line sources. Authorization and settings are separate files, not a multi-file atomic transaction. The coordinated selection window remains required.

On refusal, inspect the private journal and current settings hash. An authorization or temporary settings file can remain after a failed selection. A failure after settings rename reports `selected: true`. Do not restore a whole settings backup over later unrelated edits. Apply only the recorded Chrono source reversal in an approved recovery window. Keep all prior authorizations and package roots until their loaded-use and rollback obligations are settled.

Follow [activation and migration](activation-and-migration.md) for complete loader comparison and safe loaded-use verification. Selection success does not prove activation in an existing Pi process.
