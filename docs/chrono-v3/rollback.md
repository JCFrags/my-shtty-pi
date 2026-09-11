# M00 rollback record

M00 does not deploy or reload ChronoCompact. The rollback point is therefore a read-only backup of the current live package, retained in owner-only local evidence. Its identity and hash are recorded privately and are not copied into Git.

The repository is currently public for review under A-0003. That visibility change does not alter the rollback rule and does not authorize a live switch.

Rollback rule:

1. Do not remove or overwrite the current live package during M00.
2. If a later milestone needs deployment, verify the milestone commit, build, hashes, and smoke test first.
3. Create a new owner-only backup before the live switch.
4. Switch only an atomic package link or directory after temporary-package verification.
5. To roll back, restore the previous verified package link/directory and run the live smoke check.
6. Never restore or edit session JSONL as part of rollback.

The M00 backup has not been used for a live switch. M01 and later must create their own deployment record; this document is not deployment authorization.

## Current V3 candidate boundary

Logical-session recovery and package rollback are separate operations. `/chrono-logical-session recover` and `/chrono-logical-session rollback` repair or reverse one logical rollover while preserving every shard. They do not switch the installed ChronoCompact package. See [`recovery.md`](./recovery.md) for the current state-dependent procedures.

For an installed-package rollback, preserve the source archive, logical manifests, rollout exclusions, catalogs, and derived stores. Restore only the previous Chrono package source slot, alias, compatible Chrono-owned configuration, and startup authorization. Do not restore a whole settings snapshot that can overwrite unrelated package selections. Verify the loaded package in every intended Pi process after a safe reload.

At source revision `30668f7586781410e9958fc56d8f677d08bc7d4e`, final-candidate deployment rollback remains unexercised. The earlier `2.0.25` installed-Pi scenario performed one immediate logical rollover rollback before it found the missing continuation-only source. The persistence correction is implemented, but the ten-shard installed-Pi retry remains pending. Neither result is a default-activation or package-rollback pass.
