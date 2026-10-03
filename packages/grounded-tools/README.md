# Grounded Tools

- Purpose: Provide evidence-first file, process, LSP, and dialog tools. The shared core also supplies native-state primitives to Context Kit.
- Status: active canonical
- Pi entrypoint(s): `files/index.ts`, `process/index.ts`, `lsp/index.ts`, `dialog/index.ts`
- Load form: source-loaded
- Current check command, from the repository root: `npm run verify -- --product grounded-tools`
- Historical deployment check, from the repository root: `npm run verify:history`
- Shared current-state contracts: Context Kit Todo publishes its existing version-1 summary with a bounded branch identity, and its existing `pi-todo:summary-changed-v1` envelope may carry the bounded snapshot used by the provider. That changed event is an invalidation for consumers, not an authoritative current-state payload. Workplan publishes `pi-workplan:request-summary-v1`, `pi-workplan:summary-v1`, `pi-workplan:summary-changed-v1`, and post-persistence `pi-workplan:activity-v1` (`checkpoint_recorded`, `milestone_completed`, and `plan_completed`). Workplan request IDs are echoed exactly; branch IDs are bounded opaque identifiers and are not whitespace-normalized. Project Glance consumes these events without importing grounded-tools implementation internals or mutating provider state.

## Install Files, Process, and LSP

Use the full retained checkout described in [installation](../../docs/installation.md).
Set `REPO` to its absolute path. Prepare the committed repository-root lock before
registering these source-loaded owners:

```sh
cd "$REPO"
npm ci --ignore-scripts --no-audit --no-fund
pi install "$REPO/packages/grounded-tools/files"
pi install "$REPO/packages/grounded-tools/process"
pi install "$REPO/packages/grounded-tools/lsp"
```

Run this preparation only in a new checkout, not an immutable root used by live
sessions. There is no lock under `packages/grounded-tools`. Root installation
creates the workspace `@grounded/pi-core` links and the Files/Process local
`pi-tool-controls` dependency. Keep the sibling core and presentation source, its
manifest, and the root dependency tree. Do not register the inactive Tool Controls
extension or add another owner for the same model tool. Local `pi install` does not
install dependencies, copy source, or build an entrypoint.

Search requires `rg` (ripgrep) and `fd` on `PATH`. Process requires an available
shell. Its POSIX pseudo-terminal paths also require `python3` on `PATH` and the
bundled `core/src/pty_bridge.py` and `core/src/session_pty_bridge.py` resources.
Keep those files beside their core modules. LSP starts servers lazily. Install only
the servers needed for the project, or configure their exact executable paths.
Defaults include `typescript-language-server --stdio`, `pyright-langserver
--stdio`, `gopls`, and `rust-analyzer`. A selected extension does not prove that a
server executable exists.

