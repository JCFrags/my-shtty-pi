# M00 rollback record

M00 does not deploy or reload ChronoCompact. The rollback point is therefore a read-only backup of the current live package, retained in owner-only local evidence. Its identity and hash are recorded privately and are not copied into Git.

Rollback rule:

1. Do not remove or overwrite the current live package during M00.
2. If a later milestone needs deployment, verify the milestone commit, build, hashes, and smoke test first.
3. Create a new owner-only backup before the live switch.
4. Switch only an atomic package link or directory after temporary-package verification.
5. To roll back, restore the previous verified package link/directory and run the live smoke check.
6. Never restore or edit session JSONL as part of rollback.

The M00 backup has not been used for a live switch. M01 and later must create their own deployment record; this document is not deployment authorization.
