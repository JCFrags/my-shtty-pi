# ChronoCompact scale baseline

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
