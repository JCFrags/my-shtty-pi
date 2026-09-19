# Independent Memory

Memory owns accepted knowledge and extraction proposals for one logical Pi session. It does not need Chrono, Recall, Telemetry, or Grounded Tools at runtime. It does not ingest conversation history or assign instruction authority to stored text.

Accepted knowledge remains visible after a `/tree` move in the same logical session. Proposals use that same explicit namespace, but they are not accepted knowledge. Todo, Notes, and Workplan remain branch-local. A new unrelated session does not inherit another session's Memory.

## Requirements and storage

Use Linux and Node `>=24.18.0 <25`. Memory uses the built-in `node:sqlite` `DatabaseSync`, not a compiled third-party driver. Node 24.18 supports the connection options and statement methods used here. Bind numbers for integer flags. Do not bind JavaScript booleans or assume that a newer Node 24 documentation page describes the installed version.

The default root is `~/.local/state/pi/context-memory-v1`. Set `PI_CONTEXT_MEMORY_ROOT` before loading the extension to select another private root. Each logical namespace has its own database. Physical-session binding files contain direct references to that namespace. There is no global cross-project database, directory enumeration, or normal lifetime-history replay.

Directories must have mode `0700`. Files must have mode `0600`. The store rejects symlinks, unsafe owners, writable ancestors, unexpected schemas, and replaced database files. Each connection uses a 2 MiB page cache, no memory mapping, a 50 ms busy wait, full synchronization, and a 256 MiB database page ceiling. It does not set SQLite's process-global heap limit. These bounds are initial implementation limits, not a lifetime-scale qualification.

A missing or corrupt existing store is unavailable. Memory does not replace it with empty state. Preserve the root and its bindings together for recovery.

## Native tools

The seven existing tool names and original arguments remain available:

| Tool | Behavior |
| --- | --- |
| `memory_remember` | Create accepted ordinary knowledge. Optional `supersedesMemoryId` changes an existing ordinary head atomically. |
| `memory_update` | Append a correction. Optional `expectedRevision` rejects a stale write. |
| `memory_forget` | Demote accepted knowledge without deleting source or revisions. |
| `memory_promote` | Reactivate accepted knowledge and add an eight-Memory-commit ranking tie-break boost. It does not accept a proposal. |
| `memory_get` | Read one current record, exact `revision`, or `recordedBefore` time. Revision and recording-time selectors are mutually exclusive. |
| `memory_list` | Read a bounded page of current or archived accepted knowledge. |
| `memory_search` | Search accepted knowledge within a bounded indexed page. |

`memory_proposal` adds `propose`, `list`, `get`, `accept`, and `reject`. Acceptance and rejection require `expectedRevision`. Acceptance can correct an existing `targetMemoryId` when `expectedTargetRevision` also matches. The accepted revision and resolved proposal commit together. `memory_get` can recover either record kind.

New mutations return `memoryId`, `revision`, `revisionHash`, and a compact commit receipt. `revisionHash` is not a legacy V2 `eventHash`. Imported legacy event hashes remain available in the record's `legacy` metadata.

Memory no longer measures retention against the length of a conversation branch. Promotion lasts eight Memory commits for ranking, not eight conversation turns. Accepted heads do not expire or demote merely because time passes. Explicit factual validity is separate from retention. Imported V2 turn counters and promotion deadlines remain historical metadata.

## Sources and time

Each revision retains:

- `originalOrigin`, the first source session and leaf, with explicit nulls for unknown legacy values.
- `origin`, the revision operation's source session, assistant-call leaf, and tool call ID.
- `sources`, with source identity, optional opaque reference, role, derivation, and verification state.
- `recordedAt` and `recordedSequence`, the operation's recording time and order.
- `eventTime`, either a declared instant or `unknown`.
- `validity`, either a declared open or closed interval or `unknown`.

