# Historical test recovery

The historical ChronoCompact tests were restored from commit `9a4d25a46f329bd91828a22a925e5de81c71eee4`, from the former `packages/chrono-compact/test` path into the current `packages/pi-chrono-compaction/test` path.

- 55 historical test and fixture files are retained.
- 54 historical files are runnable.
- `incremental-context.test.ts` is retained as a documented compatibility boundary but excluded from `tsconfig.test.json` and `tsconfig.test-build.json` because the selected current source tree does not contain `src/incremental-context.ts`.
- Historical package documentation and benchmark helpers needed by the suite were restored under the package's `docs/` and `scripts/` test-support directories.
- `test/support/index.ts` is a test-only compatibility barrel. It is not part of the deployed entrypoint or package runtime graph.
- Generated `dist-test/` output is ignored and is not a publication artifact.

The complete per-file blob inventory is [`historical-test-inventory.md`](./historical-test-inventory.md). It includes both fixture files and the excluded compatibility test, with Git blob IDs and classifications.

## Verification boundary

`npm run test` builds to ignored `dist-test/` and runs the 54-file suite serially with `--test-concurrency=1` against temporary synthetic data; the recorded result is 294 passed, 0 failed, and 0 skipped. Serialization is test-harness containment only. It does not prove cross-agent runtime safety, fix the worker scheduler, or authorize runtime deployment. Targeted concurrent runtime regressions remain a later M01 scope.

The selected affected session is never used by these tests. Timing, memory, and source-boundary details remain aggregate and owner-only. The R2 worker timing changes use a bounded synthetic readiness marker and a cleanup-safe scheduler barrier; they do not change runtime source or compiled output.
