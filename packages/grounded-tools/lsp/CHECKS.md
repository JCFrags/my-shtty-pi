# Explicit project checks

The `check` tool discovers existing project commands and runs selected checks. It is separate from `lsp`: a language-server diagnostic publication does not prove that a CLI check, build, or test finished. This guide describes the facade's contracts, not completed native-tool or runtime acceptance.

## Safety and prerequisites

Run and preview require a trusted **local caller project**. Start Pi in the intended project directory. A discovered Git or package root does not expand trust. Execution targets and their resolved paths must stay inside the trusted caller directory. There is no SSH/session routing parameter.

Native commands can execute arbitrary project code and hooks, change files, restore dependencies, and use the network. A name such as `lint`, `check`, or `test` does not make a script read-only. Review the discovered command, arguments, working directory, source, and notes before execution. `allowNetwork: false` is not a subprocess network sandbox.

The facade does not install tools, activate environments, restore dependencies, or configure build trees for you. A selected native command can perform those actions itself. It does not replace the project's build system.

Install only the optional tools you need, outside a check request:

| Tool | Operator prerequisite |
| --- | --- |
| `pyright` | An installed Pyright CLI. The npm distribution needs Node.js/npm. Select the project's existing Python environment and dependencies separately. |
| `ruff` | An installed Ruff CLI. Use Ruff 0.16 or newer for JSON format-check output. A native binary or supported Python package installation can supply it. |
| `vale` | Vale 3.23 or newer within major version 3. The current quote-aware adapter rejects other major versions. |
| `shellcheck` | An installed ShellCheck CLI with JSON1 output support. No Bash language server is required. |

