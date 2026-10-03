import { access, readFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, parse, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LspClient, LspRequestTimeout, throwIfLspAborted, type LspClientOptions, type LspDiagnostic, type LspDiagnosticResult, type LspServerConfig } from "@grounded/pi-core/lsp-client";
import { boundedOutput } from "@grounded/pi-core/output";
import { resolveToolPath } from "@grounded/pi-core/paths";
import { createRustLauncher, isRustServer, RustLaunchError, rustLauncherAvailability } from "./rust-launch.ts";

const DEFAULT_SERVERS: LspServerConfig[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    languageId: "typescript",
    languageIds: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
  },
  {
    id: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    languageId: "python",
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt", ".git"],
  },
  {
    id: "gopls",
    command: "gopls",
    args: [],
    extensions: [".go"],
    languageId: "go",
    rootMarkers: ["go.work", "go.mod", ".git"],
  },
  {
    id: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    languageId: "rust",
    rootMarkers: ["Cargo.toml", ".git"],
  },
  {
    id: "clangd",
    command: "clangd",
    args: [],
    extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"],
    languageId: "cpp",
    rootMarkers: ["compile_commands.json", "compile_flags.txt", "CMakeLists.txt", ".git"],
  },
];

interface LspPolicy {
  automaticDiagnostics: boolean;
  idleTimeoutMs: number;
  diagnosticTimeoutMs: number;
}

interface ProjectLspConfig extends Partial<LspPolicy> {
  disabledServers?: string[];
}

interface LoadedConfig {
  servers: LspServerConfig[];
  project: ProjectLspConfig;
  policy: LspPolicy;
}

function policyOverrides(raw: unknown): Partial<LspPolicy> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Partial<LspPolicy>;
  const bounded = (number: unknown, min: number, max: number): number | undefined =>
    typeof number === "number" && Number.isFinite(number) && Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : undefined;
  const idleTimeoutMs = bounded(value.idleTimeoutMs, 1000, 300000);
  const diagnosticTimeoutMs = bounded(value.diagnosticTimeoutMs, 100, 30000);
  return {
    ...(typeof value.automaticDiagnostics === "boolean" ? { automaticDiagnostics: value.automaticDiagnostics } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(diagnosticTimeoutMs !== undefined ? { diagnosticTimeoutMs } : {}),
  };
}

