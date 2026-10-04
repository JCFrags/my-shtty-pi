import { open, readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type {
  AnalyzerContext, CheckKind, CheckOutcome, CheckResult, ExecutionResult, Finding, TextPreview,
} from "./check-types.ts";

export const analyzerIds = ["pyright", "ruff", "ruff-format", "json", "yaml", "toml", "shellcheck"] as const;

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PARSE_FILES = 256;
const MAX_PREVIEW_FILES = 32;
const MAX_PREVIEW_SOURCE_BYTES = 1024 * 1024;
const MAX_PREVIEW_TOTAL_BYTES = 4 * MAX_PREVIEW_SOURCE_BYTES;
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);
const RUFF_EXTENSIONS = new Set([".py", ".pyi", ".pyw", ".ipynb"]);
const FORMAT_EXTENSIONS = new Set([...RUFF_EXTENSIONS, ".md", ".qmd"]);
const SHELL_EXTENSIONS = new Set([".sh", ".bash", ".ksh", ".dash", ".bats"]);

interface Budget { deadline: number }
interface Normalized { findings: Finding[]; errors: string[]; notes: string[] }
interface OffsetEdit { start: number; end: number; content: string }
type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function kindFor(id: string): CheckKind {
  return id === "pyright" ? "type" : id === "ruff-format" ? "format"
    : id === "ruff" || id === "shellcheck" ? "lint" : "syntax";
}

function budgetFor(context: AnalyzerContext): Budget {
  if (!Number.isFinite(context.timeoutMs) || context.timeoutMs <= 0) throw new Error("A finite positive check timeout is required.");
  return { deadline: Date.now() + context.timeoutMs };
}

function stopped(context: AnalyzerContext, budget: Budget): "cancelled" | "timeout" | undefined {
  return context.signal?.aborted ? "cancelled" : Date.now() >= budget.deadline ? "timeout" : undefined;
}

function result(
  id: string, context: AnalyzerContext, outcome: CheckOutcome, findings: Finding[] = [],
  notes: string[] = [], execution?: ExecutionResult, metadata?: unknown, filesAnalyzed?: number,
): CheckResult {
  return {
    tool: id, kind: kindFor(id), scope: context.target.scope, outcome,
    completed: outcome === "passed" || outcome === "findings", findings,
    environment: context.environment, target: context.target, notes,
    ...(execution ? { execution } : {}), ...(metadata !== undefined ? { metadata } : {}),
    ...(filesAnalyzed !== undefined ? { filesAnalyzed } : {}),
  };
}

function syntheticExecution(
  context: AnalyzerContext, command: string, args: string[],
  outcome: ExecutionResult["outcome"], message: string,
): ExecutionResult {
  return {
    outcome, command, args, cwd: context.target.cwd, exitCode: null, signal: null,
    stdout: "", stderr: "", startedAt: Date.now(), durationMs: 0, message,
    resourceNotes: ["No analyzer process was started by this request."],
  };
}

async function execute(
  context: AnalyzerContext, budget: Budget, command: string, args: string[], stdin?: string,
  expensive = false,
): Promise<ExecutionResult> {
  const reason = stopped(context, budget);
  if (reason) return syntheticExecution(context, command, args, reason, `Analyzer ${reason} before launch.`);
  try {
    return await context.execute({
      command, args, cwd: context.target.cwd, timeoutMs: Math.max(1, budget.deadline - Date.now()),
      maxOutputBytes: MAX_OUTPUT_BYTES, signal: context.signal,
      resourceClass: expensive ? "expensive" : "normal", ...(stdin !== undefined ? { stdin } : {}),
    });
  } catch (error) {
    return { ...syntheticExecution(context, command, args, context.signal?.aborted ? "cancelled" : "failed",
      `Analyzer execution did not return a result: ${String(error)}`),
    resourceNotes: ["The executor returned no launch or child-close evidence. Process state is unknown."] };
  }
}

// A bare nonzero-exit label can describe CLI findings. An explicit executor failure must stay failed.
function executionStop(execution: ExecutionResult): CheckOutcome | undefined {
  if (execution.outcome !== "completed" && execution.outcome !== "failed") return execution.outcome;
  if (execution.outcome === "failed" && execution.message) return "failed";
  if (execution.signal !== null || execution.exitCode === null) return "failed";
  if (execution.outcome === "failed" && execution.exitCode === 0) return "failed";
  return undefined;
}

function commandFor(id: string, context: AnalyzerContext): string {
  const command = context.commands[id] ?? (id.startsWith("ruff-") ? context.commands.ruff : undefined)
    ?? (id.startsWith("ruff") ? "ruff" : id);
  if (!command.trim()) throw new Error(`No executable is configured for ${id}.`);
  return command;
}

