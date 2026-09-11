# Permanent archive operations

## Location and format

Glance uses Node 24's built-in SQLite implementation. The default database is `$XDG_STATE_HOME/pi-project-glance/archive-v1.sqlite` when `XDG_STATE_HOME` is absolute, otherwise `$HOME/.local/state/pi-project-glance/archive-v1.sqlite`. The containing directory is owner-only (`0700`). The database and SQLite sidecars are owner-only (`0600`). Keep this directory outside the checkout and disposable runtime directories. Do not put it in Git or model context.

Schema version 1 stores sanitized eligible updates, bounded previews, source identities, branch membership, archive actions, and import/checkpoint metadata. It does not store complete conversations or tool payloads. WAL (write-ahead logging), `synchronous=FULL`, atomic transactions, and idempotent action receipts protect committed updates. Concurrent writers use SQLite locking with a five-second busy timeout. A lock timeout, disk-full error, or failed commit is an error, not successful dismissal.

No automatic pruning runs. Disk use can grow permanently. Back up the archive and monitor available space using ordinary filesystem tools. Do not delete SQLite `-wal` or `-shm` files from a running installation.

## Selected-session import

Normal capture reconciles only the selected session and follows incremental checkpoints. The one-time legacy importer additionally visits all branches in one explicitly selected session file. It recovers eligible updates and valid old dismissal records beyond the former 500-entry window. Seen-only records do not archive undismissed updates. It does not discover or scan other session files.

1. Select the exact session JSONL file and, when known, its session ID. Do not use a directory glob.
2. From the built `packages/pi-project-glance` release directory, run the following with `SELECTED_SESSION_FILE` set to that absolute path. Set `EXPECTED_SESSION_ID` to add an identity check. Use the same `XDG_STATE_HOME` as the installed extension.

```sh
node <<'JS'
import { createDurableGlanceRepository } from './dist/history/store.js';
const selectedPath = process.env.SELECTED_SESSION_FILE;
if (!selectedPath) throw new Error('SELECTED_SESSION_FILE_REQUIRED');
const repository = createDurableGlanceRepository();
const controller = new AbortController();
const pause = () => controller.abort();
process.once('SIGINT', pause);
try {
  const result = await repository.importSelected({
    selectedPath,
    expectedSessionId: process.env.EXPECTED_SESSION_ID || undefined,
    signal: controller.signal,
  });
  console.log(JSON.stringify(result));
} finally {
  process.removeListener('SIGINT', pause);
  repository.close();
}
JS
```

3. Keep the metadata-only result privately. It contains the import ID, committed byte offset, inserted update count, discovered branch count, recovered dismissal count, conflicts, and coded gaps. It contains no card text.
4. If interrupted, repeat the identical selected path and identity. Import resumes from the last committed batch. Do not replace the source file to bypass a source-change refusal.
5. Reopen the selected session's pane to inspect its own branch. Importing another branch does not make that branch's cards visible here.

Keep the selected source append-only during import and resume. The importer checks file ownership, rejects symlink/non-regular sources, verifies device/inode and the first 4,096 bytes, and reads 64 KiB chunks. This identity check does not detect every in-place rewrite after that prefix. It commits batches of 128 entries and can pause at a committed boundary. A single JSONL line larger than 8 MiB is a reported recovery gap, not silently accepted content. Invalid entries, missing parents, changed sources, and conflicting identities are also reported. Missing or already-deleted source history cannot be recreated. Import success with gaps is not a claim of complete historical recovery. A worker failure can leave its last persisted status as `running`. That status is not proof of a live worker or completion. Preserve the failure and repeat the same explicit import to resume safely.

## Backup

Use SQLite's online backup API, not a copy of only the live main database file. Python 3 with its standard `sqlite3` module provides one option. Set `ARCHIVE_DATABASE` to the exact database and `ARCHIVE_BACKUP` to a new path in an existing owner-only backup directory. Keep backups private because sanitized updates can still contain personal material.

```sh
python3 - <<'PY'
import os, pathlib, sqlite3
source = pathlib.Path(os.environ['ARCHIVE_DATABASE']).resolve(strict=True)
target = pathlib.Path(os.environ['ARCHIVE_BACKUP'])
fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
os.close(fd)
with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as src:
    with sqlite3.connect(target) as dst:
        src.backup(dst)
        if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('BACKUP_INTEGRITY_FAILED')
print('BACKUP_VERIFIED')
PY
```

A failed command can leave a partial backup file. Retain it for diagnosis but do not treat it as verified. Use a different new destination for another attempt. Back up selected Pi session files separately if you also need their original source or pending questions. The archive database is not a backup of question delivery history.

## Restore

Restoring an older backup can omit newer saved updates. Do not overwrite the only current copy.

1. Coordinate a safe window for every Glance owner. Preserve drafts and pending answers. Close panes and stop archive writers through supported extension/session lifecycle controls. Do not stop unrelated services or the workstation.
2. Create and verify an online backup of the current database first.
3. Verify the candidate backup's integrity and schema version in a separate owner-only directory. Use a compatible retained release against a copy, not the only backup.
4. Retain the current database and its sidecars together as a rollback set. With all writers stopped, install the verified backup as the configured database with mode `0600` in its `0700` directory. Do not combine sidecars from different database copies.
5. Safely reload affected extensions and reopen panes. Verify branch identity, inbox/history counts, expanded-body recovery, and pending question preservation. Keep the pre-restore backup until the user accepts the result.

Use selected-session import to reconcile recoverable source entries after restore. Report any missing newer archive actions honestly. Never claim that a restore recovered data absent from both backup and surviving source.

## Migration and code rollback

Schema changes run transactionally before use. Invalid or interrupted schema initialization fails without deleting stored updates. A schema newer than the running code understands is refused before WAL changes. Keep an archive backup and the prior immutable runtime root before a future schema upgrade.

Rolling code back must not delete, truncate, rename away, or regenerate the permanent archive. A pre-archive Glance release does not display this store, but leaving the database intact allows a compatible release to resume later. It is not a full-feature rollback. Do not use an old release to dismiss newly captured archive cards. Prefer the newest retained release that supports the installed schema. Do not lower `PRAGMA user_version` to bypass compatibility checks.

## Error handling

The pane reports `history_storage_failed` without exposing SQL, file paths, or source text. Unconfirmed writes remain unconfirmed and must not remove the card optimistically. Restore storage availability or permissions, then retry/reconnect. Do not delete the archive to clear an error. Keep metadata-only diagnostics private and report unresolved conflicts or recovery gaps rather than inventing missing updates.
