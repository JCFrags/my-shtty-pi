# ADR-005 — Event capsule schema and reducer versioning

Status: proposed M05 contract candidate. Not M05 acceptance or activation.
Scope: pure schemas, identity, reduction boundaries, and read/derive protocol only.

## Context

M04 can locate exact chronological events and body descriptors, but compaction still repeats reduction and large-body decoding. M05 needs reusable deterministic alternatives without turning reduction into an authoritative semantic-state layer. A-0004 also requires protected conditions, exceptions, negation, decisive failures, and unresolved status to survive targeted reduction.

## Decision

M05 stores deterministic, explicitly **lossy** chronological capsule alternatives and exact decoded chunks. A capsule is not universal semantic state, a truth store, or an independent source. The M04 catalog and immutable JSONL remain authoritative. Every fact, protected cue, omission, and alternative retains a scoped source reference.

The binding TypeScript contract is `packages/pi-chrono-compaction/src/capsule-contract.ts`, protocol version 1. Importing it performs no I/O, loads no SQLite binding, and starts no worker.

## Stable identity and pinned reads

A physical derived store is identified by its own UUID and by the exact M04 catalog physical UUID, logical session, catalog generation, derived/capsule/chunk schema versions, reducer-set version, and configuration hash. Incompatible schema, reducer, configuration, physical catalog, or generation inputs use another physical derived store. M05 uses a separate `derived.sqlite`; it does not add tables to or relax the strict M04 database.

Source-local capsule identity excludes catalog pins, event cuts, worker job cuts, page size, and batch size. The same source and frozen reducer inputs therefore produce the same bytes in one large batch, many small batches, or after restart. A later compatible view can reuse the source-local prefix.

A source reference contains catalog UUID, session, generation, shard, catalog event sequence, shard ordinal, catalog segment, normalized descriptor, optional block index, field, raw byte range, and a content hash. An entry ID alone is insufficient. References are discriminated:

- `ScopedBodySourceRef` has raw JSON-string byte coordinates, decoded UTF-16 code-unit coordinates, and the M04 `chrono-utf16le-chain-sha256-v1` body hash.
- `ScopedRawSourceRef` has an exact raw range and raw SHA-256 for non-body JSON such as tool-call arguments or structural fields. It must not pretend to have body coordinates or a body hash.

The pure `sourceRefWithinViewBounds` validator checks only store/generation/segment/cut bounds. It is not authorization and does not prove ancestry. At derive and read time, the worker must obtain each event and descriptor through the supplied M04 `CatalogView`. It must not accept a sequence merely because it is below `eventCut`, and it must not read a sibling or future event.

Chronological order is catalog event sequence followed by normalized descriptor. A paired tool-call join is allowed only after the M04 catalog has selected both references on one pinned ancestry and the call strictly precedes the result by event sequence and then descriptor order. Both references remain in the envelope. No lifetime call map or cross-branch inference is allowed.

## Exact decoded chunks

Decoded strings are immutable UTF-16LE chunks of at most **32,768 UTF-16 code units / 65,536 bytes**. Boundaries are code-unit boundaries, so a legal boundary can fall between surrogate halves. Escaped Unicode, literal Unicode, lone surrogates, CRLF, and empty strings are not normalized. Images and data bodies remain opaque and source-linked; M05 does not decode or reinterpret their payload.

A body descriptor records its complete decoded length, body hash, provenance, opacity, and chunk count. The complete body must verify against the M04 decoded length and `chrono-utf16le-chain-sha256-v1` hash. Each non-empty chunk records its fixed coordinate, exact UTF-16LE byte length, content hash, immutable segment hash, and segment offset. Empty bodies have zero chunks.

Decoder work is streaming. Its private resumable state preserves raw and decoded offsets, JSON escape progress, partial Unicode escape, partial UTF-8 scalar, the actual bounded chain-hash pending bytes, and the exact unfinished UTF-16LE chunk bytes. The unfinished carry is strictly smaller than one chunk, stays in private SQLite, and never crosses IPC or logs. The concrete decoder can map the shared JSON-string decoder state to this persisted cursor. It must preserve closing-quote and suffix boundaries and never decode a giant body into one JavaScript string.