Times use UTC ISO strings with millisecond precision. `recordedBefore` answers what Memory had recorded then. It does not answer what was factually valid then. An expired declared interval is reported as expired. Unknown validity is not perpetual validity.

A captured assistant call verifies an operation's origin, not the truth of its text. Supplied evidence links remain unverified. Legacy integrity checks verify the preserved hash chain, not current authority or factual correctness. Confidence is declared metadata. Protected legacy records retain mutation refusal without becoming new instructions.

## Bounds and persistence

Text is limited to 8 KiB. A complete record is limited to 16 KiB and must fit the native result envelope. Each record has at most eight source links, including its generated operation origin. A query has at most 16 terms and 512 bytes. Normal writes touch at most three records.

Native pages scan at most 512 indexed heads and return at most 100 records. The complete native tool result is limited to 32 KiB. Page coverage reports scanned records, matches, excluded results, and scan completeness. Ranking applies to the admitted page, not the entire store. Excluded matches are explicit omissions. Use small `scan` pages when complete browsing is needed. A continuation cursor pins the namespace, filters, and store revision. A changed store rejects a stale cursor.

A write has three stages:

1. Persist a prepared operation and complete owned payload in SQLite.
2. Append a `context-memory-commit-v1` Pi custom entry. Verify that its exact bytes exist in a bounded physical append range, then synchronize the source file.
3. Commit the owned revisions, heads, and receipt in SQLite.

An in-memory `appendEntry` or `message_end` event is not a durable acknowledgment. Prepared revisions are not visible. Native opening or a later write can recover a prepared operation only after its original writer is dead or has released it. A verified anchor completes the prepared operation. A missing anchor marks it unbound without publishing its data. An unverifiable source, oversized append range, or live owner refuses recovery. Retrying a committed operation ID returns the same receipt. An unbound operation ID is not reused.

The read-only context connector never performs recovery, creates a namespace, or mutates records. It reports pending or unavailable instead. Native reads can initialize an unused persisted standalone session and perform explicit pending-operation recovery before the read. A branch change invalidates captured operation origins. An import checks the lifecycle again after each asynchronous phase.

## Initialization and physical rollover

Initialization is lazy. A provisional `session_start` before Pi setup does not create an empty store. The first native operation verifies the physical session header and persisted file before creating a namespace. Mutation tools also require the bounded `tool_call` origin capture.

A direct physical-session binding avoids history walks. When no direct binding exists, Memory examines at most 64 parent-linked entries for one validated bootstrap binding. It does not inherit a namespace from `parentSession`. A child without a bootstrap binding remains unavailable unless the operator explicitly initializes or imports it. A scan that reaches its limit refuses rather than guessing.

`/memory-init` explicitly creates a fresh logical namespace for an unbound persisted session. This command does not import old state or replace a pre-existing deterministic store. Use it only when a fresh namespace is intended.

The async V2 transfer provider returns one entry:

```ts
{
  customType: "context-kit:owner-binding:v1",
  data: {
    version: 1,
    provider: "memory",
    sourceSessionId,
    sourceLeafId,
    binding,
  },
}
```

The public callback utilities are exported from `@context-kit/memory/bindings`:

```ts
const binding = captureMemoryBinding(root, { sessionId, leafId });
restoreMemoryBinding(root, binding, { sessionId: replacementId, sourcePath });
```

Capture and restore require a complete, available store with no pending operation. Restore verifies the source binding, target file header, store identity, and exact committed revision. An advanced store refuses the stale transfer. The bootstrap entry contains no filesystem path. It is a same-store binding, not a snapshot. Missing store bytes cannot be reconstructed from this entry. The fresh extension restores after the replacement file is persisted. No stale extension object or separate restore event is needed.

## Exact V2 import and rollback

Stop the legacy Memory owner before selecting the independent owner. The handoff must stop legacy tool registration, automatic promotion writes, and pinned legacy reads together. Disabling only legacy mutations is not a complete handoff. The independent extension does not modify Chrono settings itself.

