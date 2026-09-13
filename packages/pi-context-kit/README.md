# Context Kit

Context Kit is the first Chrono V4 foundation. It contains two independently loadable Pi extensions and one pure protocol library. It does not replace Chrono compaction or provide the planned new Memory, Todo, Notes, and Workplan implementations.

| Package | Interface | Purpose |
| --- | --- | --- |
| [Recall](recall/README.md) | `context_recall` | Find bounded current-state cards from active Todo, Notes, and Workplan tools. Follow returned native recovery calls for more context. |
| [Telemetry](telemetry/README.md) | `telemetry_status`, `/context-telemetry` | Inspect local content-free runtime counters and separate caller-reported quality observations. |
| [Protocol](protocol/README.md) | No Pi entrypoint | Validate versioned native requests and responses without starting resources or owning state. |

## Install selected extensions

Prepare the repository-root lock, then register only the extensions you need:

```sh
npm ci --ignore-scripts --no-audit --no-fund
pi install "$PWD/packages/pi-context-kit/recall"
pi install "$PWD/packages/pi-context-kit/telemetry"
```

These are source-loaded packages. The repository workflow uses Node 24.18.0 and Pi 0.85.1. Do not register the Context Kit grouping directory or the protocol library as an extension. Do not install dependencies separately inside its workspace packages.

Recall does not require any provider to start. To get native state cards, load the selected Grounded `tasks`, `notes`, and `workplan` packages from this revision and keep their native tools active. Those providers keep their existing tools, persistence, checkpoint formats, and standalone behavior. An inactive or missing provider produces an explicit partial result rather than hidden tool activation.

Telemetry works without Recall, Grounded Tools, Chrono, or a model. Loading it starts local collection at `session_start`. Its [storage and privacy limits](telemetry/README.md#privacy-and-storage-limits) apply even when no other Context Kit package is loaded. If Chrono or another compactor can cancel compaction, place Telemetry before it in the `packages` settings list. See [load order](telemetry/README.md#load-order).

For an existing installation, replace only intended package sources. Preserve unrelated order and configuration. See [activation and rollback](../../docs/activation.md). A changed path does not prove that an existing Pi process loaded the change.

## Use Recall

```json
{"query":"release blocker","providers":["todo","notes","workplan"],"records":6,"maxBytes":16384}
```

Queries match bounded case-insensitive terms, not exact phrases or semantic similarity. Cards include native ID, revision, status, category, excerpts, omitted fields, and read-only recovery instructions. Native task dependencies and milestone-to-task links remain explicit references, not synchronized state.

Default limits are six cards and 128 scanned records per provider, 8 KiB per provider reply, a 150 ms common wait, and a 16 KiB complete serialized result. The current adapters scan at most 128 native records even if a caller requests a larger protocol scan limit. They also bound fields and nested collections. Check coverage and omissions before drawing conclusions from an empty or partial page.

Recall does not scan historical archives, mutate tools, inject context, or trigger compaction. A card is derived current state, not an instruction. Its native recovery call can return a newer revision. Use Chrono's exact historical recovery for old content.

## Verify and evaluate

```sh
npm test --prefix packages/pi-context-kit
node --experimental-transform-types --test packages/grounded-tools/workplan/test/context-adapters.test.mjs
```

Focused checks use real factories, the Pi event bus, and private fixture state. They do not prove live activation or general agent benefit. Telemetry runtime counters are not accuracy measurements. Without explicit quality observations, quality remains unknown. Caller-provided quality observations are not independently verified by the collector.

See the [practical evidence](../../docs/chrono-v4/foundation-evidence.md), [V4 design](../../docs/chrono-v4/README.md), [first-slice scope](../../docs/chrono-v4/foundation-scope.md), and [source-pinned research](../../docs/chrono-v4/research.md) for measured results, planned components, and change-course rules.