## Reducer boundary

One `SourceBlockReducerInput` contains a typed block, conservative structural metadata, and at most 32,768 decoded units. `SourceBlockReducerBaseInput` removes the window for a streaming reducer's stable base. A giant body is reduced with begin/feed/finalize-style state over bounded `CapsuleReductionFeed` windows; it is never supplied whole to any reducer. The bounded serializable state retains actual selected head/tail/cue excerpt bytes and coordinates, so finalization does not rescan the full body. M04 does not guarantee `isError`, exit code, cancellation, or complete tool arguments in descriptor metadata, so missing fields stay unknown or use bounded exact extraction with a raw source reference.

The source-local reducer families are frozen and versioned:

- terminal and test output;
- Git diff;
- generic text;
- assistant extractive and cleanup;
- lossless normalizer;
- small JSON.

Existing deterministic reducer code can be adapted only after its source access and budget satisfy this contract. File-read relevance, search-result relevance, model/LLM semantic compression, repeat factoring, resource lineage, current state, and cut selection are explicitly adapter-only decisions. They depend on request context, later evidence, or policy and cannot be persisted as source-local reducer facts.

A reducer envelope freezes reducer family/version, reducer-set version, configuration hash, input hash, and alternative/token/unit budgets. Every alternative is marked `lossy: true`, remains in source order, and retains source references. Generated retrieval copies remain chronological actions with generated provenance; they are not independent original payload. Mixed assistant prose keeps mixed provenance rather than laundering a generated retrieval block into original evidence.

Facts are structural or exact extractive facts. Outcome defaults to `unknown`. `success`, `failure`, `cancelled`, or `pending-approval` is allowed only when indexed structural facts identify its supporting fact indexes. No reducer may infer completion from tone, quoted text, an unrelated event, or another revision.

Conditions, exceptions, negation, failure, unknown status, cancellation, pending approval, restrictions, and identifiers survive as exact protected cues with coordinates. Loss outside a bounded neighborhood uses an `exact-range` omission with a real removed range and unit count. Normalization or repeat collapse uses `transformation-loss`, an affected source range, and `omittedUnits: "unknown"`; it never fabricates an exact removed count. A cue or source reference is never itself lossy authority.

### Project-lead F001–F003 correction candidate

The current correction candidate uses `capsule-pure-v3`. Its resumable reducer
state is version 3; version-1 and version-2 state must not resume under the new
mechanics. Terminal and small-JSON family versions become 4.0.0; the other
affected families become 3.0.0. The earlier v2 candidate used state version 2,
terminal/small-JSON 3.0.0, and other families 2.0.0. Derived SQLite layout stays version 2 and capsule, chunk,
and wire schemas stay version 1. These are different version boundaries.

Derivation must require the current pipeline identity before storage or source
work. A family-version change alone cannot prevent reuse of an already complete
artifact. Use a fresh physical derived identity for the corrected pipeline; do
not relabel or migrate an old store. Old read-only pins remain available under
their original identity, without authorizing further old-pipeline derivation.

Head, tail, and protected neighborhoods form an ordered union of exact source
spans. Overlap must not discard an uncovered suffix or duplicate bytes. Only a
real gap gets an omission marker. Internal source-to-output mappings are clipped
through final rendering and output caps, so coverage describes retained output,
not merely an earlier selection.

Protected evidence uses bounded exact clause/line neighborhoods, with up to 128
UTF-16 units on either side of an ordinary cue. At most 16 neighborhoods and
4,096 neighborhood units are retained, separately from the 16-cue/2,048-unit
cue budget. These are not universal sentence-understanding guarantees. A
truncated neighborhood or exhausted cap must disclose loss and exact recovery;
a detached cue never establishes approval or a resolved outcome.

