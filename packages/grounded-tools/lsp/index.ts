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
import { LspClient, type LspClientOptions, type LspDiagnostic, type LspServerConfig } from "@grounded/pi-core/lsp-client";
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

interface ProjectLspConfig {
  disabledServers?: string[];
  diagnosticTimeoutMs?: number;
}

interface LoadedConfig {
  servers: LspServerConfig[];
  project: ProjectLspConfig;
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
  const custom = global?.servers?.filter(validServer) ?? [];
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
        ...(typeof value.diagnosticTimeoutMs === "number"
          ? { diagnosticTimeoutMs: Math.max(100, Math.min(30000, value.diagnosticTimeoutMs)) }
          : {}),
      };
    }
  }
  return { servers: [...byId.values()], project };
}

async function executable(command: string): Promise<boolean> {
  if (isAbsolute(command)) return access(command).then(() => true, () => false);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const suffix of extensions) {
      if (await access(join(directory, `${command}${suffix}`)).then(() => true, () => false)) return true;
    }
  }
  return false;
}

async function findRoot(path: string, cwd: string, markers: string[]): Promise<string> {
  let current = dirname(path);
  const filesystemRoot = parse(current).root;
  while (true) {
    for (const marker of markers) {
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
  details() { return { checked: false, reason: this.reason, message: this.message }; }
}

class LspManager {
  private config?: LoadedConfig;
  private clients = new Map<string, LspClient>();
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

  async use<T>(path: string, ctx: ExtensionContext, mode: "automatic" | "explicit", operation: (client: LspClient) => Promise<T>): Promise<T | undefined> {
    if (!this.config) await this.configure(ctx);
    const ext = extname(path).toLowerCase();
    const server = this.config!.servers.find((candidate) => candidate.extensions.includes(ext));
    if (!server || this.config!.project.disabledServers?.includes(server.id)) return undefined;
    const root = await findRoot(path, ctx.cwd, server.rootMarkers);
    if (this.closing) throw new LspNoCheck("stopping", "LSP is stopping for session shutdown");
    const key = `${server.id}\0${root}`;
    const timeoutMs = this.config!.project.diagnosticTimeoutMs ?? server.timeoutMs;
    const config = { ...server, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
    if (isRustServer(server)) return this.useRust(key, config, root, mode, operation);
    if (this.unavailable.has(server.id)) return undefined;
    if (!(await executable(server.command))) {
      this.unavailable.set(server.id, `${server.command} not found on PATH`);
      return undefined;
    }
    if (this.closing) throw new LspNoCheck("stopping", "LSP is stopping for session shutdown");
    let client = this.clients.get(key);
    if (!client) {
      client = new LspClient(config, root, this.runtime.clientOptions);
      this.clients.set(key, client);
    }
    return operation(client);
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

  private async useRust<T>(key: string, config: LspServerConfig, root: string, mode: "automatic" | "explicit", operation: (client: LspClient) => Promise<T>): Promise<T> {
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
      succeeded = true;
      return result;
    } catch (error) {
      const reason = error instanceof RustLaunchError ? error.reason : "unavailable";
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
      running: [...this.clients.entries(), ...(this.rust ? [[this.rust.key, this.rust.client] as const] : [])]
        .map(([key, client]) => ({ key, running: client.running, state: client.state, stderr: client.recentStderr })),
      rust: {
        automatic: "warm-only", reuseWindowMs: RUST_REUSE_MS, slots: 1,
        platform: process.platform, launcher: rustLauncherAvailability(),
        localState: this.rust?.client.state ?? "stopped", active: this.rust?.active ?? false,
        expiresAt: this.rust?.expiresAt, lastOutcome: this.lastRust,
        sharedAvailability: "unknown until admission; local state is not a fleet census",
      },
    };
  }

  allDiagnostics(): Array<{ server: string; uri: string; diagnostics: LspDiagnostic[] }> {
    return [...this.clients.entries(), ...(this.rust ? [[this.rust.key, this.rust.client] as const] : [])].flatMap(([server, client]) =>
      client.allDiagnostics().map((entry) => ({ server, ...entry })),
    );
  }

  async stop(): Promise<void> {
    this.closing = true;
    const rust = this.rust;
    if (rust?.timer) this.runtime.clearTimer(rust.timer);
    await Promise.all([
      ...[...this.clients.entries()].map(async ([key, client]) => {
        await client.stop();
        if (client.state === "stopped") this.clients.delete(key);
      }),
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
    if (event.isError || !["edit", "write", "grounded_edit", "grounded_write"].includes(event.toolName)) return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    const displayPath = input.path;
    const path = resolveToolPath(ctx.cwd, displayPath);
    try {
      return await manager.use(path, ctx, "automatic", async (client) => {
        await client.open(path);
        const diagnostics = await client.waitForDiagnostics(path);
        const formatted = formatDiagnostics(displayPath, diagnostics);
        if (!formatted) return { details: { ...(event.details as object ?? {}), groundedLsp: { diagnostics: [] } } };
        const bounded = await boundedOutput(formatted, { prefix: "grounded-lsp-diagnostics", direction: "head" });
        return {
          content: [...event.content, { type: "text" as const, text: `LSP diagnostics after ${event.toolName}:\n${bounded.text}` }],
          details: { ...(event.details as object ?? {}), groundedLsp: { diagnostics, fullOutputPath: bounded.fullOutputPath } },
        };
      });
    } catch (error) {
      if (error instanceof LspNoCheck) return {
        content: [...event.content, { type: "text" as const, text: error.message }],
        details: { ...(event.details as object ?? {}), groundedLsp: error.details() },
      };
      return { details: { ...(event.details as object ?? {}), groundedLsp: { error: String(error) } } };
    }
  });

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: "Request exact language-server diagnostics, hover, definition, references, or a non-applying rename preview. Edit/write diagnostics use available servers. Rust automatic checks only reuse an explicitly started warm server for up to 60 seconds.",
    promptSnippet: "Inspect language-aware diagnostics and navigation without automatic formatting or edits",
    promptGuidelines: ["Use lsp rename_preview before applying a multi-file rename; it never writes files."],
    parameters: LspParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
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
            await client.open(path);
            const diagnostics = await client.waitForDiagnostics(path);
            const formatted = formatDiagnostics(displayPath, diagnostics) || "No errors or warnings";
            const bounded = await boundedOutput(formatted, { prefix: "grounded-lsp-diagnostics", direction: "head" });
            return {
              content: [{ type: "text" as const, text: bounded.text }],
              details: { diagnostics, fullOutputPath: bounded.fullOutputPath },
            };
          }
          const line = params.line! - 1;
          let result: unknown;
          if (params.action === "hover") result = await client.hover(path, line, params.character!);
          else if (params.action === "definition") result = await client.definition(path, line, params.character!);
          else if (params.action === "references") result = await client.references(path, line, params.character!);
          else {
            result = await client.renamePreview(path, line, params.character!, params.newName!);
          }
          const exact = result == null ? "No result" : JSON.stringify(result, null, 2);
          const bounded = await boundedOutput(exact, { prefix: `grounded-lsp-${params.action}`, direction: "head" });
          return {
            content: [{ type: "text" as const, text: bounded.text }],
            details: { action: params.action, result, previewOnly: params.action === "rename_preview", fullOutputPath: bounded.fullOutputPath },
          };
        });
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
