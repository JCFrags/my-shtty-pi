# pi-grounded-tools

Evidence-first tools for [Pi](https://pi.dev): exact reads and search, strict atomic edits, persistent processes, lightweight LSP support, structured questions, branch-aware tasks, explicit scratchpad notes, and detailed workplans.

Grounded Tools never summarizes or semantically filters tool evidence. When a visible result must be capped, it emits an explicit marker and a path to the complete bytes/output.

## Packages

| Package | Tools | Purpose |
|---|---|---|
| `@grounded/pi-files` | `read`, `edit`, `write`, `local_search` | Full-fidelity files, strict mutations, and unified exact or fuzzy search |
| `@grounded/pi-process` | `bash`, `process`, `session` | Stateless commands, process control, and explicit persistent sessions |
| `@grounded/pi-lsp` | `lsp` | Diagnostics, hover, definition, references, rename preview |
| `@grounded/pi-dialog` | `ask_user_question` | Structured decisions with descriptions and previews |
| `@grounded/pi-tasks` | `todo` | Session-backed dependency-aware tactical actions |
| `@grounded/pi-notes` | `notes` | Explicit session-tree scratchpad state |
| `@grounded/pi-workplan` | `workplan` | Detailed milestones and execution specifications |
| `pi-grounded-tools` | all above | Umbrella package |

The internal `@grounded/pi-core` package contains shared primitives. Feature packages are independently publishable; dialog and tasks need not enlarge sessions that do not use them.

## Install

From this checkout:

```bash
pi install /absolute/path/to/pi-grounded-tools
```

After publication, install the umbrella or only selected modules:

```bash
pi install npm:pi-grounded-tools
pi install npm:@grounded/pi-files
pi install npm:@grounded/pi-process
```

Requirements:

- Node.js 22+
- `rg` and `fd` for `local_search`
- Python 3 only when `pty: true` is requested
- `pdfinfo` and `pdftotext` only for `read mode=pdf_structure`
- language-server binaries only for the corresponding LSP languages

### Additive trial mode

To compare replacement tools with Pi's built-ins, start Pi with:

```bash
GROUNDED_TRIAL_MODE=1 pi
```

The replacement names become `grounded_read`, `grounded_edit`, `grounded_write`, `grounded_bash`, and `grounded_process`. Unique tools, including `local_search` and `session`, retain their normal names.

## File behavior

### `read`

`mode=full` is the default and retains Pi's familiar `path`, `offset`, and `limit` inputs. Visible truncation includes a complete-file artifact containing the original bytes.

Explicit opt-in modes:

- `anchors`: line hashes plus a SHA-256 snapshot digest for stale-safe edits
- `outline`: declaration-oriented navigation view
- `symbol`: a small exact window around supplied symbol text
- `pdf_structure`: exact `pdfinfo` metadata and page-marked `pdftotext -layout` extraction

### `edit`

Normal edits use a familiar batch:

```json
{
  "path": "src/app.ts",
  "edits": [{ "oldText": "const old = 1;", "newText": "const next = 1;" }]
}
```

Every `oldText` must occur exactly once in the original snapshot. Batch ranges must not overlap. Anchored edits additionally require `expectedDigest`, `startAnchor`, `endAnchor`, and complete `contentLines`. There is no fuzzy relocation, autocorrection, or duplicate removal.

Mutations preserve BOM and dominant CRLF/LF style. Replacements use same-directory temp files and rename, preserve permissions, and follow symlinks. Existing hard-linked files are updated in place to preserve the link set; the result explicitly reports that this case is not atomic.

`GROUNDED_SYNTAX_GUARD` controls candidate syntax checks:

- `warn` (default): commit and report the exact parser warning
- `block`: reject invalid supported syntax before mutation
- `off`: do not block (checks may still be reported)

### Search

`local_search` is the sole model-facing local search tool. `strategy=text` uses ripgrep JSON and gives exhaustive evidence under its reported qualifications. `strategy=files` uses a NUL-delimited fd inventory and full relative-path or basename globs. `strategy=fuzzy` ranks likely file paths and never proves absence. An exact zero result or exact engine failure never invokes fuzzy search. See [`docs/local-search.md`](docs/local-search.md).

The former `grep`, `find`, and `fuzzy_find` registrations were removed. Their required behavior is available through the explicit `local_search` strategies. This removes duplicate engines and prevents the legacy names from drifting.

## Processes

`bash` waits by default. Set `yieldMs` to return if it is still running, or `background=true` to return immediately. The `process` tool supports `list`, `poll`, `input`, `interrupt`, and `kill`.

Every stream is written byte-for-byte to a mode-`0600` log under the system temporary directory. Visible caps never replace that log. PTY mode uses the bundled Python bridge. Timeouts send `SIGTERM` and escalate to `SIGKILL` after one second.

### Persistent sessions

`session` is an explicit stateful alternative to normal one-shot `bash`. The current source stage supports local non-PTY and PTY sessions. It also accepts a separately loaded Native SSH non-PTY provider. The `session` actions are `capabilities`, `open`, `list`, `status`, `input`, `interrupt`, and `close`. It permits four live sessions in one Pi runtime. The accepted Native SSH provider permits one live SSH handle. Shell environment, functions, and working directory persist inside a session. Pi's working directory never changes. Commands serialize per session. Non-PTY stdout and stderr stay separate. PTY output uses one merged terminal stream. Exact chunks remain in private logs.

The persistent PTY path needs Python 3. It uses a fixed 80-by-24 terminal and disables echo by default so submitted input is not copied into output logs by the initial terminal settings. `data` is literal UTF-8. `dataBase64` must use canonical padded base64. Exact input means exact bytes are written to the PTY. Terminal settings or an application can still transform those bytes.

`bash.sessionId` routes one serialized command through an explicit local or SSH session. Omit it for unchanged stateless behavior. A routed command rejects `cwd`, `background`, `yieldMs`, and `pty` because the open session owns those properties. Session timeout and Pi cancellation still apply. Routed results report the opaque session and request IDs, confirmed working directory, private exact log, and bounded visible output.

Optional `sessionId` on `read`, `edit`, `write`, and exact `local_search` uses the same session FIFO. Relative paths use the working directory captured when the operation reaches the front of the queue. Absolute paths remain absolute. Local sessions keep the Stage 4 direct-file behavior. An SSH session must expose file-resource protocol v1. Native SSH then transports bounded exact reads, digest-checked commits, and exact ripgrep/fd results while Grounded Files retains anchors, candidate construction, syntax checks, mutation serialization, rendering, and cursors. Remote PDF structure and fuzzy session search fail explicitly. No file tool creates a session or falls back to another provider.

Remote writes use a same-directory atomic replacement and keep one rollback sidecar compatible with Native SSH `ssh_transfer rollback`. Replacement can detach the target path from an existing hard-link set. Results disclose `hardLinksBefore`, `preservedHardLinks: false`, and `hardLinkTopologyRollback: false`; rollback restores bytes and mode, not link topology. The inactive Review UI adapter still fails closed for session-relative edit and write previews until that separately retained package has an accepted compatibility update.

Live handles are never stored in Pi session state. Reload, shutdown, session replacement, fork, and successful tree navigation close every owned session. The SSH provider and remote file-resource path remain source-only until deployment and a separately authorized disposable-host acceptance gate.

## LSP

Servers start lazily. Successful grounded `edit` and `write` calls receive same-turn error/warning diagnostics when a matching server exists. `rename_preview` returns the workspace edit but never applies it.

Default commands: `typescript-language-server`, `pyright-langserver`, `gopls`, `rust-analyzer`, and `clangd`.

Trusted global config at `~/.pi/agent/grounded-tools/lsp.json` may define executable commands:

```json
{
  "servers": [{
    "id": "typescript",
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensions": [".ts", ".tsx"],
    "languageId": "typescript",
    "rootMarkers": ["tsconfig.json", ".git"],
    "timeoutMs": 5000
  }]
}
```

A trusted project's `.pi/grounded-lsp.json` can only narrow behavior:

```json
{ "disabledServers": ["clangd"], "diagnosticTimeoutMs": 2000 }
```

Project config cannot supply commands, arguments, or executable paths.

## Dialog and tasks

`ask_user_question` accepts 1–4 questions with 2–4 options each. Stable values, descriptions, previews, and free-form responses are returned structurally. The tool deactivates when Pi has no UI; RPC uses Pi's extension UI protocol.

`todo` keeps one in-progress task, validates dependencies and cycles, and stores snapshots in Pi's session tree. A blocked task can name unfinished task IDs in `blockedBy`, an external condition in `waitReason`, or both. Set `waitReason` to an empty string to clear the external wait. Restoring or forking a branch restores that branch's task list. No project file or database is created. Use `/todos` for the full scrollable overlay. Use `/todos compact`, `/todos plan`, or `Ctrl+Shift+U` to select and save the persistent widget size.

`notes` stores only explicit scratchpad mutations in the active session tree. It is not memory, trusted facts, or instruction storage. It does not capture, embed, rank semantically, import, or inject note prose automatically.

`workplan` stores durable project objectives, boundaries, milestones, criteria, decisions, risks, questions, checkpoints, evidence, and revisions. Use `todo` for immediate executable actions. Workplan milestones do not replace or synchronize with `todo`. Todo IDs are inert, unverified references.

After compaction, session restore, branch change, or a plan mutation, the compact automatic context can require `workplan(recover)`. Recovery returns a bounded view of the current goal, constraints, checkpoint, current milestones, next actions, unresolved items, decisions, and verification. A checkpoint can record `currentFocus` and `nextActions`. Successful mutations return a human-readable plan summary and the complete changed record or section instead of an ID-only receipt. Draft and paused plans remain visible in prose-free automatic context. Use `workplan(read)` for the complete immutable plan and revision history. Completed and archived plans do not consume the 16-open-plan limit; a branch can retain at most 64 plans.

Workplan has no direct file export or import. Call the separate reviewed `write` tool when explicit file output is required. Large state reads can create helper-selected private temporary output artifacts. State tools cannot import those artifacts or select their paths.

## Privacy and security

There is no telemetry, network client, or postinstall script. Do not store passwords, API keys, tokens, cookies, private keys, authentication headers, or secret environment values in notes or workplans. State text is stored in Pi session JSONL and requested reads are model-visible. See [docs/security.md](docs/security.md) for executable trust, artifacts, state text, symlinks, and process boundaries.

## Development

```bash
npm install --ignore-scripts
npm run check
```

Package artifact boundaries and clean-load checks are documented in [docs/artifacts.md](docs/artifacts.md).

Tests cover exact/anchored edits, stale rejection, BOM/CRLF/modes, symlinks/hard links, search pagination, process logs/PTY/timeouts, LSP framing, RPC dialog responses, task transactions/cycles, package manifests, and spill artifacts. Benchmark methodology is in [docs/benchmark.md](docs/benchmark.md).
