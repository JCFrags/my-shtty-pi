# M08/M09 adapter practical qualification

## Candidate and boundary

The qualified source candidate is `3cde8caf97b1ca48898dbf73d141d210f496649d`. Exact-head CI run `34586386020` passed before the practical run.

The harness used the candidate's actual `HistorySearchAdapter` and production host-wide worker admission with one slot. It exercised the public rollup repair methods and adapter composition selection against an owner-only synthetic 24-event source. It did not use an installed slash command, the normal compaction hook, a model continuation, or a provider.

## Bounded attempts and corrections

Four distinct harness revisions ran once each. No failed revision was retried unchanged.

1. The first harness, SHA-256 `96ee908a0967bbaf79fcc47ee4e438ddd7448099311d7ee66d5b3544112074e8`, stopped at `adapter-stage-timeout`. The capsule cursor reached event 15 of requested cut 24 with zero capsule failures. This demonstrated that the 12-second cold capsule deadline was too short.
2. The second harness, SHA-256 `382e7fff8367687e9bb3b440dc0d53d2b7974849b99f1ceaf6baeca6bf8cae1c`, used the accepted capsule-specific deadline and stopped at `index-stage-timeout`. Retained state showed capsule cut 22 and index cut 16. Source inspection then established that per-layer `ready` can describe a completed bounded prefix, not the final requested cut.
3. The third harness, SHA-256 `b3eb9fe75ede6387674c8164105b582b70fd36d487d2f936e1275a14bc424ed5`, replaced sequential stage deadlines with one fixed 100-second readiness deadline. It required requested, indexed, memory, and rollup cuts of 24 and validated the public final selection at that cut. It stopped after exact readiness because it incorrectly required aggregate `selection.complete`. That field was false only because bounded optional recent selection omitted at least one row. Body, metadata, restriction, and open-work coverage had no gap.
4. The fourth harness, SHA-256 `502b793cd35c0c061653840604b40309f90171cfbdc844b0cd6654ca3015169e`, removed only that aggregate assertion. It retained the four exact-cut checks and explicitly required complete body, metadata, restriction, open-work, and mandatory-category scans with no mandatory omission. This run passed.

The final harness kept one fixed 100-second readiness deadline across initial startup and adapter restart. The external command retained its 150-second limit. Other fixed bounds included 24 events, one worker slot, at most 32 explicit repair steps, a 30,000-token combined ceiling, and a 128 MiB post-run disk acceptance threshold.

## Passing result

The final run completed in 90,655 ms. It used 12 explicit repair steps and retained 3,166,777 bytes. The composed result used 2,212 tokens and contained one older rollup row and one mandatory row. Independent mandatory coverage passed. Provider calls were zero.

The passing assertions covered:

- exact readiness at requested, indexed, memory, and rollup cut 24;
- a partial repair step followed by adapter restart and resume;
- bounded repair completion and publication of the validated replacement;
- recovery through the legacy pinned handle after replacement publication;
- one actual older rollup selected before the recent cutoff;
- independent mandatory coverage and the combined-token ceiling; and
- unchanged source bytes by source-file hash.

The legacy recovery assertion called `HistorySearchAdapter.recallRollup(...)` with the previously returned expansion reference. It proves that the legacy handle remained usable through the adapter after publication. The harness did not call `history_get` or retrieve an exact raw-source range, so it does not claim exact raw-source recovery. The unchanged source hash is separate evidence that the repair and composition flow did not modify the synthetic source.

## Qualification limits

This is focused actual-adapter evidence. It is not an installed-command qualification, a normal compaction-hook run, a model-continuation run, or a full shadow/fault matrix. It does not by itself complete or accept M08 or M09. The retained owner-only roots permit separate inspection, but their locations, source text, and raw logs are not part of this report.
