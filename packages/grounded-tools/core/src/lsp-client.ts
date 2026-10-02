import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";

interface PendingRequest {
  generation: Generation;
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
  languageIds?: Record<string, string>;
  rootMarkers: string[];
  initializationOptions?: unknown;
  timeoutMs?: number;
}

export interface LspLaunch {
  child: ChildProcessWithoutNullStreams;
  release?: () => void;
}

// Internal injection points for the Rust owner and bounded fake-server checks.
export interface LspClientOptions {
  launch?: (config: LspServerConfig, root: string) => LspLaunch | Promise<LspLaunch>;
  onClose?: (reason: string) => void;
  stopTimeouts?: { shutdown: number; exit: number; term: number; kill: number };
}

interface Generation extends LspLaunch {
  closed: boolean;
  initialized: boolean;
  closing?: Promise<void>;
  closedPromise: Promise<void>;
  resolveClosed: () => void;
}

export class LspClient {
  readonly config: LspServerConfig;
  readonly root: string;
  private generation: Generation | undefined;
  private options: LspClientOptions;
  private stopRequested = false;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private documents = new Map<string, number>();
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private diagnosticRevision = new Map<string, number>();
  private diagnosticBaseline = new Map<string, number>();
  private stderr: string[] = [];
  private startPromise: Promise<void> | undefined;

  constructor(config: LspServerConfig, root: string, options: LspClientOptions = {}) {
    this.config = config;
    this.root = root;
    this.options = options;
  }

  get running(): boolean {
    const generation = this.generation;
    return !!generation && !generation.closed && generation.child.exitCode === null && generation.child.signalCode === null;
  }

  get ready(): boolean {
    return this.running && !!this.generation?.initialized && !this.generation.closing && !this.stopRequested;
  }

  get state(): "stopped" | "starting" | "ready" | "stopping" {
    if (this.generation?.closing || this.stopRequested) return "stopping";
    if (this.ready) return "ready";
    return this.generation || this.startPromise ? "starting" : "stopped";
  }

  get recentStderr(): string {
    return this.stderr.slice(-20).join("");
  }