Import only an explicitly selected sidecar into an empty destination:

```text
/memory-import-v2 {"path":"/absolute/example.chrono-memory-v2.jsonl","sourceSessionId":"optional-original-session-id"}
```

The import admits at most 8 MiB and 4,096 events. It verifies stable no-follow source bytes and the original chain, then stages at most 64 revisions per transaction. Staged revisions stay hidden. Publication changes the visible dataset only after the final durable Pi anchor. Interrupted staging resumes from its saved progress. Reimporting the same source identity and byte digest returns a no-op receipt.

The first V2 `previousEventHash` has 64 zeroes. Subsequent chain hashes and event IDs have 20 hexadecimal characters. Import preserves this exact mixed format. It preserves the raw file bytes, IDs, transitions, timestamps, turns, source references, protected metadata, and counters. New SHA-256 revision hashes are separate. `importedAt` is separate from the original recording time. A supplied original session ID is operator-declared provenance. An absent original leaf remains null. Failed validation does not create an empty replacement or publish a partial import.

The raw source is available to operator code through bounded `MemoryStore.importBytes(importId, offset, length)` reads. The original sidecar is never rewritten. Retaining the independent root alone permits a code-selection rollback, but does not make post-import knowledge available to the old writer. A pre-import session alone is not a rollback of new Memory data.

## Explicit reverse V2 export

Reverse export is an operator command and API, not an agent mutation tool or a background mirror. It writes three NEW files: a usable V2 sidecar, a complete companion for native record state, and a final receipt. Export does not activate a writer or create a target continuation.

Use `exportMemoryV2` from `@context-kit/memory/export-v2` or the package root:

```ts
const receipt = await exportMemoryV2(store, {
  expectedStoreId,
  expectedStoreRevision,
  targetTurn,
  sidecarPath,
  companionPath,
  receiptPath,
  signal,
});
```

The optional `signal` can refuse an already cancelled operation. The bounded export and publication run synchronously while SQLite holds a reserved transaction. Other connections cannot advance the write cut during publication. This does not provide an interruptible background export or prevent writes after the receipt returns.

`targetTurn` is required. Supply a nonnegative safe integer explicitly. It is only the target continuation's V2 turn coordinate for converted events. The exporter does not infer it from `recordedSequence` or conversation history. Original prefix turns remain unchanged. An actual promotion whose `targetTurn + 8` exceeds a safe integer refuses.

1. Stop concurrent Memory activity. Obtain the current `storeId` and `storeRevision` from a native read.
2. Select three distinct absolute output paths in existing private `0700` directories. Existing files, symlinks, and unsafe paths refuse. The new files use `0600` permissions.
3. Supply the expected cut and explicit target turn. In Pi, use the idle-only command:

```text
/memory-export-v2 {"expectedStoreId":"store-id","expectedStoreRevision":12,"targetTurn":0,"sidecarPath":"/private/new-target.chrono-memory-v2.jsonl","companionPath":"/private/new-target.memory-companion.jsonl","receiptPath":"/private/new-target.memory-receipt.json"}
```

The exporter refuses a pending operation, a changed expected cut, an unsupported dataset, or incomplete conversion. It reads revision metadata in 64-row keyset pages. It admits at most 4,096 complete source revisions and 4,096 total V2 events, including the original prefix and conversion-only provenance updates. Each body has an 8 MiB limit. The two bodies together have a 16 MiB limit. The receipt has an 8 KiB limit. These are refusal limits, not truncation settings.

The V2 sidecar starts with the retained original bytes when an import exists. The original byte sequence, mixed hash format, timestamps, turns, event IDs, and protected verification fields stay unchanged. An absent final newline gets a separator only after the preserved prefix. Native remember, update, forget, promote, and proposal acceptance use the existing V2 pure hash and event semantics. Pending and rejected proposals do not become accepted V2 knowledge.

