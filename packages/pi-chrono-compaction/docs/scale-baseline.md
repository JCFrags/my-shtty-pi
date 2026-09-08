# ChronoCompact scale baseline

## Selected-branch analysis phase measurement

A temporary synthetic probe measured the linear analysis that the prototype targets. The 5,000-task branch had 15,501 entries and an estimated 2,644,043 tokens. Historical-block parsing took 132.1 ms, resource lineage took 599.7 ms, causal memory took 843.7 ms, and complete current replay took 5.43 s. Peak RSS was 655,352 KiB. A separate approximately 5-million-token branch with one large entry took 65.3 ms for block parsing, 2.4 ms for lineage, 10.9 ms for causal memory, and 498.8 ms for replay. Peak RSS was 741,728 KiB. This temporary instrumentation was not committed.

## Hierarchical history rollup prototype

A separate public synthetic run measured the isolated history rollup prototype. It used 50 append batches, a 20,000-token render target, `nice -n 10`, and idle I/O priority. The scale mode used 128 KiB source leaves after initial measurement showed that smaller leaves reduce changed-path node work for these batch sizes. Production defaults remain 4 MiB.

| Source tokens | Leaves | Tree levels | Store | Total update | Final append | Node work amplification | Render | Render source read | Render node read | Peak RSS | Max timer delay |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000,000 | 31 | 2 | 4.81 MiB | 320.7 ms | 4.3 ms | 4.69 | 2.1 ms | 15.8 KiB | 91.0 KiB | 195.9 MiB | 1.5 ms |
| 5,000,000 | 151 | 3 | 6.22 MiB | 614.2 ms | 11.5 ms | 1.99 | 4.1 ms | 15.8 KiB | 96.5 KiB | 252.6 MiB | 1.9 ms |
| 25,000,000 | 781 | 4 | 12.37 MiB | 1.61 s | 37.1 ms | 1.23 | 2.7 ms | 15.8 KiB | 91.0 KiB | 363.9 MiB | 2.3 ms |
| 50,000,000 | 1,563 | 4 | 20.05 MiB | 2.99 s | 65.4 ms | 1.13 | 3.4 ms | 15.8 KiB | 92.8 KiB | 396.4 MiB | 3.4 ms |

All four runs had source-read amplification 1.00 and block-parse amplification 1.00. Every render had complete restriction, blocker, unresolved-failure, and current-resource coverage. Each run reported zero invalid references, cut lines, false completions, and unsupported facts. Every lossy record had recovery. The 5-million-token and larger trees met the node-work target after hierarchical levels were established.

The 5,000-task series used 50 batches. It read 13,732,207 exact branch bytes once, parsed each of 15,501 entries once, created 202 leaves and 31 rollup nodes, and had node-work amplification 1.77. The final append took 84.3 ms. The store used 59.0 MiB.

The 5,000-task comparator measured current replay at 5.48 s and 24,978 tokens. Prototype build took 1.32 s. Warm render took 13.9 ms and produced 11,408 tokens. The measured rollup resident set was 379.7 MiB. Both paths retained complete restriction and unresolved-failure coverage, valid recovery, zero false completions, and zero cut lines.

The 5,000-task branch probe reused 60 common leaves and seven common rollup nodes. It created 74 divergent nodes, switched in 1.77 s, rendered zero abandoned-branch records, and passed output integrity.

## V2 hardening gate

A later public synthetic gate measured the hardened V2 store. Normal cases ran three times. Scale and metadata cases ran once with low CPU and idle I/O priority.

| Case | Result |
| --- | --- |
| 1,000 / 5,000 / 10,000 task series | Integrity passed in all nine runs. Median final append was 23.3 / 88.1 / 187.5 ms. |
| 1,000 / 5,000 / 10,000 task render | Integrity passed. Median render was 6.4 / 26.8 / 53.2 ms. |
| 5-million / 50-million token dynamic query | The omitted target was found and rendered in all six runs. Query work stayed at 64 nodes. |
| 100,000 / 1,000,000 entry metadata | Integrity passed. Old leaf digest checks and node-directory scans were zero. |
| 5,000 + 5,000 + 5,000 branch | All three runs excluded abandoned records. Median switch time was 4.01 s. |