const LspParams = Type.Object({
  action: StringEnum(["status", "diagnostics", "hover", "definition", "references", "rename_preview"] as const),
  path: Type.Optional(Type.String({ description: "File path" })),
  line: Type.Optional(Type.Number({ minimum: 1, description: "1-based line" })),
  character: Type.Optional(Type.Number({ minimum: 0, description: "0-based UTF-16 character offset" })),
  newName: Type.Optional(Type.String({ description: "Replacement identifier for rename_preview" })),
});

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid LSP config ${path}: ${String(error)}`);
  }
}

function validServer(value: unknown): value is LspServerConfig {
  if (!value || typeof value !== "object") return false;
  const server = value as Partial<LspServerConfig>;
  return typeof server.id === "string" && server.id.length > 0
    && typeof server.command === "string" && server.command.length > 0
    && Array.isArray(server.args) && server.args.every((item) => typeof item === "string")
    && Array.isArray(server.extensions) && server.extensions.every((item) => typeof item === "string")
    && typeof server.languageId === "string" && server.languageId.length > 0
    && (server.languageIds === undefined || (server.languageIds !== null
      && typeof server.languageIds === "object" && !Array.isArray(server.languageIds)
      && Object.entries(server.languageIds).every(([extension, languageId]) =>
        /^\.[^./\\]+$/.test(extension) && extension === extension.toLowerCase()
        && typeof languageId === "string" && languageId.length > 0)))
    && Array.isArray(server.rootMarkers) && server.rootMarkers.every((item) => typeof item === "string")
    && (server.timeoutMs === undefined || (typeof server.timeoutMs === "number" && Number.isFinite(server.timeoutMs)));
}

async function loadConfig(ctx: ExtensionContext): Promise<LoadedConfig> {
  const globalPath = join(getAgentDir(), "grounded-tools", "lsp.json");
  const global = await readJson(globalPath) as { servers?: unknown[] } | undefined;
  const custom = Array.isArray(global?.servers) ? global.servers.filter(validServer) : [];
  const byId = new Map(DEFAULT_SERVERS.map((server) => [server.id, server]));
  for (const server of custom) byId.set(server.id, server);

  let project: ProjectLspConfig = {};
  if (ctx.isProjectTrusted()) {
    const path = join(ctx.cwd, CONFIG_DIR_NAME, "grounded-lsp.json");
    const raw = await readJson(path);
    if (raw && typeof raw === "object") {
      const value = raw as ProjectLspConfig;
      project = {
        ...(Array.isArray(value.disabledServers)
          ? { disabledServers: value.disabledServers.filter((item): item is string => typeof item === "string") }
          : {}),
        ...policyOverrides(value),
      };
    }
  }
  return {
    servers: [...byId.values()], project,
    policy: { automaticDiagnostics: false, idleTimeoutMs: 60000, diagnosticTimeoutMs: 3000, ...policyOverrides(global), ...policyOverrides(project) },
  };
}

async function executable(command: string, signal?: AbortSignal): Promise<boolean> {
  throwIfLspAborted(signal);
  if (isAbsolute(command)) return access(command).then(() => true, () => false);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const suffix of extensions) {
      throwIfLspAborted(signal);
      if (await access(join(directory, `${command}${suffix}`)).then(() => true, () => false)) return true;
    }
  }
  return false;
}

async function findRoot(path: string, cwd: string, markers: string[], signal?: AbortSignal): Promise<string> {
  let current = dirname(path);
  const filesystemRoot = parse(current).root;
  while (true) {
    for (const marker of markers) {
      throwIfLspAborted(signal);
      if (await access(join(current, marker)).then(() => true, () => false)) return current;
    }
    if (current === filesystemRoot) return resolve(cwd);
    current = dirname(current);
  }
}

function severityLabel(severity?: number): string {
  return severity === 1 ? "error" : severity === 2 ? "warning" : severity === 3 ? "info" : "hint";
}

function formatDiagnostics(path: string, diagnostics: LspDiagnostic[]): string {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === undefined || diagnostic.severity <= 2)
    .map((diagnostic) => {
      const code = diagnostic.code === undefined ? "" : ` [${diagnostic.code}]`;
      const source = diagnostic.source ? ` ${diagnostic.source}` : "";
      return `${severityLabel(diagnostic.severity)} ${path}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}${code}${source}: ${diagnostic.message}`;
    })
    .join("\n");
}

function diagnosticSucceeded(result: LspDiagnosticResult): boolean {
  return result.outcome === "published" || (result.outcome === "cached" && result.freshness === "version-matched");
}

function diagnosticText(path: string, result: LspDiagnosticResult): string {
  let summary: string;
  if (result.outcome === "published" && result.freshness === "version-matched") {
    summary = "Latest version-matched LSP publication. Analysis completion is unknown.";
  } else if (result.outcome === "published") {
    summary = "Latest unversioned LSP publication. The analyzed document version and analysis completion are unknown.";
  } else if (result.outcome === "timeout") {
    summary = `LSP diagnostic wait timed out after ${result.waitedMs} ms. A current-version check is not confirmed. Any listed diagnostics are cached.`;
  } else if (result.outcome === "pending") {
    summary = "LSP diagnostics are pending. A current-version check is not confirmed. Any listed diagnostics are cached.";
  } else {
    summary = `Cached LSP diagnostics (${result.freshness}). A new current-version check and analysis completion are not confirmed.`;
  }
  const diagnostics = formatDiagnostics(path, result.diagnostics);
  if (diagnostics) return `${summary}\n${diagnostics}`;
  if (result.outcome === "published" && result.freshness === "version-matched") {
    return "No errors or warnings in the latest version-matched LSP publication. Analysis completion is unknown.";
  }
  return `${summary}\nNo errors or warnings in this ${result.outcome === "published" ? "unversioned publication" : "snapshot"}. This is not a confirmed clean check.`;
}

interface OperationResult<T> {
  value: T;
  successful: boolean;
  failureReason?: string;
}

interface ClientRecord {
  key: string;
  client: LspClient;
  active: number;
  retiring: boolean;
  expiresAt?: number;
  timer?: NodeJS.Timeout;
}

const RUST_REUSE_MS = 60_000;

interface Runtime {
  now: () => number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  launchRust: NonNullable<LspClientOptions["launch"]>;
  clientOptions?: Pick<LspClientOptions, "stopTimeouts">;
}

interface RustRecord {
  key: string;
  client: LspClient;
  active: boolean;
  retiring: boolean;
  expiresAt: number;
  timer?: NodeJS.Timeout;
}

class LspNoCheck extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) { super(message); this.reason = reason; }
  details() { return { outcome: "skipped", checked: false, reason: this.reason, message: this.message, analysisComplete: "unknown" }; }
}

class LspManager {
  private config?: LoadedConfig;
  private clients = new Map<string, ClientRecord>();
  private unavailable = new Map<string, string>();
  private rust?: RustRecord;
  private lastRust?: { reason: string; message: string };
  private closing = false;
  private runtime: Runtime;

  constructor(runtime: Runtime) { this.runtime = runtime; }

  async configure(ctx: ExtensionContext): Promise<void> {
    this.config = await loadConfig(ctx);
    this.closing = false;
  }

  get automaticDiagnostics(): boolean { return this.config?.policy.automaticDiagnostics ?? false; }
  get diagnosticTimeoutMs(): number { return this.config?.policy.diagnosticTimeoutMs ?? 3000; }

  async use<T>(path: string, ctx: ExtensionContext, mode: "automatic" | "explicit", operation: (client: LspClient) => Promise<OperationResult<T>>, options: { cwd?: string; signal?: AbortSignal } = {}): Promise<T | undefined> {
    const { signal } = options;
    throwIfLspAborted(signal);
    if (!this.config) await this.configure(ctx);
    if (mode === "automatic" && !this.automaticDiagnostics) return undefined;
    const ext = extname(path).toLowerCase();
    const server = this.config!.servers.find((candidate) => candidate.extensions.includes(ext));
    if (!server || this.config!.project.disabledServers?.includes(server.id)) return undefined;
    const root = await findRoot(path, options.cwd ?? ctx.cwd, server.rootMarkers, signal);
    throwIfLspAborted(signal);
    if (this.closing) throw new LspNoCheck("stopping", "LSP is stopping for session shutdown");
    const key = `${server.id}\0${root}`;
    if (isRustServer(server)) return this.useRust(key, server, root, mode, operation, signal);
    if (this.unavailable.has(server.id)) return undefined;
    if (!(await executable(server.command, signal))) {
      this.unavailable.set(server.id, `${server.command} not found on PATH`);
      return undefined;
    }
    throwIfLspAborted(signal);
    if (this.closing) throw new LspNoCheck("stopping", "LSP is stopping for session shutdown");
    let record = this.clients.get(key);
    if (record?.retiring || record?.client.state === "stopping") throw new LspNoCheck("stopping", "LSP child close is pending; ownership is retained");
    if (!record) {
      const client = new LspClient(server, root, {
        ...this.runtime.clientOptions,
        onClose: () => {
          const current = this.clients.get(key);
          if (!current || current.client !== client) return;
          if (current.timer) this.runtime.clearTimer(current.timer);
          current.timer = undefined;
          if (current.active === 0) this.clients.delete(key);
        },
      });
      record = { key, client, active: 0, retiring: false };
      this.clients.set(key, record);
    }
    if (record.timer) this.runtime.clearTimer(record.timer);
    record.timer = undefined;
    record.expiresAt = undefined;
    record.active++;
    try {
      const result = await operation(record.client);
      throwIfLspAborted(signal);
      return result.value;
    }
    finally {
      record.active--;
      if (this.clients.get(key) === record && record.active === 0) {
        if (record.client.state === "stopped") this.clients.delete(key);
        else if (this.closing || record.client.state === "stopping") await this.retireClient(record);
        else {
          const owned = record;
          const idleTimeoutMs = this.config!.policy.idleTimeoutMs;
          owned.expiresAt = this.runtime.now() + idleTimeoutMs;
          owned.timer = this.runtime.setTimer(() => {
            owned.timer = undefined;
            if (this.clients.get(key) === owned && owned.active === 0 && this.runtime.now() >= owned.expiresAt!) void this.retireClient(owned);
          }, idleTimeoutMs);
          owned.timer.unref?.();
        }
      }
    }
  }

  private async retireClient(record: ClientRecord): Promise<void> {
    record.retiring = true;
    if (record.timer) this.runtime.clearTimer(record.timer);
    record.timer = undefined;
    await record.client.stop();
    if (this.clients.get(record.key) === record && record.client.state === "stopped") this.clients.delete(record.key);
  }

  private noCheck(reason: string, message: string): never {
    this.lastRust = { reason, message };
    throw new LspNoCheck(reason, message);
  }

  private async retire(record: RustRecord, reason: string): Promise<void> {
    record.retiring = true;
    if (record.timer) this.runtime.clearTimer(record.timer);
    record.timer = undefined;
    this.lastRust = { reason, message: `Rust client ${reason}` };
    await record.client.stop();
    if (this.rust === record && record.client.state === "stopped") this.rust = undefined;
    else if (this.rust === record) this.lastRust = { reason: "stopping", message: "Rust child close is unconfirmed; ownership is retained" };
  }

  private async useRust<T>(key: string, config: LspServerConfig, root: string, mode: "automatic" | "explicit", operation: (client: LspClient) => Promise<OperationResult<T>>, signal?: AbortSignal): Promise<T> {
    let record = this.rust;
    if (record?.active) this.noCheck("request-active", "Rust was not checked: a local Rust operation is active");
    if (record?.retiring || record?.client.state === "stopping") this.noCheck("stopping", "Rust was not checked: child shutdown is pending");
    if (record && (!record.client.ready || this.runtime.now() >= record.expiresAt)) {
      await this.retire(record, "expired");
      if (this.rust) this.noCheck("stopping", "Rust was not checked: child close is unconfirmed");
      record = undefined;
      if (mode === "automatic") this.noCheck("expired", "Rust was not checked: the explicit-use window expired; use the lsp tool explicitly");
    }
    if (record && record.key !== key) this.noCheck("busy", "Rust was not checked: another local root owns the Rust slot");
    if (!record && mode === "automatic") this.noCheck("explicit-start-required", "Rust was not checked: automatic cold start and restart are disabled; use the lsp tool explicitly");
    if (this.closing) this.noCheck("stopping", "Rust is stopping for session shutdown");
    if (!record) {
      const client = new LspClient(config, root, {
        ...this.runtime.clientOptions,
        launch: this.runtime.launchRust,
        onClose: (reason) => {
          const current = this.rust;
          if (!current || current.client !== client) return;
          if (current.timer) this.runtime.clearTimer(current.timer);
          current.timer = undefined;
          this.lastRust = { reason: "stopped", message: reason };
          if (!current.active) this.rust = undefined;
        },
      });
      record = { key, client, active: false, retiring: false, expiresAt: 0 };
      this.rust = record;
    }
    record.active = true;
    let succeeded = false;
    try {
      const result = await operation(record.client);
      throwIfLspAborted(signal);
      succeeded = result.successful;
      if (!succeeded && result.failureReason) this.lastRust = { reason: result.failureReason, message: `Rust diagnostics ${result.failureReason}; the explicit-use window was not renewed` };
      return result.value;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.lastRust = { reason: "cancelled", message: "Rust operation cancelled; the explicit-use window was not renewed" };
        throw error;
      }
      const reason = error instanceof RustLaunchError ? error.reason : error instanceof LspRequestTimeout ? "timeout" : "unavailable";
      return this.noCheck(reason, `Rust was not checked: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      record.active = false;
      if (succeeded && mode === "explicit" && record.client.ready && !this.closing) {
        record.expiresAt = this.runtime.now() + RUST_REUSE_MS;
        this.lastRust = { reason: "ready", message: "Rust is warm after explicit use" };
        if (record.timer) this.runtime.clearTimer(record.timer);
        const owned = record;
        record.timer = this.runtime.setTimer(() => {
          owned.timer = undefined;
          if (this.rust === owned && !owned.active) void this.retire(owned, "expired");
        }, RUST_REUSE_MS);
        record.timer.unref?.();
      } else if (!record.client.ready || this.runtime.now() >= record.expiresAt || this.closing) {
        const outcome = this.lastRust;
        await this.retire(record, this.closing ? "session-shutdown" : "expired");
        if (!succeeded && record.client.state === "stopped") this.lastRust = outcome;
      }
    }
  }

  status(): unknown {
    return {
      configured: this.config?.servers.map((server) => ({
        id: server.id,
        command: server.command,
        rustPolicy: isRustServer(server),
        disabled: this.config?.project.disabledServers?.includes(server.id) ?? false,
        unavailable: this.unavailable.get(server.id),
      })) ?? [],
      policy: this.config?.policy ?? { automaticDiagnostics: false, idleTimeoutMs: 60000, diagnosticTimeoutMs: 3000 },
      readiness: "ready means initialized transport; workspace analysis completion is unknown",
      running: [
        ...[...this.clients.values()].map((record) => ({ key: record.key, client: record.client, active: record.active, expiresAt: record.expiresAt, retiring: record.retiring })),
        ...(this.rust ? [{ key: this.rust.key, client: this.rust.client, active: this.rust.active ? 1 : 0, expiresAt: this.rust.expiresAt, retiring: this.rust.retiring }] : []),
      ].map(({ client, ...record }) => ({ ...record, running: client.running, state: client.state, stderr: client.recentStderr })),
      rust: {
        automatic: "warm-only", reuseWindowMs: RUST_REUSE_MS, slots: 1,
        platform: process.platform, launcher: rustLauncherAvailability(),
        localState: this.rust?.client.state ?? "stopped", active: this.rust?.active ?? false,
        expiresAt: this.rust?.expiresAt, lastOutcome: this.lastRust,
        sharedAvailability: "unknown until admission; local state is not a fleet census",
      },
    };
  }

  allDiagnostics(): Array<LspDiagnosticResult & { server: string }> {
    return [...[...this.clients.values()].map((record) => [record.key, record.client] as const), ...(this.rust ? [[this.rust.key, this.rust.client] as const] : [])].flatMap(([server, client]) =>
      client.allDiagnostics().map((entry) => ({ server, ...entry })),
    );
  }

  async stop(): Promise<void> {
    this.closing = true;
    const rust = this.rust;
    if (rust?.timer) this.runtime.clearTimer(rust.timer);
    await Promise.all([
      ...[...this.clients.values()].map((record) => this.retireClient(record)),
      ...(rust ? [this.retire(rust, "session-shutdown")] : []),
    ]);
  }
}

