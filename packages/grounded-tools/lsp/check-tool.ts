import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boundedOutput } from "@grounded/pi-core/output";
import { analyzerIds, previewAnalyzer, runAnalyzer } from "./check-analyzers.ts";
import { documentAnalyzerIds, runDocumentAnalyzer } from "./check-documents.ts";
import { discoverCommands, resolveEnvironment, resolveTarget, splitPythonTargets } from "./check-project.ts";
import { inside, textPreviewProposal, type EditProposal } from "./check-preview.ts";
import { CheckRuntime } from "./check-runtime.ts";
import type { AnalyzerContext, CheckOutcome, CheckResult, CheckScope, CheckTarget, Finding, ToolAvailability } from "./check-types.ts";

interface CheckConfig {
  commands: Record<string, string>;
  disabledChecks: string[];
  timeoutMs: number;
  pythonPath?: string;
  configuration: Record<string, unknown>;
}

const BUILTIN = new Set(["json", "yaml", "toml", "markdown"]);
const DEFAULT_COMMANDS: Record<string, string> = { pyright: "pyright", ruff: "ruff", vale: "vale", shellcheck: "shellcheck" };
const ids = () => [...analyzerIds, ...documentAnalyzerIds];
const ChecksParams = Type.Object({
  action: StringEnum(["status", "discover", "run", "preview"] as const),
  path: Type.Optional(Type.String({ description: "Local file or project directory. Defaults to the caller working directory for project scopes." })),
  scope: Type.Optional(StringEnum(["file", "changed", "package", "workspace"] as const)),
  baseRef: Type.Optional(Type.String({ description: "Changed scope only. Git revision to compare with the working tree, plus untracked files." })),
  checks: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 8, description: "Explicit analyzer IDs from discover. Preview supports one ruff-format or ruff-fix selection." })),
  commandId: Type.Optional(Type.String({ description: "Exact native command ID from discover. Native scripts can write files and use the network." })),
  fingerprint: Type.Optional(Type.String({ description: "Required for native command execution. Must match the current discovery fingerprint." })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 300000, description: "Whole run budget, default 60000 ms. Owned process cleanup can finish after the deadline." })),
  allowNetwork: Type.Optional(Type.Boolean({ description: "Explicit network-check intent, default false. External-link checking is currently unsupported. This is not a subprocess network sandbox." })),
}, { additionalProperties: false });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function json(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!record(value)) throw new Error("Expected an object");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid check configuration ${path}: ${String(error)}`);
  }
}

async function loadConfig(ctx: ExtensionContext): Promise<CheckConfig> {
  const global = await json(join(getAgentDir(), "grounded-tools", "checks.json")) ?? {};
  const project = ctx.isProjectTrusted() ? await json(join(ctx.cwd, CONFIG_DIR_NAME, "grounded-checks.json")) ?? {} : {};
  const merged = { ...global, ...project };
  const commands = { ...DEFAULT_COMMANDS };
  for (const layer of [global, project]) {
    if (layer.commands === undefined) continue;
    if (!record(layer.commands)) throw new Error("Check commands must be an executable-name/path map, not shell expressions");
    for (const [id, value] of Object.entries(layer.commands)) {
      if (typeof value !== "string" || !value || value.includes("\0")) throw new Error(`Invalid check executable for ${id}`);
      commands[id] = value.startsWith("~") ? value.replace(/^~(?=$|[/\\])/, process.env.HOME ?? "~") : value;
    }
  }
  const timeoutMs = typeof merged.timeoutMs === "number" && Number.isInteger(merged.timeoutMs) ? Math.max(100, Math.min(300000, merged.timeoutMs)) : 60000;
  const disabledChecks = Array.isArray(merged.disabledChecks) ? merged.disabledChecks.filter((id): id is string => typeof id === "string") : [];
  const pythonPath = typeof merged.pythonPath === "string" ? merged.pythonPath : undefined;
  const configuration = record(merged.configuration) ? merged.configuration : {};
  return { commands, disabledChecks, timeoutMs, pythonPath, configuration };
}

// Exact duplicate observations can share provenance. Different rule IDs, kinds,
// severities, locations or messages remain distinct; no fuzzy suppression occurs.
function consolidate(results: CheckResult[]): Finding[] {
  const values = new Map<string, Finding>();
  for (const result of results) for (const finding of result.findings) {
    const key = JSON.stringify([finding.kind, finding.file, finding.line, finding.column, finding.endLine, finding.endColumn, finding.columnEncoding, finding.severity, finding.code, finding.message]);
    const previous = values.get(key);
    if (previous) previous.sources = [...new Set([...(previous.sources ?? [previous.tool]), ...(finding.sources ?? [finding.tool])])];
    else values.set(key, { ...finding, sources: finding.sources ?? [finding.tool] });
  }
  return [...values.values()];
}

function incomplete(tool: string, context: AnalyzerContext, outcome: CheckOutcome, message: string): CheckResult {
  return { tool, kind: tool === "pyright" ? "type" : tool === "ruff-format" ? "format" : tool === "markdown" ? "markdown" : tool === "vale" ? "prose" : tool === "links-network" ? "links" : ["json", "yaml", "toml"].includes(tool) ? "syntax" : "lint", scope: context.target.scope, outcome, completed: false,
    findings: [], target: context.target, environment: context.environment, notes: [message] };
}

async function admit(ctx: ExtensionContext, target: CheckTarget): Promise<void> {
  if (!ctx.isProjectTrusted()) throw new Error("Checks execute project-aware tools. Trust the caller project first. Discovery remains read-only.");
  const root = await realpath(ctx.cwd);
  for (const path of new Set([target.cwd, target.path, ...target.files, ...target.targets])) {
    if (!inside(root, await realpath(path))) throw new Error("The selected check path is outside the trusted caller directory. Start Pi in the intended project instead.");
  }
}

async function present(value: Record<string, unknown>) {
  const bounded = await boundedOutput(JSON.stringify(value, null, 2), { prefix: "grounded-check", direction: "head", maxBytes: 32768, maxLines: 1000 });
  return { content: [{ type: "text" as const, text: bounded.text }], details: { ...value, fullOutputPath: bounded.fullOutputPath } };
}

export function registerChecks(pi: ExtensionAPI) {
  const runtime = new CheckRuntime();
  const exercised = new Map<string, CheckOutcome>();
  let requests = 0;

  async function availability(config: CheckConfig, cwd: string): Promise<ToolAvailability[]> {
    return Promise.all(ids().map(async (id) => {
      const command = config.commands[id === "ruff-format" ? "ruff" : id];
      const builtIn = BUILTIN.has(id);
      const available = builtIn ? { available: true, path: undefined } : command ? await runtime.available(command, cwd) : { available: false, path: undefined };
      return {
        id, configured: !config.disabledChecks.includes(id) && (builtIn || !!command), command,
        executableAvailable: available.available, resolvedExecutable: available.path,
        exercised: exercised.has(id), lastOutcome: exercised.get(id),
        notes: [builtIn ? "Bundled parser/check policy; availability is not successful exercise." : "Executable availability is not version, dependency, configuration or project readiness.",
          "Exercised state covers completed runs in this loaded session only. It is not a workspace pass."],
      };
    }));
  }

  pi.registerTool({
    name: "check", label: "Project checks",
    description: "Discover existing native project commands without running them, or explicitly run complementary analyzers and native build/test/lint commands. Reports exact scope, environment, completion, exits, cancellation, timeouts, findings and retained logs. Checks require a trusted local caller project. Ruff format/safe-fix previews never edit source. Native commands may write files or use the network.",
    promptSnippet: "Discover and run scoped project checks, or request non-writing Ruff previews",
    promptGuidelines: ["Use check discover before a native run; send its exact command ID and fingerprint. Do not invent file arguments for package scripts.", "Keep Pyright type checking, Ruff lint, formatting, syntax, schema and prose checks distinct. A file result is not a workspace pass.", "Apply preview proposals only through an explicit stale-safe edit action after reviewing the patch."],
    parameters: ChecksParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const config = await loadConfig(ctx);
      if (params.action === "status") return present({ schemaVersion: 1, runtime: runtime.status(), analyzers: await availability(config, ctx.cwd), activeRequests: requests,
        limits: { requests: 2, maxFiles: 512 }, network: "No external-link checker is implemented. Native tools and scripts are not network-isolated.", localOnly: true });
      if (requests >= 2) return present({ outcome: "busy", completed: false, message: "Two check requests are active; no work was queued." });
      requests++;
      const controller = new AbortController();
      const budget = params.timeoutMs ?? config.timeoutMs;
      const started = Date.now();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(new Error("Whole check request budget expired")), budget);
      const scope: CheckScope = params.scope ?? (params.action === "discover" ? "package" : "file");
      try {
        const enumerateData = params.action === "run" && !params.commandId && params.checks?.some((id) => BUILTIN.has(id) || id === "vale") === true;
        const target = await resolveTarget({ cwd: ctx.cwd, path: params.path, scope, baseRef: params.baseRef, signal: combined, enumerateData });
        const environment = await resolveEnvironment(target, { pythonPath: config.pythonPath });
        if (combined.aborted) return present({ action: params.action, completed: false, outcome: signal?.aborted ? "cancelled" : "timeout", target, environment, notes: ["The request ended during target/environment resolution; no analyzer or native command was started"] });
        const commands = await discoverCommands(target);
        const availabilityRows = await availability(config, target.cwd);
        if (params.action === "discover") return present({ schemaVersion: 1, target, environment, commands, analyzers: availabilityRows, trustedCaller: ctx.isProjectTrusted(), discoveryOnly: true,
          notes: ["Discovery did not execute project declarations. Conventional names do not guarantee read-only or network-free scripts.", "A discovered root does not grant trust. File and changed scope are not forwarded to native package scripts.", "LSP publication observations remain a separate lsp interface with unknown analysis completion."] });
        await admit(ctx, target);
        // Dependencies used for Markdown anchor indexes must stay within the
        // caller's admitted directory even when Git reports an outer root.
        if (!inside(await realpath(ctx.cwd), await realpath(target.root))) target.root = await realpath(ctx.cwd);
        const context: AnalyzerContext = { target, environment, execute: (request) => runtime.execute(request), timeoutMs: Math.max(1, budget - (Date.now() - started)), signal: combined, commands: config.commands,
          configuration: config.configuration, allowNetwork: params.allowNetwork ?? false };
        if (params.action === "preview") {
          if (params.commandId || params.checks?.length !== 1 || !["ruff-format", "ruff-fix"].includes(params.checks[0]!)) throw new Error("Preview requires one ruff-format or ruff-fix check and no native command");
          if (config.disabledChecks.includes(params.checks[0]!) || (params.checks[0] === "ruff-fix" && config.disabledChecks.includes("ruff"))) throw new Error("Requested preview is disabled");
          const previews = await previewAnalyzer(params.checks[0]! as "ruff-format" | "ruff-fix", context);
          const proposals: EditProposal[] = [];
          for (const preview of previews) {
            if (preview.execution && preview.execution.outcome !== "completed") continue;
            const proposal = await textPreviewProposal(preview, ctx.cwd);
            if (proposal) proposals.push(proposal);
          }
          return present({ schemaVersion: 1, action: "preview", previewOnly: true, sourceModified: false,
            completed: previews.length > 0 && previews.every((preview) => preview.execution?.outcome === "completed" && (preview.execution.exitCode === 0 || (preview.tool === "ruff-fix" && preview.execution.exitCode === 1))),
            requestOutcome: combined.aborted ? signal?.aborted ? "cancelled" : "timeout" : "finished", budgetMs: budget,
            target, environment, proposals,
            observations: previews.map(({ original: _original, proposed: _proposed, ...rest }) => rest),
            notes: ["Review each patch. Apply proposals explicitly through edit. Multi-file application is not atomic.", "A preview is not an accepted fix or proof that every check passes."] });
        }
        const results: CheckResult[] = [];
        if (params.commandId) {
          if (params.checks?.length) throw new Error("Select a native command or analyzer IDs, not both");
          const command = commands.find((item) => item.id === params.commandId);
          if (!command || !params.fingerprint || params.fingerprint !== command.fingerprint) throw new Error("Native command declaration changed or fingerprint is missing. Discover again before running.");
          if (!command.scopes.includes(scope)) throw new Error(`Native command does not support ${scope} scope. No file arguments were invented.`);
          if (command.id.startsWith("python:pytest:") && !environment.pythonPath) return present({ schemaVersion: 1, action: "run", completed: false,
            results: [{ ...incomplete(command.id, context, "unavailable", "The native Python interpreter is unavailable; no fallback command was run"), kind: command.kind }], findings: [] });
          const executable = command.id.startsWith("python:pytest:") ? environment.pythonPath!
            : ["ruff", "pyright"].includes(command.command) ? config.commands[command.command] ?? command.command : command.command;
          const execution = await runtime.execute({ command: executable, args: command.args, cwd: command.cwd, timeoutMs: context.timeoutMs, signal: combined, resourceClass: "expensive" });
          results.push({ tool: command.id, kind: command.kind, scope, outcome: execution.outcome === "completed" ? execution.exitCode === 0 ? "passed" : "failed" : execution.outcome,
            completed: execution.outcome === "completed", findings: [], target, environment: { ...environment, cwd: command.cwd }, execution, notes: [...command.notes, "Native Python uses the resolved interpreter. Built-in Ruff/Pyright candidates use configured analyzer executables. Execution records the actual command.", "Native output is retained verbatim, not guessed into compiler diagnostics. Completion describes this command and selected project scope only."] });
        } else {
          if (!params.checks?.length) throw new Error("Run requires explicit checks or a discovered native command ID and fingerprint");
          for (const id of new Set(params.checks)) {
            context.timeoutMs = Math.max(1, budget - (Date.now() - started));
            if (combined.aborted) { results.push(incomplete(id, context, signal?.aborted ? "cancelled" : "timeout", "No check started after the request ended")); continue; }
            if (config.disabledChecks.includes(id)) { results.push(incomplete(id, context, "skipped", "Check disabled by configuration")); continue; }
            if (!(ids() as readonly string[]).includes(id)) { results.push(incomplete(id, context, "unsupported", "Unknown analyzer ID")); continue; }
            const targets = id === "pyright" ? await splitPythonTargets(target, combined) : [target];
            if (!targets.length) { results.push(incomplete(id, context, "skipped", "No Python files were selected")); continue; }
            for (const selected of targets) {
              const selectedContext: AnalyzerContext = { ...context, target: selected,
                environment: selected === target ? environment : await resolveEnvironment(selected, { pythonPath: config.pythonPath }),
                timeoutMs: Math.max(1, budget - (Date.now() - started)) };
              if (combined.aborted) { results.push(incomplete(id, selectedContext, signal?.aborted ? "cancelled" : "timeout", "No check started after the request ended")); continue; }
              const result = (documentAnalyzerIds as readonly string[]).includes(id) ? await runDocumentAnalyzer(id, selectedContext) : await runAnalyzer(id, selectedContext);
              if (controller.signal.aborted && !signal?.aborted && result.outcome === "cancelled") {
                result.outcome = "timeout";
                result.notes.push("The whole request budget expired. The internal abort was a timeout, not caller cancellation.");
              }
              results.push(result);
              if (result.completed) exercised.set(id, result.outcome);
            }
          }
        }
        const completed = results.length > 0 && results.every((result) => result.completed);
        return present({ schemaVersion: 1, action: "run", completed, requestOutcome: combined.aborted ? signal?.aborted ? "cancelled" : "timeout" : "finished", budgetMs: budget, results, findings: consolidate(results),
          notes: ["Per-check completion and scope are authoritative. No result covers unselected tools or files.", "Syntax parsing does not select or validate a schema. Use configured language servers or native schema checks separately."] });
      } finally {
        clearTimeout(timer);
        requests--;
      }
    },
  });
  return { shutdown: () => runtime.shutdown(), status: () => runtime.status() };
}