function selectedFiles(context: AnalyzerContext, accept: (path: string) => boolean): string[] {
  return [...new Set(context.target.files.map((file) => resolve(context.target.cwd, file)))].filter(accept);
}

function targetsFor(id: string, context: AnalyzerContext): { paths: string[]; notes: string[]; empty: boolean } {
  if (context.target.selection === "exact-files") {
    const paths = selectedFiles(context, (file) => id === "pyright"
      ? PYTHON_EXTENSIONS.has(extname(file).toLowerCase())
      : (id === "ruff-format" ? FORMAT_EXTENSIONS : RUFF_EXTENSIONS).has(extname(file).toLowerCase())
        || (id === "ruff" && basename(file) === "pyproject.toml"));
    return {
      paths, empty: paths.length === 0,
      notes: [`${paths.length} applicable file path(s) selected from ${context.target.files.length} input path(s).`,
        id === "pyright"
          ? "Explicit file paths intentionally override Pyright include. Native settings still apply. Imports can require analysis outside the selected files."
          : "Explicit files normally bypass Ruff discovery exclusions, unless native force-exclude is enabled. Nearest native configuration still applies."],
    };
  }
  if (context.target.scope === "file" || context.target.scope === "changed") {
    throw new Error(`${context.target.scope} checks require an exact file selection.`);
  }
  const paths = [...new Set((context.target.targets.length ? context.target.targets : [context.target.path])
    .map((path) => resolve(context.target.cwd, path)))];
  const nativeDiscovery = id === "pyright" && paths.length === 1 && paths[0] === resolve(context.target.cwd);
  return {
    paths: nativeDiscovery ? [] : paths, empty: false,
    notes: [nativeDiscovery
      ? "Pyright discovers inputs from the native configuration at the selected working directory."
      : id === "pyright"
        ? "Positional directory targets intentionally override Pyright include to restrict entry files. Native settings still apply."
        : "Ruff discovers inputs under the selected paths with native inclusions, exclusions, ignore files, and nearest configuration.",
    "A completed selected-scope run is not proof that every workspace file was checked."],
  };
}

async function readSource(path: string, signal?: AbortSignal, maximumBytes = MAX_SOURCE_BYTES): Promise<string> {
  if (signal?.aborted) throw new Error("Source read cancelled.");
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a regular source file: ${path}`);
  if (info.size > maximumBytes) throw new Error(`Source exceeds the ${maximumBytes}-byte limit: ${path}`);
  const bytes = await readFile(path, { signal });
  if (bytes.length > maximumBytes) throw new Error(`Source grew beyond the byte limit: ${path}`);
  // Reject invalid UTF-8 rather than replace bytes before a later edit. Preserve a leading BOM.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

async function startsWithBom(path: string): Promise<boolean | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const bytes = Buffer.alloc(3);
    const { bytesRead } = await handle.read(bytes, 0, 3, 0);
    return bytesRead === 3 && bytes.equals(Buffer.from([0xef, 0xbb, 0xbf]));
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function severity(value: unknown, fallback: Finding["severity"]): Finding["severity"] {
  if (value === "error" || value === "warning" || value === "information") return value;
  if (value === "info" || value === "note" || value === "style") return "information";
  if (value === undefined || value === null) return fallback;
  throw new Error(`Unknown diagnostic severity: ${String(value)}`);
}

function ruffLocation(value: unknown): { row: number; column: number } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!object(value) || !integer(value.row, 1) || !integer(value.column, 1)) throw new Error("Invalid Ruff location.");
  return { row: value.row, column: value.column };
}

async function normalizeRuff(raw: unknown, id: string, cwd: string): Promise<Normalized> {
  if (!Array.isArray(raw)) return { findings: [], errors: ["Expected a Ruff JSON diagnostic array."], notes: [] };
  const normalized: Normalized = { findings: [], errors: [], notes: [] };
  const bom = new Map<string, boolean | undefined>();
  for (const [index, item] of raw.entries()) {
    try {
      if (!object(item) || typeof item.message !== "string") throw new Error("Diagnostic has no string message.");
      const finding: Finding = {
        tool: id, kind: kindFor(id), severity: severity(item.severity, "error"), message: item.message,
        ...(typeof item.code === "string" ? { code: item.code } : typeof item.name === "string" ? { code: item.name } : {}),
        ...(item.fix !== undefined && item.fix !== null ? { suggestion: item.fix } : {}),
      };
      normalized.findings.push(finding);
      if (typeof item.filename === "string" && item.filename) finding.file = resolve(cwd, item.filename);
      else if (item.filename !== undefined && item.filename !== null && item.filename !== "") throw new Error("Invalid diagnostic filename.");
      const start = ruffLocation(item.location);
      const end = ruffLocation(item.end_location);
      if (item.cell !== undefined && item.cell !== null) {
        normalized.notes.push("Notebook diagnostics retain their cell-relative coordinates in raw JSON. Physical JSON-file locations are not fabricated.");
        continue;
      }
      if (finding.file && !bom.has(finding.file)) {
        bom.set(finding.file, await startsWithBom(finding.file));
        if (bom.get(finding.file) === undefined) normalized.notes.push(`Could not inspect the BOM for ${finding.file}; columns retain Ruff's native BOM-excluded convention.`);
      }
      const firstLineAdjustment = finding.file && bom.get(finding.file) ? 1 : 0;
      if (start) {
        finding.line = start.row;
        finding.column = start.column + (start.row === 1 ? firstLineAdjustment : 0);
        finding.columnEncoding = "unicode";
      }
      if (end) {
        if (!start || end.row < start.row || (end.row === start.row && end.column < start.column)) throw new Error("Invalid diagnostic end range.");
        finding.endLine = end.row;
        finding.endColumn = end.column + (end.row === 1 ? firstLineAdjustment : 0);
      }
    } catch (error) {
      normalized.errors.push(`Ruff diagnostic ${index + 1}: ${String(error)}`);
    }
  }
  normalized.notes = [...new Set(normalized.notes)];
  return normalized;
}