JSON, YAML, TOML, and Markdown use package dependencies. Prepare the supported checkout as described in [Grounded installation](../README.md#install-files-process-and-lsp). Availability does not prove tool version, installed project dependencies, SDK readiness, or successful exercise. Native build/test candidates still need their own installed SDKs and project setup.

## Choose an action

These JSON objects are `check` arguments, not shell commands. Replace sample paths with existing project paths.

```json
{"action":"status"}
```

Status reports configured analyzers, executable availability, active requests, and this runtime's limits. `exercised` and `lastOutcome` cover completed analyzer runs in the loaded session only. They do not certify a workspace pass.

```json
{"action":"discover","path":".","scope":"package"}
```

Discovery reads declarations and environment facts without executing project commands. It can run built-in read-only Git queries. It remains available before project trust. Review `target`, `environment`, `commands`, and `analyzers`. Discovery is not execution or permission.

```json
{"action":"run","path":"src/example.py","scope":"file","checks":["pyright","ruff","ruff-format"]}
```

Select up to eight explicit analyzer IDs. Pyright type checking, Ruff lint, and format checking have separate results. No fixes are applied by this run.

```json
{"action":"run","path":"docs","scope":"changed","baseRef":"HEAD","checks":["markdown","vale"]}
```

For a native command, copy the exact ID and fingerprint from a fresh discovery. The following values are placeholders, not usable command identifiers:

```json
{"action":"run","path":".","scope":"package","commandId":"<discovered-command-id>","fingerprint":"<discovered-fingerprint>"}
```

Do not combine `commandId` with `checks`. Native commands support their reported package/workspace scopes, not guessed file arguments. A changed or missing fingerprint requires discovery again. The fingerprint checks the selected declaration inputs, not every dependency, imported script, or possible side effect. Discovery labels are hints, not proof that conventional tasks exist or cover the workspace.

## Analyzer IDs

Analyzer IDs are not native command IDs. Native commands retain their displayed arguments and can have different side effects.

| ID | Purpose and limit |
| --- | --- |
| `pyright` | Independent CLI type check. Native Python configuration and import resolution matter. It is not an LSP freshness observation. |
| `ruff` | Native selected lint rules. Fix, fix-only, unsafe-fix, and cache-writing modes are disabled by this adapter. |
| `ruff-format` | Native formatter in check-only mode. Formatting is not type checking or lint. |
| `json`, `yaml`, `toml` | Syntax parsing of applicable selected documents, not schema or application validation. |
| `shellcheck` | Native shell lint for exact file/changed selections. Package/workspace scope is unsupported. |
| `markdown` | Bundled Markdown rules, local target existence, and bounded GitHub-style anchor checks. |
| `vale` | Explicit warning-first prose profile, not a grammar, truth, or meaning guarantee. |
| `links-network` | Unsupported. No network request is sent, even with `allowNetwork: true`. |

`ruff-fix` is a preview-only selector, not a run analyzer. Unknown IDs are reported as unsupported. Disabled run checks are skipped. LSP schema selection and other language-specific checks remain separate. See [server setup](SERVERS.md).

## Scope and environment

| Scope | Selection |
| --- | --- |
| `file` | One existing regular file. Supply `path`. A directory is not a file target. |
| `changed` | Existing tracked worktree changes compared with `baseRef` (default `HEAD`), plus Git-unignored untracked files, restricted to the selected path. Deleted files, symlinks, and dependency/build paths are excluded. |
| `package` | The nearest native package working directory. Native tools use their own discovery. Data enumeration excludes nested package/worktree boundaries. |
| `workspace` | The resolved project/worktree root. This is a selected invocation, not proof that all nested projects or configurations were checked. |

Discovery defaults to package scope. Run and preview default to file scope. Use explicit scopes in repeatable workflows. `baseRef` is for changed scope only and must name one revision, not a revision range or command option.

Package/workspace data enumeration is requested only for parser, Markdown, or Vale runs. It covers regular JSON/JSONC/YAML/TOML/Markdown data files within fixed traversal bounds, with dependency/build and symlink exclusions. It does not apply Git ignore rules. Other tools retain native discovery. An empty enumerated list is not a clean check.

Exact file/changed entry paths do not prevent Pyright from analyzing imports. Explicit Pyright paths override native `include` selection while other native settings still apply. Exact Python selections are grouped by the nearest native Python project, with a separate environment and result per group. Read every group's completion. One group, or one configured workspace invocation, is not a pass for every Python project. Ruff retains nearest per-file configuration and target-version inference; explicit files normally bypass discovery exclusions unless native `force-exclude` applies.

`environment` reports configuration files, version hints, interpreter provenance, and notes. These are facts, not proof that dependencies exist or versions are compatible. Python selection uses an explicit `pythonPath` first, then native Pyright `venvPath`/`venv`. A missing or outside-root native environment does not trigger a replacement. Otherwise it looks for existing `.venv`/`venv`, an applicable project-local `VIRTUAL_ENV`, then inherited `PATH`. It ignores an unrelated active virtual environment. It does not create or activate an environment. Native configuration remains authoritative. JSONC Pyright configuration can remain a native input even when declarative facts cannot be extracted. Pyright receives the resolved interpreter through `--pythonpath`. Native pytest uses the resolved interpreter. Built-in native Ruff/Pyright candidates use the configured analyzer executables. Inspect `execution.command` and interpreter provenance rather than infer selection from the discovery label.

## Read results and limits

Each `results` entry reports its tool, kind, target, scope, environment, outcome, completion, findings, and notes. A native command that exits nonzero can be completed but failed. A completed analyzer can still have findings. Aggregate `completed` does not mean all outcomes passed.

Normalized findings retain rule IDs, severity, locations when available, column encoding, and provenance. Coordinates are 1-based. Do not treat Unicode, UTF-16, and byte columns as interchangeable. Exact duplicate findings can share `sources`. Different rules or observations remain distinct. Native build/test output is retained verbatim, not guessed into diagnostics. `filesAnalyzed`, when present, is not a substitute for scope coverage.

`unavailable`, `unsupported`, `skipped`, `busy`, `cancelled`, `timeout`, `output-limit`, and execution/normalization failures are not clean checks. Use each returned outcome, message, and completion flag. Cancellation uses the active tool call's signal, not a separate check action. A whole-request deadline can interrupt later checks. `requestOutcome` distinguishes the facade's deadline from caller cancellation. An underlying execution can record the internal abort separately. Owned cleanup can finish after the deadline. Synchronous parsers check cancellation between bounded operations, not through hard preemption.

The default whole-request budget is 60000 ms, with a 100–300000 ms tool range. The facade admits two active requests and the runtime admits two executions. Busy work is not queued. Captured stdout/stderr share an 8 MiB ceiling per execution, with tighter document-tool limits. File selections have a 512-file ceiling. Parser, document, grouping, and preview adapters impose smaller bounds. Exceeding a bound leaves coverage incomplete.

Execution results can include separate `stdoutLog` and `stderrLog` paths. A clipped tool response can include `fullOutputPath`. Follow only returned paths. Treat logs as private and inspect them before publication. An output-limit stop does not promise output after termination, and unconfirmed close or log flush is a failure, not successful cleanup.

On Linux, participating expensive checks use shared per-user admission. Availability depends on the supported lock launcher. Other platforms use the session bound. Counts, timeouts, and captured-output limits are not resident set size (RSS) limits or disk quotas. Retained logs have no disk quota. Daemonized descendants and nonparticipating tools are outside these guarantees. Status describes this owner, not every process on the machine.

## Document policy

JSON parsing is strict and does not support comments. Enumerated JSONC is not validated by the `json` adapter. YAML streams use parser syntax rules; TOML parsing does not independently validate application or calendar meaning. Parsing does not select a schema. Use an explicitly configured schema validator or a discovered native schema command separately. Lint also requires its selected rule policy.

The bundled Markdown profile checks heading jumps (`MD001`), fence language labels (`MD040`), supported undefined references (`MD052`), and bounded local links/anchors. It does not load project markdownlint settings or inline markdownlint configuration. Style warnings skip copied blockquotes, but their rendered links and headings remain checked. Frontmatter is masked, not schema-validated.

Only the `github` anchor profile is supported. It indexes Markdown headings and simple literal HTML anchors within the admitted root. Missing local files or supported anchors are findings. Complex/raw HTML, MDX, renderer extensions, generated routes, non-Markdown fragments, source-line fragments, and platform-specific schemes can be unverified or unsupported. Existing assets/directories pass existence only. Linked Markdown files can be read for anchor indexes without becoming fully linted selections. Remote URLs are counted but not fetched. A completed Markdown result is not an external-link check.

Vale uses an explicit bundled offline configuration, not an automatically discovered project `.vale.ini`. The bundled profile skips code, frontmatter, blockquotes, and recognized quote scopes. Straight single quotes, angle quotation marks, and unmarked interface quotations are not recognized universally. Quotes that cross inline formatting, such as bold text, are not excluded reliably. Review warnings without changing protected quotations, code, facts, or uncertainty. Vale cannot establish truth, preserved meaning, or actor identity. Its location evidence is not a safe edit range.

Custom Vale requires both `configuration.valeConfig` and `configuration.allowCustomVale: true`. The path resolves from the selected environment working directory. Only Markdown glob sections, a local relative `StylesPath` inside the configuration directory, and bounded local static `existence` rules are accepted. Packages, downloads, natural language processing endpoints, transforms, scripts, action rules, pipelines, and other configuration layers are refused. Custom scopes can differ from bundled exclusions. `configuration.valeUseConfigSeverity: true` explicitly uses configured severity instead of warning-first findings. This validation is not an adversarial filesystem sandbox.

## Non-applying Ruff previews

```json
{"action":"preview","path":"src/example.py","scope":"file","checks":["ruff-format"]}
```

For safe lint-fix proposals, replace the single selector with `ruff-fix`. Preview requires exact file/changed selections, one supported selector, and no native command. Ruff receives captured stdin with the original filename for native configuration. It does not write the source or configuration. Previews admit at most 32 files, 1 MiB per captured/proposed file, and 4 MiB aggregate captured plus proposed text.

Safe-fix previews accept only structured fixes classified as safe. Unsafe/unclassified fixes and configuration-based safety promotions are excluded. Notebook safe-fix previews need a cell-aware adapter and are rejected. Overlapping or ambiguous edits reject the file proposal. Safety classification is not semantic correctness, and one pass does not prove that all lint findings were fixed.

Review each returned patch. To apply it, send the returned `path`, `expectedDigest`, and `edits` to the native `edit` tool. Do not include `patch` as an edit argument. Digest and anchors protect the captured snapshot. If the file changed, request a new preview instead of replacing the digest to force application. Application is a separate explicit action, and multi-file application is not atomic. A completed preview is neither an accepted fix nor a project pass.

## Configuration

Global configuration is `getAgentDir()/grounded-tools/checks.json`, where `getAgentDir()` is Pi's selected agent directory. A trusted caller can override it with `.pi/grounded-checks.json` in the caller working directory. This is separate from LSP configuration.

```json
{
  "commands": {"pyright":"pyright", "ruff":"ruff", "vale":"vale", "shellcheck":"shellcheck"},
  "disabledChecks": [],
  "timeoutMs": 60000,
  "configuration": {"markdownAnchorProfile":"github"}
}
```

`commands` maps analyzer executables to names or paths, not shell expressions or argument arrays. Command entries merge by key. Project values override global values. Other top-level fields, including the whole `configuration` object, are replaced by project values rather than deep-merged. Preserve unrelated settings when adding a project override.

Optional `pythonPath` selects an existing interpreter path or executable name. Relative paths resolve from the selected check working directory. For example, an operator can select `.venv/bin/python` on POSIX or `.venv/Scripts/python.exe` on Windows after that environment exists. Do not put credentials or private machine paths in shared configuration examples. Configuration and source selection alone do not prove that the loaded tool has been exercised or accepted.
