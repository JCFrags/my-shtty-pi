# Source catalog

The catalog is the exact-source locator beneath the [candidate pipeline](README.md#current-documentation-boundary). The existing [catalog contract](catalog-contract.md) owns the engine protocol, limits, identity rules, and hash semantics. [Physical catalog publication](catalog-store-publication.md) owns routing, explicit recovery, and atomic pointer changes. Do not duplicate those contracts in callers.

## Write and read paths

Normal ingestion resumes a stored parser checkpoint and consumes bounded appended bytes. It commits complete LF-terminated records, descriptors, hashes, and progress together. An incomplete final record stays provisional. A malformed record or source-identity mismatch refuses instead of skipping history or rebuilding implicitly.

Pinning selects an exact branch leaf or shard-local ordinal. Pages then use the pinned ancestry and cut. Exact reads select bounded event byte ranges and verify the complete stored spans that intersect the request. Neither search nor a status request is an ingestion or repair request.

Bounded first/tail anchors detect selected source changes during append work. They do not certify every historical byte. A complete indexed-prefix integrity scan requires explicit `integrityStep` continuation. Pure appends remain different from replacement, truncation, or prefix mutation.

## Coordinate rules

| Value | Meaning |
| --- | --- |
| Raw offset and length | Bytes in the original JSONL record, including LF only when selected. Raw responses use base64 to preserve exact bytes. |
| Decoded text range | UTF-16 code units after JSON string decoding. This is not a raw byte range or a Unicode character count. |
| Raw hash | SHA-256 over exact stored source bytes. |
| Body hash | The separate decoded UTF-16 chain hash identified by the contract. It cannot replace raw-span verification. |

Large records use resumable streaming parsing. The catalog retains metadata and bounded private parser carry, not a complete decoded body. Decoded chunk storage belongs to [event capsules](event-capsules.md).

## Storage and refusal

The synchronous SQLite adapter runs inside a contained worker. [ADR-002](adr/ADR-002-sqlite-catalog.md) owns the pinned binding, controlled native build, WAL/FULL settings, and allocation-refusal requirement. A reported SQLite heap setting is not a total worker-memory measurement.

Owner-only, no-follow checks reject unsafe routes. Existing-store opens do not bootstrap missing or empty databases. Native read-only preflight can still create transient WAL/SHM bookkeeping for a nonempty database, as ADR-002 explains. It is not a zero-filesystem-change guarantee.

For ordinary lag, resume the existing checkpoint. For corrupt physical storage, use an explicitly selected replacement store and validated pointer publication. Preserve the old database, references, and source. See [migration](migration.md) and [recovery](recovery.md).