Global LSP overrides use `grounded-tools/lsp.json` under Pi's agent directory.
Trusted project settings use `.pi/grounded-lsp.json`. Automatic edit/write LSP
checks are off by default. Explicit LSP tools remain available. See
[LSP policy and diagnostics](#lsp-policy-and-diagnostics) for the independent
policy keys. A global custom server replaces the complete default server with the
same ID, so preserve or supply its document-language mapping explicitly.
See [LSP document languages](#lsp-document-languages).

Compare complete loader definitions and dependency routes before replacing existing
owners. Then exercise a harmless file read, finite command, and relevant LSP call
in a fresh session. Entry-point equality does not prove dependency equality. A
source selection or fresh check does not reload existing sessions. Grounded Process
terminates managed resources during reload, so settle jobs and preserve drafts first.

## Compact human tool display

Files and Process use the pure `pi-tool-controls/presentation` library for `read`, `edit`, `write`, `local_search`, `bash`, `process`, and `session`. This changes only terminal presentation. Tool schemas, model instructions, arguments, execution, and saved result content/details are unchanged. The inactive Tool Controls extension is not loaded.

Cards use the active theme's native pending, success, and tool-error backgrounds, without added padding rows or horizontal inset. Known warning/error text keeps its semantic foreground color. A nonzero command exit does not become a tool error just to change the background. File titles use a bold tool name, an accent-colored path, and semantic `[skill]`/name styling for the existing `SKILL.md` filename convention. The heading stays consistent in both views. These are theme styles, not a fixed palette or a separate font.

Collapsed cards use at most six text rows, including the call. An ordinary successful read uses one row. Expanded cards use at most ten text rows. Pi adds its own separator, and images remain separate. Width limits apply after wrapping. Known warnings, errors, partial output, running/cancelled states, and search qualifications take priority over excerpts. An explicit count identifies omitted notices when these do not all fit. A compact view cannot classify every warning in arbitrary shell output.

Read expansion uses saved text. A requested line limit remains visible even when a native read has no structured details. The display does not interpret arbitrary file prose as authoritative continuation metadata. A `SKILL.md` filename selects its returned description, path, and headings when available. This does not verify skill registration. Edit and write show saved diffs, not a new filesystem preview or the complete call content. Syntax and LSP notices remain visible. LSP information is the saved hook result, not proof of remote validation. Shell cards identify the command without displaying scripts or input. They show exit/status information, suppress ordinary successful stdout, and expose explicit diagnostics or a short failure tail. Process lists count supplied failed, cancelled, and unknown states before the ordered item excerpt, so a late failure is not hidden. Missing older details remain unknown.

Use `Ctrl+O` to expand or collapse tools. In Pi fullscreen mode, a left-click on a completed card toggles that card. Normal terminal mode does not provide this mouse behavior. Expansion is still a bounded preview, not full output.

### Inspect original saved evidence

`raw: /export NEW.jsonl` is a short cue, not a safe literal destination. `…` means that the preview omits evidence. Every expanded view and clipped result preview has this cue.

1. Choose a **new private path outside Git**. The export command can overwrite an existing file. Saved arguments/results can contain secrets or other sensitive data.
2. Enter `/export /new/private/path/evidence.jsonl` in Pi. Use a `.jsonl` suffix, not HTML.
3. Inspect the saved tool-call arguments and tool-result content/details in that file. The export covers the active branch and preserves payloads, but rewrites export headers and parent links. It is not a byte-for-byte session backup.

HTML export uses the same compact renderers, so it is not the raw route. An export preserves returned evidence, not source bytes omitted during execution. Follow a returned complete-output path when needed and still available. Process/session logs can expire, normally after 24 hours. Do not publish exports or private log paths.

## Native state ownership

The independent [Context Kit providers](../pi-context-kit/README.md) are the only supported current Todo, Notes, and Workplan registrations. Grounded core still supplies shared reducers, renderers, projectors, and checkpoint readers. It does not register another writer.

The old factories remain in [pre-retirement Git source](https://github.com/JCFrags/my-shtty-pi/tree/84bbb994ddda237f5df7a98cca30b1ed1f5ec2ed/packages/grounded-tools), not as current entrypoints. Preserve original sessions, native import readers, and compatible retained installations for recovery. Never load both writers for one native tool. Progressive Tools controls catalog visibility and schema exposure, not provider persistence.

## LSP document languages

Grounded LSP selects a server by its `extensions` list. When it first opens a document, an optional `languageIds` map selects the language by the lowercase file extension. An unmapped extension uses the required scalar `languageId`. Different document languages share the same server/root client.

The default TypeScript server uses these language fields:

```json
{
  "languageId": "typescript",
  "languageIds": {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript"
  }
}
```

Global server configuration is the `servers` array in `grounded-tools/lsp.json` under Pi's agent directory. A custom server replaces the complete default entry with the same `id`. Existing custom entries without `languageIds` keep their scalar language for all routed extensions. To use the mapping above, add it to the existing TypeScript server entry and preserve its other settings. Explicit map values take precedence over the scalar fallback, including intentional nonstandard language choices.

## LSP policy and diagnostics

The global LSP file accepts policy defaults beside its `servers` array. Trusted
`.pi/grounded-lsp.json` policy values override those defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `automaticDiagnostics` | `false` | Opt in to expensive LSP checks after successful edit/write tools. |
| `idleTimeoutMs` | `60000` | Non-Rust idle retention. Finite integers clamp to 1000–300000 ms. |
| `diagnosticTimeoutMs` | `3000` | Diagnostic publication wait. Finite integers clamp to 100–30000 ms. |

Invalid non-integer or non-finite budgets use the inherited/default value. There
is no unlimited idle budget. Trusted-project `disabledServers` still disables
both explicit and automatic use of each listed server. Server `timeoutMs` is a
separate initialize/navigation request budget, with a 5000 ms fallback.

When `automaticDiagnostics` is false, edit/write hooks do not inspect the file,
probe an executable, start a server, synchronize a warm document, or deliver LSP
diagnostics. This does not disable Files' separate cheap syntax checker. When
true, Rust still requires explicit startup and its separate reuse window.

Non-Rust clients retire after the last owned operation releases its lease and
the idle budget expires. Startup, synchronization, requests, and diagnostic waits
hold leases. Idle expiry never interrupts an active operation. A stopping client
retains ownership until exact-child close is confirmed, so a second client cannot
replace it early. Session shutdown still stops session-owned clients. This is an
idle retention policy, not a fleet concurrency or memory cap.

Successful admitted edit/write hooks synchronize the current saved disk text.
They send `textDocument/didSave` only if the initialized server requests save
notifications, with text only if it requests `includeText`. Local-session hooks
use confirmed Files session metadata for the path and root fallback. SSH or
missing/inconsistent session metadata produces an explicit skip before local
filesystem work. The explicit LSP tool remains local. LSP policy does not load a
different session directory's project configuration without a trust decision.

Navigation and explicit read-only diagnostics do not fabricate save events.
Unchanged content keeps its document version and sends no redundant didChange.
A cold explicit Rust diagnostic request can lack compiler-on-save results because
reading a file is not an actual save. The client does not start another analyzer
or send a fictitious save to hide that limit.

Diagnostic results distinguish `published`, `cached`, `pending`, and `timeout`.
Policy skips and hook cancellation use `skipped` and `cancelled`. Results retain
raw diagnostic items and document/publication versions, receipt time, wait budget,
wait-end reason, and save-notification state when available. Freshness is
`version-matched`, `unversioned`, `stale`, or `unknown`. Pathless diagnostics only
return cached/pending snapshots and never start a server.

`checked: true` means a post-synchronization publication matched the requested
document version. It does not mean workspace analysis or a compiler run finished.
An old version cannot satisfy the wait or replace a current version-matched cache.
A newer local document version supersedes the wait instead of silently changing
its target. An empty cache or timeout is not a clean current check. Output labels
cached errors and warnings and qualifies empty lists.

Servers may omit diagnostic versions. A new unversioned publication is observable,
but its analyzed version is unknown. A delayed old unversioned publication cannot
be distinguished from a current one. Push diagnostics also have no save-completion
acknowledgment. Results therefore report `analysisComplete: "unknown"`. Actual-save
waits use the full configured budget to sample later compiler publications.
Open/change-only waits can use a 200 ms quiet sampling interval, which is not a
completion signal. `ready` status means initialized transport, not finished
workspace indexing.

Caller cancellation stops owned startup waits, file reads, requests, and diagnostic
waits. Canceling one shared initialization caller does not stop another owner.
An abandoned pending launch remains owned until its eventual child is closed.
Request cancellation and timeout send `$/cancelRequest` best effort to that exact
generation and remove local timers/listeners. Diagnostic pushes have no request
ID, so their waits cancel locally. A server can ignore cancellation. No result
claims that remote work stopped. Hook cancellation preserves the successful file
save and reports that no LSP check completed.

## Rust server lifetime

Rust requires Linux and executable `/usr/bin/flock`. Automatic edit/write checks
never start or restart a Rust server. Use an explicit `lsp` navigation or
diagnostics request first. Opted-in automatic checks can reuse that initialized
client for 60 seconds after the last successful explicit operation. Successful
navigation responses, including null, or usable explicit diagnostic publications
and version-matched caches can renew the window. Timeout, cancellation, stale
cache, and pending outcomes cannot. Automatic checks never renew the window. One operation uses a Rust client at a time. A busy automatic
check is skipped, and a concurrent explicit request reports request-active.
Expiry waits for an active operation to finish, then stops the client unless a
successful explicit operation renewed the window. Status and pathless diagnostics
do not start servers.

Participating processes for the same numeric OS user share one Rust slot at
`/tmp/pi-grounded-lsp-<uid>/rust.lock`. The namespace does not depend on the
repository, Pi agent directory, HOME, TMPDIR, or XDG settings. The parent and
foreground server inherit the same kernel lock. Ownership remains until their
copies close. Normal release never removes the lock file. An unavailable launcher,
unsafe directory/file, or unsupported platform refuses explicit Rust use rather
than starting an unbounded server. `lsp action=status` reports local state and the
last outcome, not a fleet census. Skipped checks say that no check occurred. They
are not clean diagnostics.

The restriction applies to a whole configured server when its ID or command
basename is `rust-analyzer`, its extensions contain `.rs`, or its scalar/mapped
language is `rust`. Language and extension policy checks ignore case. This also
covers custom IDs and mixed-language mappings. A concealed executable alias with
misleading metadata cannot be detected. Custom launch commands must stay in the
foreground and must not deliberately drop or unlock descriptor 3. Descendants can
retain the lock after the Pi parent dies, so the slot can remain busy. Do not remove
the lock file or kill another owner to reclaim admission.

One slot is a process-count bound, **not an RSS memory limit**. One analyzer, its
helpers, old loaded clients, nonparticipating processes, or Pi can still exhaust
memory. This policy does not provide cgroup containment. Non-Rust clients use the
separate bounded idle policy above. Document-language mappings are unchanged.
Reload or restart existing Pi sessions only after their work is settled to activate
changed source.

For an LSP-only staged change, run `node scripts/verify-lsp.mjs` from the repository
root. This standalone command uses the Git index, prepares committed-lock
dependencies in a disposable snapshot, and checks only the LSP source routes,
syntax, privacy, and tiny fake-server lifecycle. It does not run a real Rust
workspace, other package tests, builds, or packaging checks. The general
`--product grounded-tools` command above still includes shared repository checks.

## Session rollover

This section describes the retained legacy V3 path in the [historical source](https://github.com/JCFrags/my-shtty-pi/tree/84bbb994ddda237f5df7a98cca30b1ed1f5ec2ed/packages/grounded-tools). It is not a provider installation procedure for current main. Notes, Todo, and Workplan can export their complete current native state at a settled session boundary. Chrono V3 carries that state into a new physical session through `grounded-state-checkpoint-v1` custom entries. IDs, counters, archived records, and Workplan revision and checkpoint history remain intact. Later ordinary events replay from that checkpoint on the selected branch.

Export reads in-memory provider state, not old session archives. Each provider limits a checkpoint to 8 MiB, 200,000 visited values, and 32 nesting levels. Chrono limits the combined checkpoints to 16 MiB. Invalid, pending, or over-budget state prevents rollover. The system does not shorten tool state to make it fit.

Install these providers and their matching `core` with Chrono V3. Older providers do not understand the checkpoint format. Keep checkpoint-aware providers after rollover, or use a verified logical rollback before restoring old code. See [Chrono recovery](../../docs/chrono-v3/recovery.md#native-state-after-rollover).

Grounded Process cancels session switches while managed processes are running or persistent sessions are open. Settle jobs and close sessions normally before switching. Reload still shuts down managed resources, so an empty editor alone does not make reload safe.
