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