function normalizePyright(raw: unknown, cwd: string): Normalized {
  if (!object(raw) || !Array.isArray(raw.generalDiagnostics)) return { findings: [], errors: ["Expected Pyright generalDiagnostics."], notes: [] };
  const normalized: Normalized = { findings: [], errors: [], notes: [] };
  for (const [index, item] of raw.generalDiagnostics.entries()) {
    try {
      if (!object(item) || typeof item.message !== "string") throw new Error("Diagnostic has no string message.");
      const finding: Finding = {
        tool: "pyright", kind: "type", message: item.message, severity: severity(item.severity, "error"),
        ...(typeof item.rule === "string" ? { code: item.rule } : {}),
      };
      normalized.findings.push(finding);
      if (typeof item.file === "string" && item.file) finding.file = resolve(cwd, item.file);
      else if (item.file !== undefined && item.file !== null && item.file !== "") throw new Error("Invalid diagnostic filename.");
      if (item.range !== undefined && item.range !== null) {
        if (!object(item.range) || !object(item.range.start) || !object(item.range.end)) throw new Error("Invalid Pyright range.");
        const { start, end } = item.range;
        if (!integer(start.line) || !integer(start.character) || !integer(end.line) || !integer(end.character)
          || end.line < start.line || (end.line === start.line && end.character < start.character)) throw new Error("Invalid Pyright coordinates.");
        Object.assign(finding, {
          line: start.line + 1, column: start.character + 1, endLine: end.line + 1,
          endColumn: end.character + 1, columnEncoding: "utf-16",
        });
      }
    } catch (error) {
      normalized.errors.push(`Pyright diagnostic ${index + 1}: ${String(error)}`);
    }
  }
  return normalized;
}

function parseOutput(execution: ExecutionResult): { raw?: unknown; error?: string } {
  try { return { raw: JSON.parse(execution.stdout) }; }
  catch (error) { return { error: `Analyzer output is not valid JSON: ${String(error)}` }; }
}