The 50-million-token scale case had a 101.4 ms final append, 11.4 ms render, 31.6 KiB render source read, 430.6 KiB render node read, 64 query nodes, 408.6 MiB peak RSS, 3.8 ms timer delay, 1.17 changed-path node amplification, and valid integrity. It met the stated pre-shadow targets. Exact hits wrote no files. Same-branch appends checked no old leaf digests and scanned no node-directory entries.

Restriction pressure was rerun after final aggregate-count correction. Both 100 and 1,000 current-restriction cases had final cue coverage 1.0, zero restrictions without a specific route, zero cut lines, and valid final-plan validation.

## Rollup shadow evaluation

The default-off public shadow benchmark uses a local low-priority child. Compare mode verifies that scheduling does not change current replay bytes. Generation mode records only bounded metrics and complete local hashes. Pressure mode skips current full replay and measures the V2 shadow path only. The sidecar contains no output or source text.

| Case | Median current replay | Median rollup update | Median rollup render | Result |
| --- | ---: | ---: | ---: | --- |
| Compare, 1,000 tasks | 699.1 ms | 319.5 ms | 37.5 ms | All three runs kept current output unchanged and passed integrity. |
| Compare, 5,000 tasks | 5.21 s | 1.37 s | 70.8 ms | All three runs kept current output unchanged and passed integrity. |
| Compare, 10,000 tasks | 15.43 s | 2.73 s | 35.4 ms | All three runs kept current output unchanged and passed integrity. |
| 50 generations, 1,000 final tasks | 14.69 s total | 2.54 s total | 1.77 s total | All 150 jobs passed final validation. Median maximum main timer delay was 0.87 ms. |
| 20 generations, 5,000 final tasks | 41.44 s total | 3.23 s total | 707.1 ms total | All 60 jobs passed final validation. Median maximum main timer delay was 0.67 ms. |

The 5-million-token, 100-restriction pressure case produced 4,014 tokens. The 50-million-token, 1,000-restriction case produced 20,808 tokens. Both had complete restriction, blocker, unresolved-failure, and current-resource coverage. Both had zero invalid references, cut lines, false completions, unsupported facts, missing recovery routes, model calls, and network calls. All compare and generation runs had the same zero-defect quality totals. The public failure case covered all 15 stages and all 22 safe codes. It found zero unexpected unknown failures, raw errors, stack traces, paths, IDs, references, output text, model calls, or network calls. See [rollup-shadow.md](rollup-shadow.md).

## Background value-worker gate

The default-off value worker used an offline fake model through the production call seam. Each series and advisory size ran three times. No provider or network call occurred. The table reports median times. Other listed values were stable.

| Tasks / candidate batches | Advice files | Provider attempts | Input tokens | Output tokens | Total update | Exact hit | Work amplification | Store bytes | Peak RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 / 10 | 10 | 30 | 110,726 | 13,230 | 38.85 ms | 0.11 ms | 1.00 | 95,200 | 97,628 KiB |
| 5,000 / 50 | 50 | 150 | 554,636 | 66,150 | 159.89 ms | 0.15 ms | 1.00 | 472,499 | 110,180 KiB |
| 10,000 / 100 | 100 | 300 | 1,109,541 | 132,300 | 342.56 ms | 0.22 ms | 1.00 | 944,215 | 144,124 KiB |

Every exact-hit run made zero calls and rewrote no advice. The 1,000, 5,000, and 10,000-item advisory runs changed 217, 1,083, and 2,167 eligible scores. They rejected 25, 125, and 250 protected changes and 8, 42, and 83 unresolved-failure changes. All nine advisory runs kept exact shadow equality, complete protected and failure coverage, valid exact recovery, zero false completions, and zero validation errors. Advisory validation used real deterministic compaction after the fake-model orchestration.

