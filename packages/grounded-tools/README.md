# pi-grounded-tools

Evidence-first tools for [Pi](https://pi.dev): exact reads and search, strict atomic edits, persistent processes, lightweight LSP support, structured questions, branch-aware tasks, explicit scratchpad notes, and detailed workplans.

Grounded Tools never summarizes or semantically filters tool evidence. When a visible result must be capped, it emits an explicit marker and a path to the complete bytes/output.

## Packages

| Package | Tools | Purpose |
|---|---|---|
| `@grounded/pi-files` | `read`, `edit`, `write`, `grep`, `find`, `fuzzy_find` | Full-fidelity files, strict mutations, deterministic search |
| `@grounded/pi-process` | `bash`, `process` | Exact logs, yielding/background work, stdin, PTY |
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
- `rg` and `fd` for `grep`, `find`, and `fuzzy_find`
- Python 3 only when `pty: true` is requested
- `pdfinfo` and `pdftotext` only for `read mode=pdf_structure`
- language-server binaries only for the corresponding LSP languages

### Additive trial mode

To compare replacement tools with Pi's built-ins, start Pi with:

```bash
GROUNDED_TRIAL_MODE=1 pi
```

The replacement names become `grounded_read`, `grounded_edit`, `grounded_write`, `grounded_grep`, `grounded_find`, `grounded_bash`, and `grounded_process`. Unique tools retain their normal names.

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

`grep` and `find` keep source ordering and use exact cursor offsets. If a page omits later results, the response gives both the next cursor and a complete-output artifact. `fuzzy_find` is explicitly exploratory and reports ranking scores and Git-change boosts.

## Processes

`bash` waits by default. Set `yieldMs` to return if it is still running, or `background=true` to return immediately. The `process` tool supports `list`, `poll`, `input`, `interrupt`, and `kill`.

Every stream is written byte-for-byte to a mode-`0600` log under the system temporary directory. Visible caps never replace that log. PTY mode uses the bundled Python bridge. Timeouts send `SIGTERM` and escalate to `SIGKILL` after one second.

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

`todo` keeps one in-progress task, validates dependencies and cycles, and stores snapshots in Pi's session tree. Restoring or forking a branch restores that branch's task list. No project file or database is created.

`notes` stores only explicit scratchpad mutations in the active session tree. It is not memory, trusted facts, or instruction storage. It does not capture, embed, rank semantically, import, or inject note prose automatically.

`workplan` stores detailed objectives, milestones, criteria, decisions, risks, questions, checkpoints, evidence, and revisions. Milestones do not replace or synchronize with `todo`. Todo IDs are inert, unverified references.

Workplan has no direct file export or import. Use `workplan(read)` and then call the separate reviewed `write` tool when explicit file output is required. Large state reads can create helper-selected private temporary output artifacts. State tools cannot import those artifacts or select their paths.

## Privacy and security

There is no telemetry, network client, or postinstall script. Do not store passwords, API keys, tokens, cookies, private keys, authentication headers, or secret environment values in notes or workplans. State text is stored in Pi session JSONL and requested reads are model-visible. See [docs/security.md](docs/security.md) for executable trust, artifacts, state text, symlinks, and process boundaries.

## Development

```bash
npm install --ignore-scripts
npm run check
```

Tests cover exact/anchored edits, stale rejection, BOM/CRLF/modes, symlinks/hard links, search pagination, process logs/PTY/timeouts, LSP framing, RPC dialog responses, task transactions/cycles, package manifests, and spill artifacts. Benchmark methodology is in [docs/benchmark.md](docs/benchmark.md).
