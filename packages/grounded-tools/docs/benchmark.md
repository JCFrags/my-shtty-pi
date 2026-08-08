# Correctness benchmark plan

Grounded Tools is evaluated on completed-task quality rather than output compression ratio.

## Metrics

For each task and tool configuration record:

1. First-attempt task success under the repository's acceptance tests.
2. Incorrect, ambiguous, stale, or partially applied mutations.
3. Tool retries and rereads before completion.
4. Total model input/output tokens for the completed task.
5. Wall-clock completion time.
6. Tests introduced, fixed, or broken.
7. Every instance where capped evidence had to be recovered from an artifact or cursor.
8. Process/LSP failures and leaked child processes.

## Comparison

Run paired trials with the same Pi version, model, reasoning level, repository commit, prompt, and clean dependency cache:

- Pi built-ins
- Grounded Tools additive trial mode
- Grounded Tools replacement mode

Randomize ordering and repeat tasks. Do not compare against lossy summarization tools as if fewer visible tokens alone implied a better result. Report confidence intervals and retain raw session JSONL, test logs, tool artifacts, and final diffs.

## Task set

Include at least:

- repeated-text and concurrently changed files
- BOM, CRLF, symlink, hard-link, and permission cases
- large-file reads requiring continuation or artifact recovery
- exhaustive search with more than one page
- syntax-invalid candidate edits
- multi-file rename preview and post-edit diagnostics
- long-running, interactive PTY, timeout, and interrupt commands
- branch/fork task restoration and malformed task operations
- structured questions in TUI, RPC, and headless modes

## Success criterion

A release candidate must not silently omit evidence or mutate on a failed precondition. It should improve or preserve first-attempt success and broken-test count without materially worsening median completed-task tokens or wall time. Results must distinguish visible-output caps from irreversible evidence loss.

No benchmark results are claimed in this repository until the full paired protocol is run; unit and smoke-test results are verification, not task-performance evidence.