async function runPyright(context: AnalyzerContext, budget: Budget): Promise<CheckResult> {
  const selected = targetsFor("pyright", context);
  if (selected.empty) return result("pyright", context, "skipped", [], [...selected.notes, "No applicable Python entry files were selected."]);
  const command = commandFor("pyright", context);
  const probe = await execute(context, budget, command, ["--help"]);
  const probeStop = executionStop(probe);
  if (probeStop || probe.exitCode !== 0) return result("pyright", context, probeStop ?? "failed", [],
    [...selected.notes, "Pyright capability discovery did not complete. No type-check pass is claimed."], probe, { capabilityProbe: probe });
  const threadsSupported = /(?:^|\s)--threads(?:\s|=|$)/m.test(`${probe.stdout}\n${probe.stderr}`);
  const args = ["--outputjson", ...(threadsSupported ? ["--threads", "1"] : []),
    ...(context.environment.pythonPath ? ["--pythonpath", context.environment.pythonPath] : []), ...selected.paths];
  const execution = await execute(context, budget, command, args, undefined, true);
  const parsed = parseOutput(execution);
  const normalized = normalizePyright(parsed.raw, context.target.cwd);
  const summary = object(parsed.raw) && object(parsed.raw.summary) ? parsed.raw.summary : undefined;
  if (!summary || !integer(summary.filesAnalyzed) || !integer(summary.errorCount)
    || !integer(summary.warningCount) || !integer(summary.informationCount)) normalized.errors.push("Pyright did not return a valid native summary.");
  else if (summary.errorCount + summary.warningCount + summary.informationCount !== normalized.findings.length) {
    normalized.errors.push("Pyright summary counts do not match normalized diagnostics. Raw diagnostics are retained.");
  }
  const notes = [...selected.notes,
    threadsSupported ? "Pyright supports --threads; this run requested one analysis thread."
      : "Installed Pyright does not advertise --threads. Executor resource policy still applies.",
    context.environment.pythonPath ? "The resolved Python interpreter was passed through --pythonpath. Native version/platform settings remain unchanged."
      : "No interpreter was resolved. Pyright uses its native environment discovery; import resolution may be incomplete.",
    "This is an independent CLI type check. Language-server publications and editor-only settings do not establish its result.",
    "filesAnalyzed is the native Pyright summary value. Imported, transitive, and library analysis can extend beyond the requested entry paths; this count does not prove scope coverage.",
    "Pyright has one native project configuration per invocation; a workspace run does not independently check every nested project configuration.",
    ...normalized.notes, ...(parsed.error ? [parsed.error] : []), ...normalized.errors];
  const stop = executionStop(execution) ?? stopped(context, budget);
  const validExit = execution.exitCode === 0 || execution.exitCode === 1;
  const filesAnalyzed = summary && integer(summary.filesAnalyzed) ? summary.filesAnalyzed : undefined;
  const outcome: CheckOutcome = stop ?? (!validExit || parsed.error || normalized.errors.length ? "failed"
    : normalized.findings.length ? "findings" : execution.exitCode === 1 ? "failed" : filesAnalyzed === 0 ? "skipped" : "passed");
  return result("pyright", context, outcome, normalized.findings, notes, execution,
    { rawJson: parsed.raw, jsonError: parsed.error, normalizationErrors: normalized.errors, capabilityProbe: probe, threadsSupported }, filesAnalyzed);
}

function ruffCheckArgs(paths: string[], safePreview = false): string[] {
  return ["check", "--no-cache", "--no-fix", "--no-fix-only", "--no-unsafe-fixes", "--output-format=json",
    ...(safePreview ? ["--config", "lint.extend-safe-fixes=[]"] : []), "--", ...paths];
}

async function runRuff(id: "ruff" | "ruff-format", context: AnalyzerContext, budget: Budget): Promise<CheckResult> {
  const selected = targetsFor(id, context);
  if (selected.empty) return result(id, context, "skipped", [], [...selected.notes, "No applicable Ruff inputs were selected."]);
  const args = id === "ruff" ? ruffCheckArgs(selected.paths)
    : ["format", "--check", "--no-cache", "--output-format=json", "--", ...selected.paths];
  const execution = await execute(context, budget, commandFor(id, context), args);
  const parsed = parseOutput(execution);
  const normalized = await normalizeRuff(parsed.raw, id, context.target.cwd);
  const stop = executionStop(execution) ?? stopped(context, budget);
  const validExit = execution.exitCode === 0 || execution.exitCode === 1;
  const noInputs = /No (?:Python )?files found under the given path/i.test(execution.stderr);
  const outcome: CheckOutcome = stop ?? (!validExit || parsed.error || normalized.errors.length ? "failed"
    : normalized.findings.length ? "findings" : execution.exitCode === 1 ? "failed" : noInputs ? "skipped" : "passed");
  return result(id, context, outcome, normalized.findings, [...selected.notes,
    "Native nearest Ruff configuration, rule selection, and target-version inference are preserved. No configuration file or target-version override was supplied.",
    id === "ruff" ? "Fixes and fix-only mode are disabled, including when enabled by native configuration."
      : "Formatting ran in check-only mode. JSON format-check output requires Ruff 0.16 or newer.",
    "Ruff JSON does not report an analyzed-file count. Input and diagnostic counts are not substituted for filesAnalyzed.",
    "Locations are 1-based Unicode code points. A confirmed first-line BOM is included in normalized columns. End locations are exclusive.",
    ...normalized.notes, ...(noInputs ? ["Ruff reported no discovered input files; this is not a clean scope check."] : []),
    ...(parsed.error ? [parsed.error] : []), ...normalized.errors], execution,
  { rawJson: parsed.raw, jsonError: parsed.error, normalizationErrors: normalized.errors });
}