The failure mode passed 18 safe cases. These included model resolution, authentication, thinking support, structured retry failures, repair, hard budgets, unknown pricing, open and half-open circuit state, cancellation, advice-store contention, and advice-file corruption. The 1,000-segment budget run permitted three calls, blocked the fourth, kept the circuit closed, and reused exact advice without another call. These results test offline implementation behavior. They do not measure real-provider advice quality.

## Status

This is an advisory baseline for a personal project. It measured commit `62dc53e279a3897d88bda615f6561794590c1017`. The results are not a release decision.

## Environment

- Operating system: Fedora Linux
- CPU: 13th Gen Intel Core i7-13700K
- Logical CPUs: 24
- Total memory: 31.1 GiB
- Node: v24.18.0
- npm: 11.16.0

## Method

The existing deterministic public synthetic generator in `scripts/benchmark-v2.mjs` produced the input. Each size ran three times. All runs were serial. No run reached the two-minute stop threshold.

The table reports the median of three runs for compaction time, search-index build time, elapsed wall time, and maximum resident memory. Other values were stable across the three runs at each size. The benchmark token count uses the current deterministic estimator.

One separate Node CPU profile covered compaction only for 1,000 synthetic tasks. It did not build the search index. The profile run reported 528,043 source tokens, 24,988 rendered tokens, and 5,253.5 ms of compaction time.

## Results

| Tasks | Runs | Records | Blocks | Source tokens | Rendered tokens | Reduction | Median compaction | Median index | Median wall | Median max RSS | Protected fact rate | False completion | Exact recovery | Validation warnings |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 3 | 776 | 776 | 132,042 | 10,600 | 91.97% | 421.4 ms | 66.1 ms | 1.02 s | 293,352 KiB | 75% | 0 | 100% | 1 |
| 500 | 3 | 1,551 | 1,551 | 264,042 | 19,393 | 92.66% | 1,389.0 ms | 131.7 ms | 2.11 s | 312,876 KiB | 75% | 0 | 100% | 2 |
| 1,000 | 3 | 3,101 | 3,101 | 528,043 | 24,988 | 95.27% | 5,003.4 ms | 258.3 ms | 6.05 s | 367,160 KiB | 0% | 0 | 100% | 2 |

## Compaction profile

The Node profile labels several optimized callbacks as anonymous. The labels below identify them by their owning project function and source location. Percentages are self ticks as a share of all profile ticks.

1. `candidateIssues` unresolved-source inner reference scan, `src/validate.ts`: 5.3%.
2. `candidateIssues` failed-source inner reference scan, `src/validate.ts`: 4.9%.
3. `candidateIssues` unresolved-source outer block scan, `src/validate.ts`: 2.1%.
4. `sourceTextForCandidate` block lookup callback, `src/validate.ts`: 1.7%.
5. `candidateIssues` failed-source outer block scan, `src/validate.ts`: 1.6%.
6. `sourceTextForCandidate`, `src/validate.ts`: 0.9%.
7. Repeated-observation grouping callback, `src/repeated-observations.ts`: 0.6%.
8. Causal-memory callback, `src/causal-memory.ts`: 0.3%.
9. `candidateIssues`, excluding its separately reported callbacks, `src/validate.ts`: 0.1%.
10. Candidate-filter callback in validation, `src/validate.ts`: less than 0.1%.

The largest measured project-code self-time was in validation reference scans. No other individually linked project function had a material self-tick share in this profile.

## Direct conclusions

Measured compaction time, index time, wall time, and maximum resident memory increased with source size.

From 500 to 1,000 tasks, source tokens increased by about 2.00 times. Median compaction time increased by 3.60 times. Median index time increased by 1.96 times. Median wall time increased by 2.87 times. Median maximum resident memory increased by 1.17 times.