V2 lifecycle transitions retain the old head's source reference, but native revisions record the new operation's reference. Where needed, the converter adds a labeled same-text/scope/confidence `update` before a lifecycle transition or implicit supersession. These provenance updates do not touch or reset use counters. The companion maps each source revision to the original or generated V2 event IDs and hashes. Unsupported operations and protected mutations refuse.

The exporter compares every accepted head, including demoted and superseded heads. IDs, text, scope, source reference, authority, protection, confidence, state, creation and revision time, use count, and supersession must match exactly. It refuses a semantic mismatch instead of normalizing accepted state. For example, native scope preserves surrounding spaces while the V2 builder trims scope. Such a store cannot export under exact parity.

The companion contains every committed native revision, including all proposal revisions, accepted proposal links, event time, validity, original and revision origins, source identities and verification labels, reasons, exact native counters, recording sequences, and native hash chains. Imported metadata remains exact. A header identifies the cut and import. Each head also reports its V2 turn counters. A final integrity row binds the preceding companion bytes and complete sidecar digest. Keep the independent root and source sessions as separate recovery assets. The companion is record-state data, not a byte-for-byte database or source-session backup.

No synthetic `touch`, counter reset, or retention rebase occurs. V2 turn-based retention can hide current ordinary knowledge from pinned rendering. Independent Memory does not automatically demote and uses an eight-commit promotion boost. The receipt reports the default V2 pinned-demotion count at the supplied target coordinate. The companion identifies affected heads. Native source-known reads and pinned visibility are different checks.

Both bodies are synchronized and read back before the final receipt is published. The receipt binds artifact paths, byte counts, SHA-256 digests, file identities, the exact native cut, original prefix, and semantic comparison. A failed write can leave partial task-owned output files. A partial pair or invalid receipt is not ready for a writer switch. No export path is overwritten on retry.

Before selecting the old writer:

1. Verify the sidecar as the actual fresh target's `memorySidecarPath(targetSessionFile)`. An arbitrary exported filename is not active.
2. Verify accepted post-import knowledge through the old native source-known reads. Check pinned-retention differences separately.
3. Recheck that the independent cut has no pending or later writes. Select exactly one owner.
4. Keep the original sidecar, independent root, companion, and receipt. An automatic return from later V2 writes into this companion baseline is not implemented. A future return must reconcile those writes instead of reviving stale independent heads.

`activation.performed` in the receipt is always `false`. The parent integration owns the fresh continuation, writer selection, and activation verification.

## Context connector and verification

The V2 connector returns `knowledge` cards by default. It returns proposals only when the request explicitly includes category `proposal`. Each card has logical-session visibility and exact recovery through `memory_get` with a revision string equal to the card revision. The connector does not expose private store paths. Event time, validity, provenance, and omitted fields remain separate. The shared collector gates Memory on active `memory_get` and does not activate it.

From the repository root, build the existing protocol and Chrono comparison fixture before this focused check:

```sh
node --experimental-transform-types --test packages/pi-context-kit/memory/test/memory.test.ts
```

The component scenario uses synthetic private files and a registered extension factory. It compares imported heads with the existing V2 materializer. It exercises exact-byte import and reimport, temporal reads, proposal acceptance, tree visibility, bounded pages, async binding transfer, and failed-anchor refusal. It does not call a model, import live state, prove installed-Pi activation, or qualify lifetime scale.

The separate reverse-only scenario uses the old compiled V2 materializer and file reader:

```sh
node --experimental-transform-types --test packages/pi-context-kit/memory/test/reverse-export.test.ts
```

It exercises import, native correction and proposal acceptance, lifecycle conversion, exact-prefix export, complete companion recovery, artifact digests, explicit target turn, unchanged source/store bytes, exact accepted-head comparison, and semantic-mismatch refusal. It does not select the old writer or substitute for actual old native tool reads on a fresh target. Run this focused scenario for reverse-export changes instead of rerunning the unrelated forward scenario.
