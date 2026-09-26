# Local idea storage

Use this with the [capability-ideas workflow](../SKILL.md) before capture or review.

## Location and approval

The store is `~/.local/state/pi-capability-ideas/ideas/`. Each idea is one `CI-<32 lowercase hexadecimal characters>.md` file. The random ID remains stable if its title or contents change. There is no shared index, latest-record pointer, database, or service.

Only create the store when the user approves local idea capture. The store's presence is not permission to collect information outside the current scope. For an approved setup, first check that the intended paths are absent or are the expected existing store. Do not replace files, symlinks, or another owner's directory. Create the parent and `ideas` directories with mode `0700`, owned by the current user, outside Git and shared or synced directories. Record the approved local scope in a private README beside `ideas`, not in a public issue.

Before reading or writing, inspect ownership, file types, permissions, and ancestor paths with local filesystem tools. The store directories must be real directories, owned by the current user with mode `0700`. Ancestors must be owned by the user or root and must not permit group or other writes, except sticky directories such as the system temporary directory. Do not follow symlinks in these paths or in idea files. Existing idea files must be regular files owned by the current user with mode `0600`. If checks fail, report the limit. Do not silently repair permissions or create a substitute store.

These are ordinary local permission checks, not protection against another program running as the same user. The creation helper checks directory ownership and modes. It does not verify approval, Git tracking, or synchronization services. Those remain setup and workflow checks.

## Create one file

Set `skill_dir` to the installed skill directory. Run:

```sh
python3 "$skill_dir/scripts/new-idea.py"
```

The helper requires Python 3 on POSIX. It takes no arguments. It reads the bundled template, allocates a random CI ID, and exclusively creates one mode-`0600` file in the existing store. It prints that file's local path. Read and edit only the returned file to fill the template. It never overwrites a file, creates the store, publishes, installs software, or changes an existing idea. A failed write can leave a partial file. Inspect the exact returned or known record before retrying, and do not delete other records as cleanup.

For search and review, use the available local file and search tools against this store only. Read likely matches by exact path. Use pagination when needed. Do not substitute a latest file for an exact ID. Do not scan diagnostic evidence stores or unrelated private histories to populate ideas.

## Retention and decisions

Keep one idea per file. Do not change the ID or recycle a declined idea's file for a different proposal. A review is read-only unless the user separately requests note changes. A status such as `deferred` or `declined` records a decision, not a reason to erase history. Do not add an `approved` status without a source-backed user decision and its scope, and never use the status alone as execution permission.

Keep the store when updating or uninstalling the skill. No automatic archive, deletion, upload, or synchronization is configured.
