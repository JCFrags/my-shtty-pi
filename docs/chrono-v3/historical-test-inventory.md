# Historical test inventory

## Source and disposition

- **Source commit:** `9a4d25a46f329bd91828a22a925e5de81c71eee4`
- **Former location:** `packages/chrono-compact/test`
- **Current location:** `packages/pi-chrono-compaction/test`
- **Retained files:** 55
- **Runnable files:** 54
- **Explicitly excluded:** `incremental-context.test.ts`

The excluded test is retained as a compatibility boundary. The selected current source tree does not contain its former `src/incremental-context.ts` module, so the test is excluded from both test TypeScript projects rather than recreated with replacement runtime behavior.

## Support inventory

The restored test support includes the test-only compatibility barrel, temporary synthetic-data helpers, historical package documentation required by tests, and benchmark helpers. These files are test support, not deployed entrypoints or runtime source. Generated `dist-test/` output is ignored and is not a publication artifact.

## Verification

`npm run test` passed the restored ChronoCompact suite with 294/294 tests. R1 adds 5 baseline-verifier tests and 25 privacy-verifier tests; the combined correction suite passed 30/30. Tests do not open or depend on the affected live session. Timing, memory, and source-boundary details remain aggregate and owner-only.
