# Owned Notes

`@context-kit/notes` owns a separate branch-local scratchpad store. It uses the validated Grounded Notes reducer and native result rendering. It does not import the legacy extension factory or share a namespace, store instance, or lock with Todo or Memory. Notes remain scratchpad state, not accepted durable knowledge or instruction authority.

## Native interface

The `notes` tool retains `add`, `list`, `read`, `append`, `update`, `search`, `archive`, `remove`, and `clear_archived`. Existing field normalization, metadata pagination, search windows, archive/remove rules, IDs, timestamps, and `expectedRevision` checks are unchanged.

The native limits remain 256 retained notes, 32 KiB UTF-8 per body, and 1 MiB total bodies. Archived notes count toward these limits. Titles, tags, and native revision rules use the existing validators. Complete root admission allows 8 MiB of canonical JSON so escaped text and metadata do not reduce the body allowance. Over-limit or corrupt input is refused, not shortened.

`read` retains exact native note fields in `details.result`. The native text renderer and private full-output recovery remain available. `list` and `search` retain native page metadata and result shapes. Mutation results retain the compatible native event, with an owned-result marker so the new loader does not mistake it for a legacy write. Tool results are not the persistence mechanism.

## Persistence and lifecycle

The default root is `$XDG_STATE_HOME/pi-context-kit/notes`, or `~/.local/state/pi-context-kit/notes`. `NotesOptions.storeRoot` selects an exact private fixture directory. Every write stores a complete bounded immutable snapshot. Earlier roots, note revisions, and import source objects remain available after an update, archive, or removal.

Each mutation resolves its source view, validates the operation, publishes the owned root, appends a Pi custom anchor, and verifies and syncs that exact on-disk append before it becomes visible. All Notes operations use one instance-local queue. A native note revision is distinct from its immutable owner commit identity.

`message_end` does not acknowledge persistence. There is no corresponding handler. Ephemeral and deferred sessions refuse writes with `state-store-unpersisted`. A prepared object without a verified anchor is not visible state. An uncertain append remains pending until reconciliation. A missing or corrupt owned root never becomes an empty scratchpad.

Session start and tree navigation use a direct binding or one bounded ancestry-resolution page. Native operations can advance resolution one page per invocation. `agent_settled` can advance one further page. Normal startup never calls `getBranch()` or replays legacy note events. Context queries do not perform restoration or import. Forks inherit exact anchored source state and new writes create a new source-bound commit.

## Legacy import

Select only one Notes writer. Use `/notes-import` for an unimported legacy branch. One invocation collects or replays at most 128 complete source entries within an 8 MiB page budget. Repeat while pending. There is no lifetime entry-count cap and no hidden startup import loop.

The importer retains immutable linked source pages and cursor objects. Its bounded progress pointer is indexed by exact source file identity, session, and leaf. It resumes after restart. The existing event reducer and checkpoint validator preserve note IDs, counters, timestamps, revision chains, archived records, and removals. Repeating import on an owned branch does not replay it.

The receipt names the source file and source session/leaf, coverage, and a `normalized-native-entry-pages/v1` digest chain. Source objects preserve detached native entries, not original JSONL whitespace bytes. The original JSONL is not rewritten or deleted. Invalid, oversized, changed, or corrupt source refuses import without exposing partial state.

## Complete transfer and rollback

The async V2 transfer callback returns the complete `grounded-state-checkpoint-v1` plus separate `context-kit:owner-binding:v1` metadata. It does not also register the old synchronous checkpoint listener. Pending and corrupt states refuse transfer. The shared transport enforces 8 MiB per provider and does not shorten native state.

A fresh checkpoint-only bootstrap is recognized within 32 ancestry entries, only after reaching the root. It requires one Notes checkpoint, no ordinary Notes events, and at most one matching owner binding. Native state is authoritative. A supplied binding must match the exact native digest, revision, provider, and source. Bootstrap publication uses the same durable owner and retains a source receipt.

`NotesStore.captureNative()`, `ownerMetadata()`, `checkpoint()`, and `restoreNative()` expose complete native integration. `restoreNative()` is for a proven empty replacement, not for replacement of unimported history. Context uses the shared pure note projector and native note revisions. Context transport failure cannot fail a native mutation.

To roll back after new writes, transfer the current complete native state into a fresh replacement before loading the legacy writer. Keep the owned objects and source sessions. Selecting an old pre-import session would lose newer writes and is not a data rollback.

## Verification boundary

Private synthetic checks exercise persisted sessions, native reads, import/reopen, branches, and registered callbacks. Installed-provider selection and multi-provider rollover/rollback require the parent integration checks. Source inspection or a build is not evidence of local activation.