function offsetLocation(text: string, offset: number): { line: number; column: number } | undefined {
  if (!integer(offset) || offset > text.length) return undefined;
  const before = text.slice(0, offset);
  const lines = before.split(/\r\n|\r|\n/);
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function parserFinding(id: string, file: string, message: string, code: string, location?: { line: number; column: number }): Finding {
  return { tool: id, kind: "syntax", file, severity: "error", code, message,
    ...(location ? { ...location, columnEncoding: "utf-16" as const } : {}) };
}

async function runParser(id: "json" | "yaml" | "toml", context: AnalyzerContext, budget: Budget): Promise<CheckResult> {
  const notes = ["This check parses document syntax only. It does not validate a JSON Schema, application schema, configuration meaning, lint rules, or links.",
    "Only applicable entries in the resolver's enumerated file list are parsed. This adapter does not perform directory discovery.",
    context.target.selection === "tool-discovery"
      ? "Scope coverage depends on the resolver's enumeration, exclusions, and bounds. Native CLI discovery selection does not prevent parsing enumerated files."
      : "The resolver supplied an exact file selection.", ...context.target.notes];
  if (!context.target.files.length && context.target.selection === "tool-discovery") {
    return result(id, context, "unsupported", [], [...notes, "No file list was enumerated for this scope. No parsing pass is claimed."]);
  }
  const files = selectedFiles(context, (file) => id === "json" ? extname(file).toLowerCase() === ".json"
    : id === "yaml" ? [".yaml", ".yml"].includes(extname(file).toLowerCase()) : extname(file).toLowerCase() === ".toml");
  if (!files.length) return result(id, context, "skipped", [], [...notes, "No applicable documents were selected."]);
  if (files.length > MAX_PARSE_FILES) return result(id, context, "output-limit", [], [...notes, `The ${MAX_PARSE_FILES}-file parsing limit was exceeded.`]);
  let yaml: typeof import("yaml") | undefined;
  let toml: typeof import("smol-toml") | undefined;
  try {
    if (id === "yaml") yaml = await import("yaml");
    if (id === "toml") toml = await import("smol-toml");
  } catch (error) {
    return result(id, context, "unavailable", [], [...notes, `Declared ${id} parser could not be loaded: ${String(error)}`]);
  }
  const findings: Finding[] = [];
  const issues: unknown[] = [];
  let filesAnalyzed = 0;
  for (const file of files) {
    const stop = stopped(context, budget);
    if (stop) return result(id, context, stop, findings, [...notes, "Parsing did not complete for every selected file."], undefined, { rawIssues: issues }, filesAnalyzed);
    let text: string;
    try { text = await readSource(file, context.signal); }
    catch (error) {
      return result(id, context, stopped(context, budget) ?? "failed", findings, [...notes, String(error)], undefined, { rawIssues: issues }, filesAnalyzed);
    }
    if (id === "json") {
      try { JSON.parse(text); }
      catch (error) {
        if (!(error instanceof SyntaxError)) return result(id, context, "failed", findings, [...notes, String(error)], undefined, { rawIssues: issues }, filesAnalyzed);
        const message = error.message;
        const offset = /\bposition (\d+)\b/.exec(message);
        const nativeLine = /\bline (\d+) column (\d+)\b/.exec(message);
        const location = offset ? offsetLocation(text, Number(offset[1]))
          : nativeLine ? { line: Number(nativeLine[1]), column: Number(nativeLine[2]) } : undefined;
        findings.push(parserFinding(id, file, message, "JSON_PARSE", location));
        issues.push({ file, message, ...(offset ? { offset: Number(offset[1]) } : {}) });
      }
    } else if (yaml) {
      try {
        const documents = yaml.parseAllDocuments(text, { prettyErrors: false, strict: true, logLevel: "silent" });
        // Directive-only streams can contain errors even when they have no document nodes.
        const sources = "empty" in documents ? [{ documentIndex: 0, document: documents }]
          : documents.map((document, index) => ({ documentIndex: index + 1, document }));
        for (const { documentIndex, document } of sources) {
          for (const [level, diagnostics] of [["error", document.errors], ["warning", document.warnings]] as const) {
            for (const issue of diagnostics) {
              const location = offsetLocation(text, issue.pos[0]);
              const finding = parserFinding(id, file, issue.message, issue.code, location);
              finding.severity = level;
              const end = offsetLocation(text, issue.pos[1]);
              if (end && location && issue.pos[1] >= issue.pos[0]) { finding.endLine = end.line; finding.endColumn = end.column; }
              findings.push(finding);
              issues.push({ file, document: documentIndex, severity: level, code: issue.code, message: issue.message, pos: issue.pos });
            }
          }
        }
      } catch (error) {
        return result(id, context, "failed", findings, [...notes, `YAML parser did not complete: ${String(error)}`], undefined, { rawIssues: issues }, filesAnalyzed);
      }
    } else if (toml) {
      try { toml.parse(text, { integersAsBigInt: true }); }
      catch (error) {
        if (!(error instanceof toml.TomlError)) return result(id, context, "failed", findings, [...notes, `TOML parser did not complete: ${String(error)}`], undefined, { rawIssues: issues }, filesAnalyzed);
        const location = integer(error.line, 1) && integer(error.column, 1) ? { line: error.line, column: error.column } : undefined;
        findings.push(parserFinding(id, file, error.message, "TOML_PARSE", location));
        issues.push({ file, message: error.message, line: error.line, column: error.column });
      }
    }
    filesAnalyzed++;
  }
  const stop = stopped(context, budget);
  return result(id, context, stop ?? (findings.length ? "findings" : "passed"), findings, [...notes,
    `${filesAnalyzed} applicable document(s) parsed from ${context.target.files.length} selected path(s).`,
    id === "json" ? "JSON parsing is strict. JSON with comments is not supported."
      : id === "yaml" ? "YAML streams can contain multiple documents. Default YAML 1.2 parsing honors document version directives. Alias values are not expanded."
        : "smol-toml parses TOML 1.1. Large integers are accepted as BigInt. Date/calendar semantics are not independently validated.",
    "Parser work is synchronous between file reads. Cancellation and the elapsed-time budget are checked between files and after parsing; no hard preemption is claimed."],
  undefined, { rawIssues: issues }, filesAnalyzed);
}

async function runShellcheck(context: AnalyzerContext, budget: Budget): Promise<CheckResult> {
  const notes = ["ShellCheck uses native dialect/configuration. This adapter does not enable external source following or apply fixes.",
    "JSON1 uses 1-based Unicode columns, counts each tab as one character, and reports exclusive end locations."];
  if (context.target.scope !== "file" && context.target.scope !== "changed") {
    return result("shellcheck", context, "unsupported", [], [...notes, "ShellCheck supports file/changed scope until shell enumeration is available."]);
  }
  if (context.target.selection !== "exact-files") return result("shellcheck", context, "unsupported", [], [...notes, "ShellCheck requires an exact enumerated shell-file selection."]);
  const files = selectedFiles(context, (file) => SHELL_EXTENSIONS.has(extname(file).toLowerCase()) || extname(file) === "");
  if (!files.length) return result("shellcheck", context, "skipped", [], [...notes, "No applicable shell files were selected."]);
  const execution = await execute(context, budget, commandFor("shellcheck", context), ["--format=json1", "--", ...files]);
  const parsed = parseOutput(execution);
  const findings: Finding[] = [];
  const errors: string[] = [];
  if (!object(parsed.raw) || !Array.isArray(parsed.raw.comments)) errors.push("Expected ShellCheck JSON1 comments.");
  else for (const [index, item] of parsed.raw.comments.entries()) {
    try {
      if (!object(item) || typeof item.file !== "string" || typeof item.message !== "string" || !integer(item.code)) throw new Error("Invalid ShellCheck comment.");
      const finding: Finding = {
        tool: "shellcheck", kind: "lint", file: resolve(context.target.cwd, item.file),
        severity: severity(item.level, "warning"), code: `SC${item.code}`, message: item.message,
        ...(item.fix !== undefined && item.fix !== null ? { suggestion: item.fix } : {}),
      };
      findings.push(finding);
      if (!integer(item.line, 1) || !integer(item.column, 1) || !integer(item.endLine, 1) || !integer(item.endColumn, 1)
        || item.endLine < item.line || (item.endLine === item.line && item.endColumn < item.column)) throw new Error("Invalid ShellCheck coordinates.");
      Object.assign(finding, { line: item.line, column: item.column, endLine: item.endLine, endColumn: item.endColumn, columnEncoding: "unicode" });
    } catch (error) { errors.push(`ShellCheck comment ${index + 1}: ${String(error)}`); }
  }
  const stop = executionStop(execution);
  const outcome: CheckOutcome = stop ?? (parsed.error || errors.length || (execution.exitCode !== 0 && execution.exitCode !== 1) ? "failed"
    : findings.length ? "findings" : execution.exitCode === 1 ? "failed" : "passed");
  return result("shellcheck", context, outcome, findings, [...notes,
    `${files.length} shell input path(s) supplied. There is no native analyzed-file count; configured source inclusions can extend analysis.`,
    ...(parsed.error ? [parsed.error] : []), ...errors], execution,
  { rawJson: parsed.raw, jsonError: parsed.error, normalizationErrors: errors });
}

/** Run an explicit analyzer. Native nonzero finding exits are not confused with execution failure. */
export async function runAnalyzer(id: string, context: AnalyzerContext): Promise<CheckResult> {
  if (!(analyzerIds as readonly string[]).includes(id)) return result(id, context, "unsupported", [], [`Unknown analyzer: ${id}`]);
  try {
    const budget = budgetFor(context);
    const stop = stopped(context, budget);
    if (stop) return result(id, context, stop, [], ["The analyzer did not run."]);
    if (id === "pyright") return await runPyright(context, budget);
    if (id === "ruff" || id === "ruff-format") return await runRuff(id, context, budget);
    if (id === "shellcheck") return await runShellcheck(context, budget);
    return await runParser(id as "json" | "yaml" | "toml", context, budget);
  } catch (error) {
    return result(id, context, context.signal?.aborted ? "cancelled" : "failed", [], [`Analyzer did not complete: ${String(error)}`]);
  }
}

// Ruff JSON columns count Unicode code points, not UTF-16 code units, and omit a first-line BOM.
function ruffOffset(text: string, value: unknown): number {
  const location = ruffLocation(value);
  if (!location) throw new Error("Fix edit has no source location.");
  let line = 1;
  let start = text.startsWith("\uFEFF") ? 1 : 0;
  for (let index = start; line < location.row && index < text.length; index++) {
    if (text[index] === "\r" || text[index] === "\n") {
      if (text[index] === "\r" && text[index + 1] === "\n") index++;
      line++;
      start = index + 1;
    }
  }
  if (line !== location.row) throw new Error("Fix edit row is outside the source.");
  let offset = start;
  for (let column = 1; column < location.column; column++) {
    if (offset >= text.length || text[offset] === "\r" || text[offset] === "\n") throw new Error("Fix edit column is outside the source line.");
    offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  }
  return offset;
}

function applySafeFixes(text: string, raw: unknown, file: string, cwd: string): { proposed: string; notes: string[] } {
  if (!Array.isArray(raw)) throw new Error("Expected a Ruff JSON array for a safe-fix preview.");
  const edits: OffsetEdit[] = [];
  let excluded = 0;
  let safeFixes = 0;
  for (const item of raw) {
    if (!object(item) || typeof item.message !== "string") throw new Error("Invalid Ruff diagnostic in a fix preview.");
    if (item.fix === undefined || item.fix === null) continue;
    if (!object(item.fix)) throw new Error("Invalid Ruff fix.");
    if (item.fix.applicability !== "safe") { excluded++; continue; }
    if (item.cell !== undefined && item.cell !== null) throw new Error("Cell-relative notebook fixes are not physical text edits.");
    if (typeof item.filename !== "string" || resolve(cwd, item.filename) !== file) throw new Error("Fix belongs to a different or unknown file.");
    if (!Array.isArray(item.fix.edits) || !item.fix.edits.length) throw new Error("Safe fix has no structured edits.");
    for (const edit of item.fix.edits) {
      if (!object(edit) || typeof edit.content !== "string") throw new Error("Invalid structured fix edit.");
      const start = ruffOffset(text, edit.location);
      const end = ruffOffset(text, edit.end_location);
      if (end < start) throw new Error("Fix edit has a reversed range.");
      edits.push({ start, end, content: edit.content });
    }
    safeFixes++;
  }
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < edits.length; index++) {
    const previous = edits[index - 1];
    const current = edits[index];
    if (current.start < previous.end || current.start === previous.start
      || (current.start === previous.end && (current.start === current.end || previous.start === previous.end))) {
      throw new Error("Safe fixes overlap or have an ambiguous insertion boundary. The entire file preview was rejected.");
    }
  }
  let proposed = text;
  for (const edit of [...edits].reverse()) proposed = proposed.slice(0, edit.start) + edit.content + proposed.slice(edit.end);
  return { proposed, notes: [`${safeFixes} safe fix(es) proposed. ${excluded} unsafe, display-only, or unclassified fix(es) excluded.`,
    "Safety promotion through lint.extend-safe-fixes is disabled for this preview. Native rule selection and unsafe demotions remain effective.",
    "Structured edits are applied once to the captured source. Remaining lint findings are not claimed to be resolved."] };
}