The `exit code` recognizer carries incremental grammar state, with at most 512
whitespace units and 32 digits. Longer forms and over-limit URL/path tokens
must disclose lexical degradation rather than depend on the feed partition.
Ordinary and incremental grammar cues wait behind one settled source frontier
before source-ordered admission to the fixed cue cap. Sorting only a feed's
matches or already admitted cues is insufficient. Ordinary scanning retains a
fixed 512-unit carry: 384 units of unsettled scan context plus 128 units for
exact left neighborhoods. Pending cues and lexical-overflow endpoints cover
only this bounded unsettled region; global input, output, memory, and time
limits do not increase. The grammar tracks Unicode code points while retaining
exact UTF-16 coordinates, including a pending high surrogate across feeds.
Failed literal matches retain lexical context instead of inventing a new word
boundary. Final bytes, loss accounting, and restart behavior must agree across
legal partitions.
Earlier pipeline campaigns are historical evidence, not validation of these
corrected mechanics.

## Bounded requests and readiness

The pure worker request union has four operations:

- `status`, optionally for a pinned view;
- `derivePage`, with branch-lineage cursor and bounded event/descriptor counts;
- `capsulePage`, with event/descriptor keyset cursor;
- `chunkRange`, for one bounded selected decoded range.

There is no full-manifest, full-prefix decode, whole-body, or lifetime-map request. A derive cursor includes the complete physical identity and the view lineage. It can resume into a monotonic append of the same branch and segment prefix. It refuses a sibling branch, changed segment, older cut, catalog generation, or physical store. Separate branch cursors prevent one global last-sequence value from skipping unseen branch events.

Catalog, capsule, and chunk readiness are distinct. Capsule and chunk counters report eligible, ready, unsupported, failed, and excluded items independently. Unsupported, failed, and excluded items do not count as reduced/ready. Honest bounded recovery markers can report regeneration or resumable degradation. Catalog lag or unavailability does not falsely rewrite a derived layer as complete.

Wire limits are 64 KiB request and 256 KiB response. Requests carry explicit derived and authoritative M04 catalog directory routes; neither route is inferred from a UUID, and persisted route mismatch refuses. Source work is at most 8 MiB per job in 64 KiB reads. M03 containment remains the process boundary: 128 MiB V8, 256 MiB OS/RSS, 30 seconds, shared queue, and low priority. The separate 64 MiB SQLite-native allowance is not JavaScript heap or total RSS, and JavaScript wrappers do not establish native-I/O accounting.

## Alternatives considered

- Persist the current compactor's final choice. Rejected because budgets, cuts, future context, lineage, and relevance are adapter decisions; it would discard valid alternatives and make append output context-sensitive.
- Store free-form semantic claims. Rejected as premature M07 work and because unsupported completion or authority could be invented.
- Use entry ID as identity. Rejected because IDs can be absent or duplicated and do not bind a physical store, generation, shard, descriptor, field, or coordinates.
- Decode or reduce whole giant strings. Rejected because memory would scale with source size and restart state would not be bounded.
- Treat generated retrieval copies as new evidence. Rejected because this duplicates provenance and can amplify copied claims.

## Consequences

Capsules improve incremental chronological replay but cannot answer all relevance or current-state questions. Those remain adapter or later-milestone work. Exact chunks make selected recovery deterministic without making capsule text authoritative. Unknown, unsupported, missing, and corrupt cases remain visible rather than inventing completion.

M05 stays default-off shadow/status-only. Any current-compactor compatibility adapter consumes validated capsules as synthetic input only and must safely characterize differences. This ADR does not authorize provider/model calls, private source access, settings or policy changes, production activation, M06 work, deployment, or publication.

## Migration

There is no import from lifetime maps, old candidate caches, or an unknown capsule schema. Build a new physical derived store from caller-declared M04 catalog views. A reducer family or configuration change gets a new version/configuration identity; it does not rewrite old immutable capsule bytes. Existing source JSONL, M04 stores, pins, and current compactor behavior remain available during default-off shadow comparison.

## Reversal path

Stop scheduling M05 requests and omit the derived store from the compatibility adapter. Retain the immutable source and M04 catalog, then remove only an explicitly selected derived-store pointer in a separately approved cleanup. No source, M04 generation, production setting, or old pin needs conversion or deletion.