Median compaction time was larger than median index time at every measured size. The validation reference-scan callbacks had the largest measured project-code self-time in the compaction-only profile.

This baseline does not yet measure repeated compaction generations or concurrent Pi agents.

## Limits

The 1,000-task case contains about 528,000 source tokens. The generator is synthetic. The CPU profile represents one run. Exact provider token counts can differ from the current estimator.

These results do not prove behavior at 25 million or 50 million source tokens. They also do not establish how repeated generations or concurrent agents will change time or memory use.

## Current-state priority correction

The correction started from commit `bc80adf6341c23ac0246a370aaeb119e2f025b8f`. The diagnostic found that the four synthetic facts remained in parsed source and the causal model. The current-state renderer selected the first state cells in category and key order. Later routine cells displaced the active restriction and open-work line. The hard-cap step then removed their old chronological replay units. The unresolved failure was present in the causal model, but it had no current-state item and no pre-cap chronological replay text.

The corrected selector orders bounded state items by value. It places conflicts, restrictions, goals, open work, and bounded unresolved-failure cues before routine current state. Every selected item remains source-linked.

| Tasks | Runs | Source tokens | Rendered tokens | Protected fact rate | False completion | Exact recovery | Median compaction | Median index | Median wall | Median max RSS | Validation warnings |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 3 | 132,042 | 10,636 | 100% | 0 | 100% | 431.8 ms | 67.0 ms | 1.04 s | 292,492 KiB | 1 |
| 500 | 3 | 264,042 | 19,429 | 100% | 0 | 100% | 1,409.9 ms | 129.6 ms | 2.12 s | 314,052 KiB | 2 |
| 1,000 | 3 | 528,043 | 24,978 | 100% | 0 | 100% | 5,001.5 ms | 255.9 ms | 6.03 s | 366,340 KiB | 2 |

At 1,000 tasks, median compaction time was 0.04% lower than the 5,003.4 ms baseline. Median maximum resident memory was 0.22% lower than the 367,160 KiB baseline. These differences are within normal run variation.

This correction does not solve full-session processing cost. The original Results table remains the before-change baseline.

## Validation index correction

The validation index correction started from commit `40727e63c822f407104629e8dc86523d802ddf40`. Candidate validation previously searched the complete source block list for source text, unresolved state, and failure state for each candidate. Final tool-pair validation also filtered all planned units once for each source tool pair.

One immutable validation index now retains references to the existing blocks. It provides maps and sets for exact and entry-level source references, valid references, unresolved and failed entries, source order, and tool-pair state. The normal compaction path builds it once and reuses it for candidate pruning and final plan validation.

| Tasks | Runs | Source tokens | Rendered tokens | Protected fact rate | False completion | Exact recovery | Median compaction | Median index | Median wall | Median max RSS | Validation warnings |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 | 3 | 132,042 | 10,636 | 100% | 0 | 100% | 206.8 ms | 73.2 ms | 0.82 s | 292,124 KiB | 1 |
| 500 | 3 | 264,042 | 19,429 | 100% | 0 | 100% | 366.9 ms | 133.2 ms | 1.09 s | 316,388 KiB | 2 |
| 1,000 | 3 | 528,043 | 24,978 | 100% | 0 | 100% | 752.5 ms | 255.7 ms | 1.78 s | 363,220 KiB | 2 |

At 1,000 tasks, median compaction time decreased by 84.95%, from 5,001.5 ms to 752.5 ms. The 500-to-1,000-task compaction growth ratio changed from 3.55 to 2.05. Median maximum resident memory changed from 366,340 KiB to 363,220 KiB, a decrease of 0.85%.

One compaction-only 2,000-task run measured 1,057,043 source tokens, 24,985 rendered tokens, 1,762.6 ms compaction time, 2.30 s wall time, and 377,568 KiB maximum resident memory. Its protected-fact rate was 100%, and it had no validation errors.