function rejectedPreview(path: string, original: string, execution: ExecutionResult, message: string): TextPreview {
  return { tool: execution.args[0] === "format" ? "ruff-format" : "ruff-fix", path, original, proposed: original,
    execution: { ...execution, outcome: "failed", message: `Preview rejected: ${message}`,
      resourceNotes: [...execution.resourceNotes, "The CLI exit code is preserved. The failed outcome includes adapter preview validation."] },
    notes: [`No edit proposal was produced: ${message}`, "The original source and configuration were not changed."] };
}

/** Return captured text and a non-writing proposal. Rejected entries retain original text and failed execution. */
export async function previewAnalyzer(id: "ruff-format" | "ruff-fix", context: AnalyzerContext): Promise<TextPreview[]> {
  if (id !== "ruff-format" && id !== "ruff-fix") throw new Error(`Unsupported preview analyzer: ${String(id)}`);
  if (context.target.selection !== "exact-files") throw new Error("Previews require exact enumerated files, not directory discovery.");
  const budget = budgetFor(context);
  const files = selectedFiles(context, (file) => (id === "ruff-format" ? FORMAT_EXTENSIONS : RUFF_EXTENSIONS).has(extname(file).toLowerCase()));
  if (!files.length) throw new Error("No applicable source files were selected for the preview.");
  if (files.length > MAX_PREVIEW_FILES) throw new Error(`The ${MAX_PREVIEW_FILES}-file preview limit was exceeded.`);
  const previews: TextPreview[] = [];
  let capturedBytes = 0;
  let proposedBytes = 0;
  const add = (preview: TextPreview) => {
    const bytes = Buffer.byteLength(preview.proposed);
    if (bytes > MAX_PREVIEW_SOURCE_BYTES || capturedBytes + proposedBytes + bytes > MAX_PREVIEW_TOTAL_BYTES) throw new Error("Preview text exceeds the file or aggregate byte bound");
    proposedBytes += bytes;
    previews.push(preview);
  };
  for (const path of files) {
    const reason = stopped(context, budget);
    if (reason) throw new Error(`Preview ${reason} before the next source read`);
    const original = await readSource(path, context.signal, MAX_PREVIEW_SOURCE_BYTES);
    capturedBytes += Buffer.byteLength(original);
    if (capturedBytes + proposedBytes > MAX_PREVIEW_TOTAL_BYTES) throw new Error("Preview text exceeds the aggregate byte bound");
    if (id === "ruff-fix" && extname(path).toLowerCase() === ".ipynb") {
      add(rejectedPreview(path, original,
        syntheticExecution(context, commandFor(id, context), ["check"], "failed", "Notebook fixes require cell-aware edits."),
        "Notebook fix previews require a cell-aware adapter. Cell coordinates are not guessed."));
      continue;
    }
    const args = id === "ruff-format"
      ? ["format", "--no-cache", "--stdin-filename", path, "--", "-"]
      : ["check", "--no-cache", "--no-fix", "--no-fix-only", "--no-unsafe-fixes", "--output-format=json",
        "--config", "lint.extend-safe-fixes=[]", "--stdin-filename", path, "--", "-"];
    const execution = await execute(context, budget, commandFor(id, context), args, original);
    const stop = executionStop(execution);
    const validExit = id === "ruff-format" ? execution.exitCode === 0 : execution.exitCode === 0 || execution.exitCode === 1;
    if (stop || !validExit) {
      add({ tool: id, path, original, proposed: original, execution,
        notes: [`No edit proposal was produced. Analyzer outcome: ${stop ?? "failed"}; exit code: ${String(execution.exitCode)}.`,
          "The source and configuration were not changed."] });
      continue;
    }
    try {
      if (id === "ruff-format") {
        if (!execution.stdout && original.trim()) throw new Error("Formatter returned empty output for nonempty source.");
        add({ tool: id, path, original, proposed: execution.stdout, execution,
          notes: ["Ruff formatted captured stdin and returned stdout. No source or configuration file was written.",
            "--stdin-filename preserves native per-file configuration and target-version discovery."] });
      } else {
        const parsed = parseOutput(execution);
        if (parsed.error) throw new Error(parsed.error);
        const fixed = applySafeFixes(original, parsed.raw, path, context.target.cwd);
        add({ tool: id, path, original, proposed: fixed.proposed, execution, notes: [...fixed.notes,
          "Ruff linted captured stdin with --stdin-filename. No source or configuration file was written."] });
      }
    } catch (error) { add(rejectedPreview(path, original, execution, String(error))); }
  }
  return previews;
}