  async start(): Promise<void> {
    if (this.stopRequested || this.generation?.closing) throw new Error(`${this.config.id} is stopping`);
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    if (this.generation) throw new Error(`${this.config.id} is awaiting child close`);
    this.startPromise = this.startFresh();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
      if (!this.generation) this.stopRequested = false;
    }
  }

  private resetTransport(): void {
    this.buffer = Buffer.alloc(0);
    this.documents.clear();
    this.diagnostics.clear();
    this.diagnosticRevision.clear();
    this.diagnosticBaseline.clear();
  }

  private async startFresh(): Promise<void> {
    this.resetTransport();
    this.stderr = [];
    const launched = this.options.launch
      ? await this.options.launch(this.config, this.root)
      : { child: spawn(this.config.command, this.config.args, {
        cwd: this.root, env: process.env, stdio: ["pipe", "pipe", "pipe"],
      }) };
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const generation: Generation = { ...launched, closed: false, initialized: false, closedPromise, resolveClosed };
    this.generation = generation;
    const child = generation.child;
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.generation === generation && !generation.closed) this.consume(chunk, generation);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.generation !== generation || generation.closed) return;
      this.stderr.push(chunk.toString("utf8"));
      if (this.stderr.length > 100) this.stderr.shift();
    });
    child.stdin.on("error", (error) => this.rejectAll(generation, error));
    child.on("error", (error) => this.rejectAll(generation, error));
    child.once("close", (code, signal) => {
      generation.closed = true;
      generation.release?.();
      generation.resolveClosed();
      const reason = `${this.config.id} exited (${code ?? signal ?? "unknown"})`;
      this.rejectAll(generation, new Error(`${reason}${this.recentStderr ? `: ${this.recentStderr}` : ""}`));
      if (this.generation !== generation) return;
      this.generation = undefined;
      this.stopRequested = false;
      this.resetTransport();
      this.options.onClose?.(reason);
    });

    try {
      if (this.stopRequested) throw new Error(`${this.config.id} start cancelled by stop`);
      await this.initialize(generation);
    } catch (error) {
      await this.closeGeneration(generation);
      throw error;
    }
  }

  private async initialize(generation: Generation): Promise<void> {
    const rootUri = pathToFileURL(this.root).href;
    await this.requestOn(generation, "initialize", {
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
    if (this.generation !== generation || generation.closed || generation.closing) throw new Error(`${this.config.id} stopped during initialization`);
    this.send({ jsonrpc: "2.0", method: "initialized", params: {} }, generation);
    generation.initialized = true;
  }

  async open(path: string, content?: string): Promise<string> {
    await this.start();
    const generation = this.generation;
    const uri = pathToFileURL(path).href;
    const text = content ?? (await readFile(path, "utf8"));
    this.assertReady(generation);
    const current = this.documents.get(uri);
    const version = (current ?? 0) + 1;
    this.documents.set(uri, version);
    this.diagnosticBaseline.set(uri, this.diagnosticRevision.get(uri) ?? 0);
    if (current === undefined) {
      const languageId = this.config.languageIds?.[extname(path).toLowerCase()] ?? this.config.languageId;
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text },
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

  private assertReady(generation: Generation | undefined): void {
    if (!generation || this.generation !== generation || !this.ready) throw new Error(`${this.config.id} stopped or changed generation; diagnostics unavailable`);
  }

  async waitForDiagnostics(path: string, timeoutMs = 3000): Promise<LspDiagnostic[]> {
    const generation = this.generation;
    this.assertReady(generation);
    const uri = pathToFileURL(path).href;
    const initial = this.diagnosticBaseline.get(uri) ?? (this.diagnosticRevision.get(uri) ?? 0);
    this.diagnosticBaseline.delete(uri);
    const started = Date.now();
    let seen = false;
    let stableSince = Date.now();
    let revision = initial;
    while (Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      this.assertReady(generation);
      const current = this.diagnosticRevision.get(uri) ?? 0;
      if (current !== revision) {
        revision = current;
        seen = true;
        stableSince = Date.now();
      }
      if (seen && Date.now() - stableSince >= 200) break;
    }
    this.assertReady(generation);
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
    this.stopRequested = true;
    try {
      if (this.generation) await this.closeGeneration(this.generation);
      else if (this.startPromise) await this.startPromise.catch(() => undefined);
    } finally {
      if (!this.generation && !this.startPromise) this.stopRequested = false;
    }
  }

  private closeGeneration(generation: Generation): Promise<void> {
    if (generation.closing) return generation.closing;
    generation.closing = this.closeChild(generation);
    return generation.closing;
  }

  private async closeChild(generation: Generation): Promise<void> {
    const limits = this.options.stopTimeouts ?? { shutdown: 1000, exit: 500, term: 500, kill: 500 };
    this.rejectAll(generation, new Error(`${this.config.id} is stopping`));
    const wait = async (ms: number) => {
      if (generation.closed) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([generation.closedPromise, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    if (generation.initialized && !generation.closed) {
      try {
        await this.requestOn(generation, "shutdown", null, limits.shutdown);
        this.send({ jsonrpc: "2.0", method: "exit", params: null }, generation);
        await wait(limits.exit);
      } catch { /* Continue with bounded signal cleanup. */ }
    }
    if (!generation.closed) generation.child.kill("SIGTERM");
    await wait(limits.term);
    if (!generation.closed) generation.child.kill("SIGKILL");
    await wait(limits.kill);
    // Only the exact child's close event releases ownership. An unconfirmed
    // close keeps this generation in stopping state and prohibits restart.
  }

  async request(method: string, params: unknown, timeoutMs = this.config.timeoutMs ?? 5000): Promise<unknown> {
    await this.start();
    const generation = this.generation;
    this.assertReady(generation);
    return this.requestOn(generation!, method, params, timeoutMs);
  }

  private requestOn(generation: Generation, method: string, params: unknown, timeoutMs = this.config.timeoutMs ?? 5000): Promise<unknown> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.config.id} timed out waiting for ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { generation, resolve, reject, timer });
      try { this.send(message, generation); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown, generation = this.generation): void {
    if (!generation || this.generation !== generation || generation.closed || !generation.child.stdin.writable) throw new Error(`${this.config.id} is not running`);
    const body = Buffer.from(JSON.stringify(message));
    generation.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    generation.child.stdin.write(body);
  }

  private consume(chunk: Buffer, generation: Generation): void {
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
        this.handle(JSON.parse(body) as Record<string, unknown>, generation);
      } catch (error) {
        this.stderr.push(`Invalid LSP JSON: ${String(error)}\n`);
      }
    }
  }

  private handle(message: Record<string, unknown>, generation: Generation): void {
    if (this.generation !== generation || generation.closed) return;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        if (typeof message.method === "string") {
          const result = message.method === "workspace/configuration" || message.method === "workspace/workspaceFolders" ? [] : null;
          this.send({ jsonrpc: "2.0", id: message.id, result });
        }
        return;
      }
      if (pending.generation !== generation) return;
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

  private rejectAll(generation: Generation, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