All normal benchmark sizes retained 100% protected facts and exact recovery, with zero false completions and zero validation errors. This change does not remove other full-session processing. The original Results table remains the before-change baseline.

## Repeated-generation and concurrent-process baseline

The generation benchmark repeatedly compacts original synthetic prefixes. It does not use a prior rendered replay as source. Each row reports the median of three serial command runs.

| Generations | Final source tokens | Cumulative source tokens | Work amplification | Median total compaction | Median final compaction | Median peak RSS | Median maximum timer delay | Protected facts | False completion | Exact recovery | Validation errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 528,043 | 2,904,407 | 5.50 | 3,673.9 ms | 678.1 ms | 466,188 KiB | 678.7 ms | 100% | 0 | 100% | 0 |
| 25 | 528,043 | 6,865,001 | 13.00 | 8,565.7 ms | 698.0 ms | 516,960 KiB | 698.7 ms | 100% | 0 | 100% | 0 |
| 50 | 528,043 | 13,466,005 | 25.50 | 16,357.9 ms | 688.5 ms | 532,972 KiB | 689.1 ms | 100% | 0 | 100% | 0 |

The concurrent rows also report medians from three command runs. Summed peak RSS is the sum of child process peak values. It is not a measured host peak.

| Workers | Source tokens per worker | Median total wall | Median worker compaction | Median slowest worker | Median sum peak RSS | Median maximum timer delay | Protected facts | False completion | Validation errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 528,043 | 1,312.5 ms | 789.5 ms | 789.5 ms | 317,536 KiB | 789.8 ms | 100% | 0 | 0 |
| 2 | 528,043 | 1,344.7 ms | 799.0 ms | 811.3 ms | 636,248 KiB | 811.6 ms | 100% | 0 | 0 |
| 4 | 528,043 | 1,454.1 ms | 844.3 ms | 858.0 ms | 1,279,836 KiB | 858.4 ms | 100% | 0 | 0 |

| Tasks | Source tokens | Median compaction | Median wall | Median peak RSS | Median timer delay | Protected facts | False completion | Validation errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 528,043 | 790.3 ms | 1,226.5 ms | 317,540 KiB | 790.7 ms | 100% | 0 | 0 |
| 2,000 | 1,057,043 | 1,640.0 ms | 2,093.1 ms | 368,956 KiB | 1,640.4 ms | 100% | 0 | 0 |

Total compaction work increased from 3.67 seconds at 10 generations to 16.36 seconds at 50 generations as cumulative processed source increased from 2.90 million to 13.47 million estimated tokens. Final-generation time stayed between 678.1 and 698.0 ms for the same final source size.

From one to four workers, median command wall time increased from 1.31 to 1.45 seconds. The sum of child peak RSS increased from 317,536 KiB to 1,279,836 KiB. One compaction delayed its own process timer by about the measured compaction duration. This process-level probe is not a complete Pi UI latency measurement.

In the 2,000-task CPU profile, the largest project-linked JavaScript self-tick entries were a repeated-observation callback at 3.1%, a causal-memory callback at 1.8%, and `addRepeatedObservationCandidates` at 1.7%. No other linked project function reached 1% self ticks.

These measurements do not prove behavior at 25 million or 50 million source tokens. They do not measure a complete Pi UI process, and they do not propose a design correction.

## Source-ledger component baseline

These results measure the source ledger in isolation. Each row is the median of three serial command runs. Normal compaction is not incremental yet.

