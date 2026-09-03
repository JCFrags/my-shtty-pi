# Historical test recovery

The historical ChronoCompact tests were restored from commit `9a4d25a46f329bd91828a22a925e5de81c71eee4`, from the former `packages/chrono-compact/test` path into the current `packages/pi-chrono-compaction/test` path.

- 55 historical test files are retained.
- 54 files are in the runnable test project.
- `incremental-context.test.ts` is retained as a documented compatibility boundary but excluded from `tsconfig.test.json` and `tsconfig.test-build.json` because the selected current source tree does not contain `src/incremental-context.ts`.
- Historical package documentation and benchmark helpers needed by the suite were restored under the package's `docs/` and `scripts/` test-support directories.
- `test/support/index.ts` is a test-only compatibility barrel. It is not part of the deployed entrypoint or package runtime graph.
- `npm run test` builds to ignored `dist-test/` and runs the 54-file suite against temporary synthetic data.

The selected affected session is never used by these tests. Test outputs must remain aggregate and private when they include timing, memory, or source-boundary details. R1 adds only root-verifier tests and privacy fixtures; it does not restore the excluded runtime module or alter deployed ChronoCompact files.
