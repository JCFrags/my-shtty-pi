# Hierarchical history rollup V2

## Status and boundary

The V2 history rollup store is a hardened research path. Pi JSONL and the current ChronoCompact replay remain authoritative. The default-off shadow evaluator can measure V2 after a compaction result is ready. V2 text never enters model context, a compaction response, the regular Pi summary, or the retained raw tail.

The path is retrospective. It does not intercept or change a tool result. It makes no model or network call.

## V2 schema and storage

For `session.jsonl`, V2 uses the owner-only directory `session.jsonl.chrono-history-rollups-v2/`. Schema 1 directories with the V1 suffix are ignored. They are not migrated or deleted.

V2 uses complete SHA-256 hex identities for nodes, node content, manifest integrity, branch manifests, query indexes, and normalized claims. Existing node files are read and verified before reuse. A mismatched schema, identity, or content hash is not accepted.

The manifest records reachable node count and bytes, leaf count, rollup count, tree levels, source entry count, and source byte coverage. Normal updates derive these values from reachable manifests. They do not scan the node directory.

Directories use mode `0700`. Files use mode `0600`. Publication writes and flushes a private temporary file, renames it, and flushes the directory when supported.

## Typed value and lifecycle relations

`history-value.ts` creates bounded records with source authority, confidence, static value, normalized identities, and explicit relations. Dynamic value exists only at query and render time.

Protected restrictions store a complete normalized-text hash, bounded subject fingerprint, authority, and exact-source requirement. Nodes do not store protected exact text. Exact duplicates can merge. Supersession requires explicit correction language, the same deterministic subject, and authority that is not lower. Recency alone does not supersede. Assistant or derived state cannot supersede user authority.

Failures use signature, command, resource, and task identities. Resolution requires a matching signature, matching command and relevant resource, matching task with explicit resolution, or an explicit correction relation. A generic later `passed`, `fixed`, or `resolved` message does not resolve an unrelated failure.

Tasks use stable identities. A final assistant statement alone does not close a task. Linked successful validation, explicit user acceptance, or an explicit completion event can close it. Resource reads, writes, validations, and observations remain separate roles.

## Cross-leaf context

The branch manifest carries bounded open tool-call references and typed open state. The next leaf loads exact source only for needed open calls. It parses that verified call context with new entries, keeps records sourced by the new leaf, removes matched calls, and retains unmatched calls. Nodes omit complete tool arguments and complete successful tool output.

Leaf boundaries enforce source-byte, source-entry, and historical-block targets. One source entry is never split and can exceed a target.

## Bounded update work

An exact hit verifies the source-ledger state and requested branch leaf. It checks zero old leaf digests, scans zero node-directory entries, and writes zero files.

A same-branch append walks the new parent-chain suffix. It uses the prior manifest and source-ledger tail, changes the open leaf and tree path, and publishes new manifests. It does not recalculate all old leaf digests or load every old node. A branch switch finds the exact common ancestor, reuses verified sealed common nodes, and excludes abandoned records.

Update metrics expose visited entries, old leaf digest checks, directory scans, old and new node loads, changed tree-path nodes, and exact-hit writes.

## Writer ownership

A lock binds schema, PID, Linux process-start identity, nonce, creation time, and inode. A matching PID and start identity is live. A missing process is dead. An unreadable or unverifiable process remains protected. Other platforms do not use age alone to remove a lock.

Release rechecks nonce, PID, process-start identity, and inode. It cannot remove a replacement owner's lock. Cancellation before manifest publication leaves the old manifest active.

## Dynamic tree query

Each node has a bounded query index. It contains store-local hashed cue terms, categories, priority, lifecycle flags, safe typed identities, source-order ranges, child ranges, current-state flags, and counts. It contains no protected exact text, complete source, tool arguments, or tool output. Hashed terms are private derived data.

The deterministic query starts at the root, scores child summaries, and descends only selected paths. Defaults limit work to 64 nodes, 8 MiB of node bytes, and 512 returned records. It can recover old evidence omitted from the root by a later retention hint, resource identity, task identity, or unresolved-failure identity. Results are deduplicated and ordered by numeric source order.

## Typed renderer and final validator

The renderer builds typed lines for current work, recent events, selected older evidence, and the archive map. `recentSourceTokens` controls recent leaf loading. Older evidence uses the bounded tree query. Numeric source order controls chronology.

Current restrictions have first priority. The renderer reads exact restriction source when it fits. Otherwise, it keeps one complete subject-specific recovery cue or a complete archive recovery range. It never cuts a line or source-link suffix. Under hard pressure, routine older evidence and routine recent evidence drop before current restrictions, conflicts, blockers, unresolved failures, next actions, current resources, and the omission map.

Quality metrics use final included lines only. They report restriction, blocker, failure, task, goal, decision, resource, recent-source, and archive coverage. They also report exact-source reads, node reads, query work, invalid references and ranges, cut lines, missing routes, false completion, unsupported facts, source-order defects, duplicates, token state, render time, and timer delay.

The final validator checks the typed final plan. Exact lines must match bounded exact source reads. Lossy lines need valid references or ranges and recovery routes. Identifiers, quotations, numbers, lifecycle words, derived labels, order, duplicates, complete lines, and the unchanged 25,000-token hard limit are checked with safe issue codes.

## Shadow boundary

The shadow path is documented in [rollup-shadow.md](rollup-shadow.md). It uses this store only after current replay creation. Shadow output is hashed and discarded. Only aggregate metrics and complete local hashes can enter the shadow sidecar.

## Failure and recovery

A missing or corrupt V2 manifest leaves current replay unchanged. A corrupt node fails closed. A busy store can use the last complete matching manifest. Delete the V2 derived directory to rebuild it. V1 data remains untouched.

## Public benchmark

Build first. `scripts/benchmark-history-rollups.mjs` supports `series`, `render`, `scale`, `metadata`, `query`, `restrictions`, `branch`, and `compare`. It accepts synthetic input only. Large runs use low CPU and I/O priority. Reports omit hashed query terms and source text.