| Tasks / batches | Final source bytes | Estimated source tokens | Sidecar bytes | Initial build | Total append | Median append | Final append | Exact hit | Cold ledger load | Wall time | Maximum RSS | Source-read amplification | Exact-hit bytes read | Exact-retrieval bytes read | Integrity |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 1,000 / 10 | 2,739,773 | 684,944 | 1,416,491 | 7.8 ms | 26.1 ms | 2.8 ms | 2.8 ms | 0.12 ms | 13.0 ms | 0.57 s | 230,044 KiB | 1.0074 | 250 | 671 | yes |
| 2,000 / 20 | 5,485,422 | 1,371,356 | 2,843,467 | 5.4 ms | 57.6 ms | 3.0 ms | 3.1 ms | 0.12 ms | 29.9 ms | 0.64 s | 283,524 KiB | 1.0077 | 250 | 674 | yes |
| 5,000 / 50 | 13,720,922 | 3,430,231 | 7,134,881 | 6.2 ms | 162.1 ms | 2.9 ms | 2.5 ms | 0.10 ms | 58.9 ms | 0.82 s | 373,688 KiB | 1.0081 | 250 | 674 | yes |

All runs reported valid integrity. Warm updates read appended source bytes plus one bounded anchor. Exact hits read 250 source bytes. The three exact retrievals read only 671 to 674 source bytes in total. Source-read amplification remained between 1.0074 and 1.0081 as batch count increased from 10 to 50. Cold startup still read the complete sidecar.

## Large-entry source-ledger correction

The starting commit was `9f8845fd3eca48fc33014e142402467fabd8552d`. The prior parser concatenated the complete pending line with each 64 KiB chunk. The prior tail check read the complete final entry. The corrected parser joins retained chunk parts once per complete line. Checkpoints now store a fixed tail anchor of at most 1,024 bytes.

Each large-entry row reports the median of three serial runs.

| Requested content tokens | Source bytes | Large entry bytes | Sidecar bytes | Initial build | Exact hit | Small append | Cold ledger load | Exact retrieval | Wall time | Maximum RSS | Assembly bytes | Maximum line bytes | Exact-hit anchor | Append anchor | Appended bytes | Retrieval bytes | Integrity |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 250,000 | 1,000,327 | 1,000,166 | 2,665 | 7.9 ms | 0.19 ms | 0.41 ms | 0.34 ms | 1.89 ms | 0.51 s | 184,192 KiB | 1,000,166 | 1,000,166 | 1,024 | 1,024 | 103 | 1,000,166 | yes |
| 500,000 | 2,000,327 | 2,000,166 | 2,665 | 10.1 ms | 0.18 ms | 0.42 ms | 0.35 ms | 3.66 ms | 0.51 s | 195,656 KiB | 2,000,166 | 2,000,166 | 1,024 | 1,024 | 103 | 2,000,166 | yes |

One 5,000-task, 50-batch regression run reported 1.0036 source-read amplification, 1,024 exact-hit anchor bytes, and valid integrity. The prior recorded amplification was 1.0081. Exact retrieval read and verified the complete selected large entry. These results still measure the ledger in isolation. Normal compaction is not incremental yet.

## Candidate-segment component baseline

The immutable candidate segment store was measured on 2026-08-22. The source-ledger tables above remain the unchanged pre-store baseline. Each series and compare value below is the median of three serial runs.

| Tasks / batches | Source-read amplification | Block-parse amplification | Persistent work amplification | Total append | Final append | Exact hit | Store bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 / 10 | 1.0034 | 1.0000 | 1.0000 | 210.85 ms | 20.07 ms | 1.46 ms | 2,135,970 |
| 2,000 / 20 | 1.0035 | 1.0000 | 1.0000 | 418.06 ms | 22.45 ms | 1.73 ms | 4,283,440 |
| 5,000 / 50 | 1.0036 | 1.0000 | 1.0000 | 1,132.58 ms | 19.94 ms | 1.57 ms | 10,726,012 |

| Tasks | Cold compaction | Warm store | Reloaded store | Warm / cold |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 729.08 ms | 699.35 ms | 677.51 ms | 0.959 |
| 2,000 | 1,631.20 ms | 1,524.46 ms | 1,519.47 ms | 0.957 |
| 5,000 | 5,405.98 ms | 5,408.48 ms | 4,778.89 ms | 1.000 |

