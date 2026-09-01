import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: unknown[];
}

export interface LspServerConfig {
  id: string;
  command: string;
  args: string[];
  extensions: string[];
  languageId: string;
  rootMarkers: string[];
  initializationOptions?: unknown;
  timeoutMs?: number;
}

export class LspClient {
  readonly config: LspServerConfig;
  readonly root: string;
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private documents = new Map<string, number>();
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private diagnosticRevision = new Map<string, number>();
  private diagnosticBaseline = new Map<string, number>();
  private stderr: string[] = [];
  private initialized = false;
  private startPromise: Promise<void> | undefined;

  constructor(config: LspServerConfig, root: string) {
    this.config = config;
    this.root = root;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  get recentStderr(): string {
    return this.stderr.slice(-20).join("");
  }

  async start(): Promise<void> {
    if (this.running && this.initialized) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startFresh();
    try {
      await this.startPromise;
    } catch (error) {
      this.child?.kill("SIGTERM");
      this.child = undefined;
      this.initialized = false;
      throw error;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startFresh(): Promise<void> {
    this.child = spawn(this.config.command, this.config.args, {
      cwd: this.root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr.push(chunk.toString("utf8"));
      if (this.stderr.length > 100) this.stderr.shift();
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code, signal) => {
      this.rejectAll(new Error(`${this.config.id} exited (${code ?? signal ?? "unknown"})${this.recentStderr ? `: ${this.recentStderr}` : ""}`));
      this.child = undefined;
      this.initialized = false;
    });

    const rootUri = pathToFileURL(this.root).href;
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: this.root.split(/[\\/]/).pop() ?? "workspace" }],
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: {},
          references: {},
          rename: { prepareSupport: true },
        },
        workspace: { workspaceEdit: { documentChanges: true } },
      },
      initializationOptions: this.config.initializationOptions,
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  async open(path: string, content?: string): Promise<string> {
    await this.start();
    const uri = pathToFileURL(path).href;
    const text = content ?? (await readFile(path, "utf8"));
    const current = this.documents.get(uri);
    const version = (current ?? 0) + 1;
    this.documents.set(uri, version);
    this.diagnosticBaseline.set(uri, this.diagnosticRevision.get(uri) ?? 0);
    if (current === undefined) {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: this.config.languageId, version, text },
      });
    } else {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  getDiagnostics(path: string): LspDiagnostic[] {
    return this.diagnostics.get(pathToFileURL(path).href) ?? [];
  }

  allDiagnostics(): Array<{ uri: string; diagnostics: LspDiagnostic[] }> {
    return [...this.diagnostics.entries()].map(([uri, diagnostics]) => ({ uri, diagnostics }));
  }

  async waitForDiagnostics(path: string, timeoutMs = 3000): Promise<LspDiagnostic[]> {
    const uri = pathToFileURL(path).href;
    const initial = this.diagnosticBaseline.get(uri) ?? (this.diagnosticRevision.get(uri) ?? 0);
    this.diagnosticBaseline.delete(uri);
    const started = Date.now();
    let seen = false;
    let stableSince = Date.now();
    let revision = initial;
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const current = this.diagnosticRevision.get(uri) ?? 0;
      if (current !== revision) {
        revision = current;
        seen = true;
        stableSince = Date.now();
      }
      if (seen && Date.now() - stableSince >= 200) break;
    }
    return this.getDiagnostics(path);
  }

  async hover(path: string, line: number, character: number): Promise<unknown> {
    const uri = await this.open(path);
    return this.request("textDocument/hover", { textDocument: { uri }, position: { line, character } });
  }

  async definition(path: string, line: number, character: number): Promise<unknown> {
    const uri = await this.open(path);
    return this.request("textDocument/definition", { textDocument: { uri }, position: { line, character } });
  }

  async references(path: string, line: number, character: number): Promise<unknown> {
    const uri = await this.open(path);
    return this.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    });
  }

  async renamePreview(path: string, line: number, character: number, newName: string): Promise<unknown> {
    const uri = await this.open(path);
    return this.request("textDocument/rename", {
      textDocument: { uri },
      position: { line, character },
      newName,
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await this.request("shutdown", null, 1000);
      this.notify("exit", null);
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    } catch {
      // Fall through to forced termination.
    }
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    this.child = undefined;
    this.initialized = false;
  }

  async request(method: string, params: unknown, timeoutMs = this.config.timeoutMs ?? 5000): Promise<unknown> {
    if (!this.child) {
      if (method === "initialize") {
        // start() has already spawned the process.
      } else {
        await this.start();
      }
    }
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.config.id} timed out waiting for ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.send(message);
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error(`${this.config.id} is not running`);
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.handle(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        this.stderr.push(`Invalid LSP JSON: ${String(error)}\n`);
      }
    }
  }

  private handle(message: Record<string, unknown>): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        if (typeof message.method === "string") {
          const result = message.method === "workspace/configuration" || message.method === "workspace/workspaceFolders" ? [] : null;
          this.send({ jsonrpc: "2.0", id: message.id, result });
        }
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error && typeof message.error === "object") {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else pending.resolve(message.result);
      return;
    }
    if (typeof message.id === "string" && typeof message.method === "string") {
      const result = message.method === "workspace/configuration" || message.method === "workspace/workspaceFolders" ? [] : null;
      this.send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }
    if (message.method === "textDocument/publishDiagnostics" && message.params && typeof message.params === "object") {
      const params = message.params as { uri?: unknown; diagnostics?: unknown };
      if (typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) return;
      this.diagnostics.set(params.uri, params.diagnostics as LspDiagnostic[]);
      this.diagnosticRevision.set(params.uri, (this.diagnosticRevision.get(params.uri) ?? 0) + 1);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