export default function groundedLsp(pi: ExtensionAPI) {
  registerGroundedLsp(pi);
}

// Tests register the actual tool and hooks with isolated launch/clock seams.
// Pi always calls the default factory with the fixed production policy.
export function registerGroundedLsp(pi: ExtensionAPI, fixture: Partial<Runtime> = {}) {
  const manager = new LspManager({ now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout, launchRust: createRustLauncher(), ...fixture });

  pi.on("session_start", async (_event, ctx) => manager.configure(ctx));
  pi.on("session_shutdown", async () => manager.stop());

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !["edit", "write", "grounded_edit", "grounded_write"].includes(event.toolName) || !manager.automaticDiagnostics) return;
    const input = event.input as { path?: unknown; sessionId?: unknown };
    if (typeof input.path !== "string") return;
    const displayPath = input.path;
    const signal = ctx.signal;
    const details = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details as Record<string, unknown> : {};
    const skipped = (reason: string, message: string, outcome = "skipped") => ({
      content: [...event.content, { type: "text" as const, text: message }],
      details: { ...details, groundedLsp: { outcome, checked: false, reason, message, analysisComplete: "unknown" } },
    });
    if (details.sessionBackend === "ssh") return skipped("remote-session-unsupported", "LSP was not checked: SSH session files are unsupported; no local file was analyzed.");
    let cwd = ctx.cwd;
    if (input.sessionId !== undefined) {
      if (typeof input.sessionId !== "string" || details.sessionId !== input.sessionId || details.sessionBackend !== "local" || typeof details.sessionCwd !== "string" || !isAbsolute(details.sessionCwd)) {
        return skipped("session-metadata-missing", "LSP was not checked: confirmed local session path metadata is missing or inconsistent.");
      }
      cwd = details.sessionCwd;
    } else if (details.sessionBackend !== undefined && details.sessionBackend !== "local") {
      return skipped("session-metadata-missing", "LSP was not checked: the file result has an unknown session backend.");
    }
    const path = resolveToolPath(cwd, displayPath);
    try {
      return await manager.use(path, ctx, "automatic", async (client) => {
        const ticket = await client.open(path, undefined, { saved: true, signal });
        const observation = await client.waitForDiagnostics(ticket, manager.diagnosticTimeoutMs, signal);
        const bounded = await boundedOutput(diagnosticText(displayPath, observation), { prefix: "grounded-lsp-diagnostics", direction: "head" });
        throwIfLspAborted(signal);
        return {
          successful: diagnosticSucceeded(observation), failureReason: observation.outcome,
          value: {
            content: [...event.content, { type: "text" as const, text: `LSP diagnostics after ${event.toolName}:\n${bounded.text}` }],
            details: { ...details, groundedLsp: { ...observation, effectivePath: path, effectiveCwd: cwd, fullOutputPath: bounded.fullOutputPath } },
          },
        };
      }, { cwd, signal });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return skipped("cancelled", "LSP check cancelled. The file save succeeded, but no LSP check completed.", "cancelled");
      if (error instanceof LspNoCheck) return {
        content: [...event.content, { type: "text" as const, text: error.message }],
        details: { ...details, groundedLsp: error.details() },
      };
      return { details: { ...details, groundedLsp: { outcome: "skipped", checked: false, reason: "unavailable", error: String(error), analysisComplete: "unknown" } } };
    }
  });

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: "Request language-server diagnostics with freshness metadata, hover, definition, references, or a non-applying rename preview. Automatic edit/write checks are opt-in. Rust automatic checks only reuse an explicitly started warm server for up to 60 seconds. Push diagnostics do not confirm analysis completion.",
    promptSnippet: "Inspect language-aware diagnostics and navigation without automatic formatting or edits",
    promptGuidelines: ["Use lsp rename_preview before applying a multi-file rename; it never writes files."],
    parameters: LspParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      throwIfLspAborted(signal);
      if (params.action === "status") {
        return { content: [{ type: "text", text: JSON.stringify(manager.status(), null, 2) }], details: manager.status() };
      }
      if (params.action === "diagnostics" && !params.path) {
        const diagnostics = manager.allDiagnostics();
        const bounded = await boundedOutput(JSON.stringify(diagnostics, null, 2), { prefix: "grounded-lsp-diagnostics", direction: "head" });
        return { content: [{ type: "text", text: bounded.text }], details: { diagnostics, fullOutputPath: bounded.fullOutputPath } };
      }
      if (!params.path) throw new Error(`path is required for lsp action=${params.action}`);
      if (params.action !== "diagnostics" && (params.line === undefined || params.character === undefined)) {
        throw new Error(`line and character are required for lsp action=${params.action}`);
      }
      if (params.action === "rename_preview" && !params.newName) throw new Error("newName is required for rename_preview");
      const displayPath = params.path;
      const path = resolveToolPath(ctx.cwd, displayPath);
      try {
        const output = await manager.use(path, ctx, "explicit", async (client) => {
          if (params.action === "diagnostics") {
            const ticket = await client.open(path, undefined, { signal });
            const observation = await client.waitForDiagnostics(ticket, manager.diagnosticTimeoutMs, signal);
            const bounded = await boundedOutput(diagnosticText(displayPath, observation), { prefix: "grounded-lsp-diagnostics", direction: "head" });
            throwIfLspAborted(signal);
            return {
              successful: diagnosticSucceeded(observation), failureReason: observation.outcome,
              value: { content: [{ type: "text" as const, text: bounded.text }], details: { ...observation, fullOutputPath: bounded.fullOutputPath } },
            };
          }
          const line = params.line! - 1;
          let result: unknown;
          if (params.action === "hover") result = await client.hover(path, line, params.character!, signal);
          else if (params.action === "definition") result = await client.definition(path, line, params.character!, signal);
          else if (params.action === "references") result = await client.references(path, line, params.character!, signal);
          else {
            result = await client.renamePreview(path, line, params.character!, params.newName!, signal);
          }
          const exact = result == null ? "No result" : JSON.stringify(result, null, 2);
          const bounded = await boundedOutput(exact, { prefix: `grounded-lsp-${params.action}`, direction: "head" });
          throwIfLspAborted(signal);
          return {
            successful: true,
            value: {
              content: [{ type: "text" as const, text: bounded.text }],
              details: { action: params.action, result, previewOnly: params.action === "rename_preview", fullOutputPath: bounded.fullOutputPath },
            },
          };
        }, { signal });
        if (!output) throw new Error(`No available language server for ${params.path}. Use lsp action=status for details.`);
        return output;
      } catch (error) {
        if (error instanceof LspNoCheck) return {
          content: [{ type: "text", text: error.message }], isError: true,
          details: { groundedLsp: error.details() },
        };
        throw error;
      }
    },
  });

  pi.registerCommand("grounded-lsp", {
    description: "Show grounded LSP status",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(manager.status(), null, 2), "info"),
  });
}