All nine compare runs matched summary bytes, plan selections, validation, generation hash, and rendered tokens. All warm ratios were within 15% of cold. One 25,000-entry run accepted all entries and produced 13 segments in a 17,251,387-byte store. Thus, the retired 20,000-entry and 16 MiB whole-checkpoint limits do not apply.

Candidate preprocessing is append-incremental. Full branch parsing, resource lineage, causal analysis, future-sensitive candidate computation, planning, and final validation remain non-incremental. Timing and memory remain environment-specific advisory measurements.

## Isolated local worker correction

A temporary phase probe on the 5,000-task synthetic case measured 14,286.3 ms main-process timer delay. It attributed 9,099.1 ms to JSONL branch preparation and 3,952.6 ms to `compactEntries`. The probe exposed repeated parent-chain cycle scans in JSONL assembly. Linear resolved-chain cycle validation replaced those repeated scans before the final worker comparison. Temporary timing code was then removed.

The default-off child-process path reconstructs the exact persisted branch and cut, performs deterministic replay and generation hashing, and returns a bounded response. The final three-run 5,000-task public comparison had these medians:

| Path | Wall time | Main-process maximum timer delay | Peak worker RSS | Complete response | Exact output |
| --- | ---: | ---: | ---: | ---: | --- |
| Existing in-process replay | 5,909.0 ms | 5,900.1 ms | not applicable | not applicable | reference |
| Isolated child replay | 5,935.5 ms | 0.6 ms | 521,864 KiB | 611,802 bytes | equivalent |

Worker wall overhead was 0.45%, below the 30% concern threshold. Worker main-process timer delay was below the 150 ms target. Queue checks reached exactly the configured 1, 2, and 4 active jobs and left no ticket or slot files. This correction moves deterministic work; it does not remove it. The original baseline tables remain historical results.

## Ledger-backed branch-load correction

On 2026-08-22, each public synthetic case ran three times serially. The table contains medians. Timing and RSS remain machine-specific.

| Active tasks | Abandoned tasks | Complete source | Exact active bytes | Ledger source read | Avoidance | Ledger cold load | Branch read |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 4,000 | 4,731,550 | 2,736,607 | 2,739,691 | 42.10% | 29.09 ms | 13.27 ms |
| 2,000 | 8,000 | 9,483,300 | 5,485,507 | 5,491,675 | 42.09% | 53.16 ms | 20.31 ms |
| 5,000 | 20,000 | 23,759,300 | 13,732,207 | 13,747,627 | 42.14% | 127.30 ms | 60.44 ms |

At 5,000 active tasks, coalescing read 0.11% above exact active bytes and no indexed abandoned entry body. The worker reference took 5,035.0 ms. The ledger worker took 5,683.6 ms, a 12.9% increase. Worker peak RSS changed from 593,332 KiB to 572,420 KiB. Main-process timer delay was 0.35 ms. Exact summary, generation hash, validation, plan sources, and branch JSON all matched.

| Linear tasks | Sidecar bytes | Bytes / source entry | Cold load | Old worker | Ledger worker | Change |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1,411,876 | 455.30 | 14.41 ms | 682.1 ms | 1,221.2 ms | +79.0% |
| 2,000 | 2,832,676 | 456.81 | 25.77 ms | 1,470.7 ms | 2,065.2 ms | +40.4% |
| 5,000 | 7,109,024 | 458.62 | 58.19 ms | 4,978.5 ms | 5,669.1 ms | +13.9% |

Small linear runs show material process-start and ledger overhead above 15%. The 5,000-task linear run remained below the 15% concern threshold. Retrieval produced exact equal text in 100 of 100 and 500 of 500 samples. The 500-sample case read about 249 KiB of selected ledger ranges after one cold ledger load. Cold sidecar loading remains linear and is not removed by this correction.
