# ChronoCompact explicit session-set benchmark

## Status

This is a personal-project benchmark. It is not release approval. Results are advisory.

## Purpose

The benchmark measures ChronoCompact and the source ledger against explicit, read-only Pi session files. ChronoCompact remains retrospective only. No tool result changes before the main LLM receives it.

## Privacy boundary

The tool reports anonymous fixture IDs and aggregate numbers. It excludes source paths, file names, session IDs, source hashes, source references, text, arguments, commands, and recovered content. Anonymous IDs have no persistent path mapping. Private manifests, reports, snapshots, diagnostics, and profiles must not be committed.

## Manifest

The command requires one explicit JSON manifest:

```json
{
  "schemaVersion": 1,
  "sessions": ["/explicit/session.jsonl"]
}
```

The tool never discovers sessions. The manifest and each source must be a regular non-symbolic-link file. Duplicate resolved paths are rejected.

## Selection

Files at or above the minimum size are selected first. When this does not meet the minimum count, the largest remaining files are added. The final set is sorted by size and limited by the maximum file count. Fixture IDs are assigned after sorting.

## Measurements

Each full fixture runs in a separate child process. Measurements cover source and active-branch size, compaction, search indexing, timer delay, peak memory, validation, protected visibility, current-state source linkage, lossy source links, exact recovery, and source-ledger behavior. Fixed searches report counts only. Timer delay is a process-level probe, not complete Pi UI latency.

## Safety gates

A stable owner-only temporary snapshot is created for each fixture. Real source files remain read-only. Full compaction requires an estimated working set within the source-size, available-memory, and physical-memory gates. Source-ledger checks can still run when full compaction is skipped. Serial work stops starting new children after the total time limit. A child is killed only after its per-session timeout.

## Output

The parent writes one owner-only JSON report outside the repository and prints the same redacted object. It includes aggregate counts, numeric distributions, and anonymous fixture rows. Failure messages are mapped to bounded categories. Child standard error is not included.

## Current limits

The benchmark trusts only its explicit manifest and does not provide discovery. Snapshot stability uses file identity, size, and modification time with one retry. The working-set gate is conservative but does not reserve memory. Private results need a separate privacy review before sharing. The source ledger remains disconnected from normal compaction.
