# Security model

## Defaults

Grounded Tools contains no telemetry or network client and defines no lifecycle or install scripts. File tools read and mutate only paths requested through tools. Shell commands and language servers are explicit executable boundaries and inherit the Pi process environment. State tools use only the active Pi session tree and helper-selected private temporary output paths.

## Configuration trust

Language-server executable definitions are accepted only from the user's global Pi agent directory:

`~/.pi/agent/grounded-tools/lsp.json`

Project configuration is read only when Pi marks the project trusted. Its schema permits only `disabledServers` and a bounded `diagnosticTimeoutMs`; unknown fields cannot alter commands, arguments, initialization options, or executable paths. Thus project policy can narrow built-in/global behavior but cannot widen executable authority.

## File mutations

- Exact and anchored batches are validated before writing.
- Anchored changes require the complete normalized-file SHA-256 digest.
- Candidate syntax checks run against temporary files before commit.
- Same-directory temporary files use exclusive creation and mode `0600` for new targets.
- Existing mode and ownership are preserved where the OS permits.
- Symlinks are followed, including broken symlinks whose target is created.
- Hard-linked targets are intentionally written in place to preserve link identity; the tool reports `atomic: false` and `preservedHardLinks: true`.
- No fuzzy matching or hidden mutation fallback exists.

A signal arriving after an atomic commit begins does not turn a successful mutation into a reported failure.

## Output artifacts

Complete read, search, tool spill artifacts, and process logs are placed under the OS temporary directory. Process logs are created mode `0600`. Old process logs are removed at session startup after 24 hours by default. Notes and workplan spill directories use mode `0700`, and their `full-output.txt` files use mode `0600`, where POSIX mode bits exist. State spill paths contain no state text, entity ID, title, or query. State actions cannot select or import a spill path. Paths are returned explicitly so evidence is recoverable. Consumers must treat artifacts as potentially sensitive source, command output, or state text.

## Session state

Notes and workplans store explicit plain text in Pi session JSONL tool-result details. Requested tool reads are model-visible. Notes prose never enters automatic context. Workplan automatic context contains counts and IDs only. The packages do not scan for secrets because a heuristic scan can miss secrets and can change exact text.

Do not store passwords, API keys, tokens, cookies, private keys, authentication headers, secret environment values, or other credentials in notes or workplans. Notes is scratchpad state. It is not memory, trusted facts, or instruction storage.

The state packages do not read project control documents, organization documents, credentials, environment-secret files, or unrelated sessions. They add no automatic import, capture, embedding, semantic retrieval, database, watcher, subprocess, or network access. Workplan has no file export or import. Use a separate explicit `write` tool call under normal file authority when file output is required.

## Processes

`bash` executes the user's literal command through the configured shell. POSIX sessions use a detached process group so interrupt/termination reaches descendants. PTY mode invokes only the bundled bridge through `python3`. Requested timeouts escalate from `SIGTERM` to `SIGKILL`. No process is backgrounded unless `background` or `yieldMs` behavior is requested.

## Language servers

Servers are local processes started lazily. They can inspect their workspace and have whatever network behavior their own implementation provides; Grounded Tools does not add network access. Rename is preview-only. No formatting, code action, workspace edit, or server-requested command is applied.

## Dependency audit note

As of Pi `0.83.0`, `npm audit` reports GHSA-mh99-v99m-4gvg in `brace-expansion@5.0.7`, nested under Pi's `minimatch` dependency. Pi publishes an `npm-shrinkwrap.json`, so a consumer-level override does not replace that nested version. Grounded Tools does not call `minimatch` or `brace-expansion`; the advisory remains an upstream Pi development/runtime dependency and should be updated when Pi refreshes its shrinkwrap. The modular package manifests contain no lifecycle scripts.

## Reporting vulnerabilities

Do not include sensitive repository output or process logs in public reports. Provide a minimal reproduction and the Grounded Tools, Pi, Node.js, and OS versions.
