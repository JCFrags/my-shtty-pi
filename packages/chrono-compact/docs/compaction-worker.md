# Isolated local compaction worker

## Status and boundary

The isolated worker is default-off. Set `PI_CHRONO_ISOLATED_WORKER=true` or enable it in the ChronoCompact settings screen. The existing in-process path remains unchanged when this setting is off. The experimental model-based history classifier also keeps the in-process path because the worker cannot call a model.

The worker processes retrospective history only. It does not intercept or change a tool result before the main model receives it. Pi JSONL remains authoritative. Worker replay caches, source ledgers, candidate segments, scheduler files, and responses are derived data.

## Process model

One local child process accepts one version 1 job and exits. There is no daemon and no worker thread. The child reads the persisted session JSONL. It reconstructs the parent chain for the exact requested leaf. It verifies that the selected cut exists on that chain. It compacts only the prefix before the cut and uses the retained future entries only for retrospective analysis.

The child can perform these deterministic tasks:

- exact branch and cut reconstruction;
- candidate-segment snapshot loading;
- replay compaction and final validation;
- complete replay generation hashing;
- deterministic regular-summary rebase;
- worker-specific replay cache reads and writes; and
- candidate-store updates.

A provider-backed regular Pi summary stays in the main Pi process. The worker never receives a model client. It does not import a network client. Runtime responses report zero model and network calls.

## Host-wide scheduler

All replay and candidate-update jobs use one owner-only scheduler directory in the operating system temporary directory. The directory name contains a protocol version and a hash of the local user ID. It does not contain a project path, session path, source ID, or source text.

The setting `PI_CHRONO_HOST_WORKER_SLOTS` accepts 1 through 4 and defaults to 1. Replay tickets have high priority. Candidate-update tickets have low priority. A waiting replay runs before waiting updates when a slot becomes available. Active update work is not terminated.

Waiting uses an asynchronous timer. It does not busy-loop. Cancellation and timeout remove the caller's ticket. A slot owner record contains only a PID, Linux process-start identity, random nonce, timestamp, priority, and job type. Linux recovery removes an owner only when both the PID and `/proc/<pid>/stat` start identity prove that the recorded process is not the live owner. Age alone never proves death. Release checks the random nonce before it removes a slot.

## Source stability and failures

The request binds the source device, inode, size, and modification time. The worker checks this identity before and after loading. It checks it again after replay or candidate publication. A changing load gets one bounded retry and then returns `source-changed`.

The IPC request and response have strict fields, bounded text, and an 8 MiB complete-response limit. Unknown fields, wrong job types, invalid values, unexpected payloads, and malformed metrics are rejected. A response never includes a source path, raw exception, stack trace, or child stderr. Safe failure codes include branch, cut, source, scheduler, timeout, abort, crash, protocol, response-size, candidate-store, and validation failures.

The child receives only `PATH`, `HOME`, temporary-directory variables, locale variables, and time zone. Common API keys, access tokens, cloud credentials, email credentials, Git credentials, provider credentials, and the rest of the parent environment are not inherited. Nice level defaults to 10 and accepts 0 through 19. A priority permission failure is nonfatal. The client kills the child on cancellation or timeout. The child exits when its parent IPC connection closes.

A failure after worker work starts does not immediately repeat heavy replay in the Pi process. The extension returns control to Pi's normal compaction fallback. Candidate-update failure keeps the last complete candidate manifest.

## Cache and candidate behavior

Worker replay caching is separate from the old main-process combined-summary cache. The key includes deterministic source and configuration state. The cache is owner-only and is never authoritative. A miss or damaged cache runs normal deterministic replay. On worker success, the main process uses the generation hash returned by the worker and does not call `compactEntries` or calculate the complete replay generation hash.

When both isolated work and segmented candidate preprocessing are enabled, background candidate updates are low-priority child jobs. Replay reads the last complete immutable manifest. It never waits for a writer. Candidate absence, damage, or staleness uses cold computation.

## Settings

| Setting | Default | Range or meaning |
| --- | ---: | --- |
| `PI_CHRONO_ISOLATED_WORKER` | `false` | Enable one-job local child processes. |
| `PI_CHRONO_HOST_WORKER_SLOTS` | `1` | Host-wide simultaneous ChronoCompact CPU jobs, 1–4. |
| `PI_CHRONO_WORKER_TIMEOUT_SECONDS` | `900` | Queue and worker timeout, 30–3,600 seconds. |
| `PI_CHRONO_WORKER_NICE` | `10` | Child nice level, 0–19. |

The persistent command keys are `isolated-worker`, `worker-slots`, `worker-timeout`, and `worker-nice`.

## Benchmark

Run public synthetic checks after `npm run build`:

```bash
node scripts/benchmark-compaction-worker.mjs --mode compare --tasks 5000
node scripts/benchmark-compaction-worker.mjs --mode queue --slots 1 --jobs 5
node scripts/benchmark-compaction-worker.mjs --mode update --tasks 5000
node scripts/benchmark-compaction-worker.mjs --mode generations --tasks 5000 --generations 5
```

The tool accepts only generated synthetic sessions. It has no private discovery or fixture option. `compare` reports exact output equality, wall time, main-process timer delay, response bytes, peak worker RSS, and zero model or network calls. `queue` reports the measured maximum active slot count and final artifact counts.

Isolation moves deterministic CPU work out of Pi. It does not reduce total parsing, resource lineage, causal analysis, planning, validation, or candidate work. One slot limits simultaneous memory and CPU pressure. More slots can reduce queue delay but can increase host pressure.
