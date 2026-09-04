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

Compaction outcomes are `ok`, `not-applicable-no-savings`, `rejected-hard-output-cap`, `rejected-structural-validation`, `rejected-factual-validation`, `runtime-failure`, `memory-gate`, `invalid-session`, or `timeout`. `no-net-savings` is not applicable because the candidate replay would not reduce the source. Structural and factual rejections include safe validation code counts. The report excludes validation messages, unit IDs, and source references.

Historical protected visibility measures all protected source blocks and separately groups exact duplicate instruction text. State-model restriction coverage measures exact values and source-link cues for restriction cells in the deterministic causal state model. This model is heuristic. It is not a perfect authority model. Final-plan relation counts distinguish plan representation, current-state coverage, and history-only recovery. Complete-line checks require every rendered state line to end with its complete source-link suffix.

## Safety gates

A stable owner-only temporary snapshot is created for each fixture. Real source files remain read-only. Full compaction requires an estimated working set within the source-size, available-memory, and physical-memory gates. Source-ledger checks can still run when full compaction is skipped. Serial work stops starting new children after the total time limit. A child is killed only after its per-session timeout.

## Output

The parent writes one owner-only JSON report outside the repository and prints the same redacted object. It includes aggregate counts, numeric distributions, and anonymous fixture rows. Failure messages are mapped to bounded categories. Child standard error is not included.

## Current limits

The benchmark trusts only its explicit manifest and does not provide discovery. Snapshot stability uses file identity, size, and modification time with one retry. The working-set gate is conservative but does not reserve memory. Historical protected visibility is an archival diagnostic and does not prove current restriction coverage. Private results need a separate privacy review before sharing. The source ledger remains disconnected from normal compaction.

## Isolated-worker private verification

The isolated-worker verification wrapper is private and uncommitted. It accepts only an explicit private path list. It does not discover sessions. It reads stable source identity before and after work, uses `nice -n 10` and `ionice -c3` where available, disables worker replay sidecars for real sources, and writes an aggregate owner-only report outside the repository. Committed documentation records no private path, session ID, source ID, hash, text, mapping, snapshot, ledger, store, or report.

The final read-only replay verification attempted 20 explicit private fixtures. All 20 worker runs succeeded and matched the in-process summary, generation hash, rendered count, plan source references, and validation result. All 20 original source identities remained stable. Worker main-process timer-delay p90 was 4.6 ms. The largest complete response was 1,621,317 bytes, and the largest child peak RSS was 1,103,212 KiB. The runs made zero model and network calls. The owner-only report remained outside Git.

Five isolated candidate-update checks used temporary stable branch snapshots because candidate stores are derived sidecars. All five succeeded. All five original sources remained unchanged. Maximum main-process timer delay was 1.2 ms. The checks made zero model and network calls and removed each temporary snapshot, ledger, store, cache, and scheduler directory.

Four explicit private replay fixtures also ran under scheduler limits 1, 2, and 4. Every group completed 4/4 jobs with zero model or network calls. Group wall times were 42.8, 29.2, and 17.9 seconds. Maximum main-process timer delays were 22.5, 13.2, and 10.9 ms. Every group ended with zero scheduler tickets and slots. Public scheduler instrumentation and automated tests separately confirmed that maximum active jobs equal, and never exceed, each configured limit.
