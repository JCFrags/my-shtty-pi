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
import { LspClient, type LspDiagnostic, type LspServerConfig } from "@grounded/pi-core/lsp-client";
import { boundedOutput } from "@grounded/pi-core/output";
import { resolveToolPath } from "@grounded/pi-core/paths";

const DEFAULT_SERVERS: LspServerConfig[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    languageId: "typescript",
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

class LspManager {
  private config?: LoadedConfig;
  private clients = new Map<string, LspClient>();
  private unavailable = new Map<string, string>();

  async configure(ctx: ExtensionContext): Promise<void> {
    this.config = await loadConfig(ctx);
  }

  async clientFor(path: string, ctx: ExtensionContext): Promise<LspClient | undefined> {
    if (!this.config) await this.configure(ctx);
    const ext = extname(path).toLowerCase();
    const server = this.config!.servers.find((candidate) => candidate.extensions.includes(ext));
    if (!server || this.config!.project.disabledServers?.includes(server.id)) return undefined;
    if (this.unavailable.has(server.id)) return undefined;
    if (!(await executable(server.command))) {
      this.unavailable.set(server.id, `${server.command} not found on PATH`);
      return undefined;
    }
    const root = await findRoot(path, ctx.cwd, server.rootMarkers);
    const key = `${server.id}\0${root}`;
    let client = this.clients.get(key);
    if (!client) {
      const timeoutMs = this.config!.project.diagnosticTimeoutMs ?? server.timeoutMs;
      client = new LspClient(
        {
          ...server,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
        root,
      );
      this.clients.set(key, client);
    }
    return client;
  }

  status(): unknown {
    return {
      configured: this.config?.servers.map((server) => ({
        id: server.id,
        command: server.command,
        disabled: this.config?.project.disabledServers?.includes(server.id) ?? false,
        unavailable: this.unavailable.get(server.id),
      })) ?? [],
      running: [...this.clients.entries()].map(([key, client]) => ({ key, running: client.running, stderr: client.recentStderr })),
    };
  }

  allDiagnostics(): Array<{ server: string; uri: string; diagnostics: LspDiagnostic[] }> {
    return [...this.clients.entries()].flatMap(([server, client]) =>
      client.allDiagnostics().map((entry) => ({ server, ...entry })),
    );
  }

  async stop(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.stop().catch(() => undefined)));
    this.clients.clear();
  }
}

export default function groundedLsp(pi: ExtensionAPI) {
  const manager = new LspManager();

  pi.on("session_start", async (_event, ctx) => manager.configure(ctx));
  pi.on("session_shutdown", async () => manager.stop());

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !["edit", "write", "grounded_edit", "grounded_write"].includes(event.toolName)) return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    const path = resolveToolPath(ctx.cwd, input.path);
    const client = await manager.clientFor(path, ctx);
    if (!client) return;
    try {
      await client.open(path);
      const diagnostics = await client.waitForDiagnostics(path);
      const formatted = formatDiagnostics(input.path, diagnostics);
      if (!formatted) return { details: { ...(event.details as object ?? {}), groundedLsp: { diagnostics: [] } } };
      const bounded = await boundedOutput(formatted, { prefix: "grounded-lsp-diagnostics", direction: "head" });
      return {
        content: [...event.content, { type: "text" as const, text: `LSP diagnostics after ${event.toolName}:\n${bounded.text}` }],
        details: { ...(event.details as object ?? {}), groundedLsp: { diagnostics, fullOutputPath: bounded.fullOutputPath } },
      };
    } catch (error) {
      return { details: { ...(event.details as object ?? {}), groundedLsp: { error: String(error) } } };
    }
  });

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: "Request exact language-server diagnostics, hover, definition, references, or a non-applying rename preview. Edit/write diagnostics are appended automatically when a server is available.",
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
      const path = resolveToolPath(ctx.cwd, params.path);
      const client = await manager.clientFor(path, ctx);
      if (!client) throw new Error(`No available language server for ${params.path}. Use lsp action=status for details.`);

      if (params.action === "diagnostics") {
        await client.open(path);
        const diagnostics = await client.waitForDiagnostics(path);
        const formatted = formatDiagnostics(params.path, diagnostics) || "No errors or warnings";
        const bounded = await boundedOutput(formatted, { prefix: "grounded-lsp-diagnostics", direction: "head" });
        return {
          content: [{ type: "text", text: bounded.text }],
          details: { diagnostics, fullOutputPath: bounded.fullOutputPath },
        };
      }
      if (params.line === undefined || params.character === undefined) {
        throw new Error(`line and character are required for lsp action=${params.action}`);
      }
      const line = params.line - 1;
      let result: unknown;
      if (params.action === "hover") result = await client.hover(path, line, params.character);
      else if (params.action === "definition") result = await client.definition(path, line, params.character);
      else if (params.action === "references") result = await client.references(path, line, params.character);
      else {
        if (!params.newName) throw new Error("newName is required for rename_preview");
        result = await client.renamePreview(path, line, params.character, params.newName);
      }
      const exact = result == null ? "No result" : JSON.stringify(result, null, 2);
      const bounded = await boundedOutput(exact, { prefix: `grounded-lsp-${params.action}`, direction: "head" });
      return {
        content: [{ type: "text", text: bounded.text }],
        details: { action: params.action, result, previewOnly: params.action === "rename_preview", fullOutputPath: bounded.fullOutputPath },
      };
    },
  });

  pi.registerCommand("grounded-lsp", {
    description: "Show grounded LSP status",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(manager.status(), null, 2), "info"),
  });
}
