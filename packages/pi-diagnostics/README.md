# Pi diagnostics

On-demand, read-only evidence for the current Pi process/session. `/diagnostics` and `pi_diagnostics` use the same collector, report types, and predefined checks. Opening the menu does not collect a report, start a model turn, or append a session entry.

## Installation

This package uses the Pi/TUI 0.99.1 public APIs. Its tested range is `>=0.99.1 <0.100.0`. Use Node.js 24.18.0 or later. Prepare the package-local locked dependencies. Do not change the global Pi installation as part of diagnostics activation.

```sh
npm --prefix packages/pi-diagnostics ci --ignore-scripts --no-audit --no-fund
pi install "$PWD/packages/pi-diagnostics"
```

For an existing installation, use the repository's [scoped activation procedure](../../docs/activation.md). Preserve package order and unrelated selections. Agent Context is retired and is not a dependency. An absent optional provider returns unavailable evidence, not a healthy result.

## User menu

Open `/diagnostics`, then select Overview, Session/context, Runtime telemetry, Prompt inputs/tools, Components/source, Environment/resources, or Run read-only audit. Audit selection offers the quick group, individual check IDs, and the check catalog without execution.

Detail screens use Markdown and ScrollView. Use Up/Down, PgUp/PgDn, and Home/End to scroll. Use `b` or Escape for Back, `r` for explicit Refresh, `d` for Details, `n`/Right and `p`/Left for pages, `s` for Save, and `q` for Close. No dashboard refresh runs automatically. The menu does not clear the editor draft or stop an active run. Values can change while a report is collected.

Save first shows the selected report for review. Then choose Markdown or JSON and confirm the local destination. Only the selected report/page is saved, not uncollected pages. The default is the agent directory's `diagnostics/reports` directory. New default directories use mode `0700`. New files use exclusive creation and mode `0600`. Existing files, symlinks, unsafe parents, and writable/unowned destinations are refused. Existing permissions are never changed. Custom destinations require an absolute local filename and a privacy confirmation. Export needs UID and no-follow filesystem support. A failed write can leave a new partial file at the chosen path.

There is no upload, report database, retention service, or model-tool export action.

## Agent tool

The action-specific schema accepts only these actions and catalog IDs:

```json
{"action":"status"}
{"action":"inspect","topics":["runtime","tools","telemetry"],"view":"summary"}
{"action":"list_checks"}
{"action":"audit","checkIds":["runtime.loaded-source-match","telemetry.storage-health"],"view":"summary"}
```

Topics are `runtime`, `session`, `telemetry`, `tools`, `components`, `resources`, and `state`. `view` is `summary` or `detailed`. Detail and catalog pages accept `offset` and `limit` (1 to 50, default 25). Continue with the returned `page.nextOffset`. Each page is a new non-atomic observation, not a frozen snapshot. The tool returns JSON text and matching `details` and `structuredContent`.

`status` checks comparable component entrypoints, Telemetry storage, and native context usage. `list_checks` returns all ten predefined check IDs, evidence needs, and limits without running them. `audit` accepts explicit IDs only. There are no shell commands, arbitrary tool executions, globbed roots, or remote destinations.

Outcomes are `pass`, `warn`, `fail`, `unknown`, and `skipped`. Findings retain supporting field IDs and a next inspection. A source mismatch is a deterministic failure. Full/failed Telemetry recording is a warning, not authority to clean storage. Unsupported startup, role, and cached-state checks return unknown. A pass covers only its stated evidence, not the whole installation or answer quality.

## Evidence and limits

Schema version 1 includes a report ID, collection times, requested topics/checks, per-provider source/scope/time/availability, field units and measurement basis, findings, completeness, and pagination. Reports are bounded to 16 KiB of compact JSON. Supporting finding fields take priority over other detail. A truncated report states the omission and gives a continuation offset where possible.

Collection has a five-second cooperative budget. Optional owner replies wait at most 750 ms in parallel. A timer cannot preempt a synchronous same-process handler. Providers must keep their own work bounded. Cancellation returns partial evidence and skipped checks. Reports do not establish a globally atomic observation.

Keep these scopes separate:

- Native active-context tokens/percent are estimates and can be unknown after compaction. The model context window is reported metadata.
- Native session-file totals are unavailable on ExtensionContext. Use native `/session`. Diagnostics does not reconstruct totals, scan session entries, or infer logical-session identity.
- Telemetry metrics cover the existing collector run, not session lifetime. Usage channels stay separate. Memory values are the last whole-process sample, not per-extension usage.
- Quality is `unknown` or `observed_not_verified`. Caller-reported observations do not measure accuracy.
- Running Pi's captured module version and the on-disk manifest version are separate. Diagnostics' factory ID and factory-time entrypoint hash are component attestations, not proof of the whole binary/dependency closure.
- Configured package references and native tool source references are hashed metadata. They do not establish complete selected/loaded inventory. Without a live status-only attestation, reload identity stays unavailable.
- Native registered/active tool sets, host exposure, cached Progressive Tools policy, practical callability, permission, and readiness are separate. Diagnostics does not execute tools or change activation to test them. Command-context prompt inputs are not the final provider request. Agent-tool prompt provenance remains unavailable.
- Environment facts describe this local runtime. Managed resource counts cover participating owners only. No SSH target is inspected and no process census is attempted. Readiness is not transition permission.

Raw prompts, conversation bodies, tool arguments, schemas, arbitrary provider error text, private source paths, environment variables, authentication stores, and credentials are omitted. Raw inspection/export is not offered in this release. Reports still contain private runtime metadata. Review the exact report before sharing it.

## Optional read-only owner protocol

Event `pi-diagnostics:provider:v1` accepts fixed provider IDs `telemetry`, `progressive-tools`, and `reload`:

```ts
{ protocolVersion: 1, provider, signal: AbortSignal, deadline: number, respond(reply) }
// Reply from the already loaded owner:
{ protocolVersion: 1, provider, observedAt: ISO, status }
```

Telemetry replies with its existing bounded `status()` snapshot. Progressive Tools replies only after normal owner initialization, using its last normal policy/configuration read and current native registration. It keeps at most 500 cached classifications from the normal owner read. It does not load configuration, classify against an unbounded rule set, or enforce policy for diagnostics. New registrations without a cached classification make policy coverage unknown. Replies include the cached configuration timestamp and error count, not raw configuration/error text. The reload protocol is optional and independent of slash/tool renames. Only allowlisted version/UUID/hash/pending metadata is used. Fleet lookup and control methods are never invoked.

Grounded Process's existing `grounded:session-transition-readiness:v1` supplies synchronous managed job/session counts. Cached history, native state, and role contracts are not supported in this release. Diagnostics does not call their read/import/resolve routes to obtain a passing readiness result.

Existing `/session`, `/context-telemetry`, `telemetry_status`, Progressive Tools, and reload interfaces remain owned by their components. Diagnostics adds no reset/startup/model/tree snapshot, recurring monitor, writer, repair, reload, compaction, installation, remote access, model request, or automatic publication.

## Verification

```sh
npm --prefix packages/pi-diagnostics run typecheck
npm --prefix packages/pi-diagnostics test
```

The small focused check exercises shared evidence, controlled mismatch/full-storage findings, unknown inputs, response bounds, and private exclusive export. Required repository CI remains the integration gate. Practical menu/tool use and loaded activation are separate from a build or loader check.
