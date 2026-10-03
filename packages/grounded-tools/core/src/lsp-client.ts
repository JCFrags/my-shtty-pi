import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";

interface PendingRequest {
  generation: Generation;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  removeAbort: () => void;
  sent: boolean;
}

export class LspRequestTimeout extends Error {}

export function lspAbortError(signal?: AbortSignal): Error {
  const error = new Error(signal?.reason instanceof Error ? signal.reason.message : "LSP operation cancelled");
  error.name = "AbortError";
  return error;
}

export function throwIfLspAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw lspAbortError(signal);
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfLspAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(lspAbortError(signal)); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfLspAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(lspAbortError(signal)); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
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

export interface LspDocumentTicket {
  readonly generation: number;
  readonly uri: string;
  readonly documentVersion: number;
  readonly baseline: number;
  readonly changed: boolean;
  readonly saveNotification: "sent" | "not-supported" | "not-requested";
}

export interface LspDiagnosticResult {
  outcome: "published" | "cached" | "pending" | "timeout";
  freshness: "version-matched" | "unversioned" | "stale" | "unknown";
  checked: boolean;
  uri: string;
  documentVersion?: number;
  diagnosticVersion?: number;
  publicationRevision?: number;
  publishedAt?: number;
  diagnostics: LspDiagnostic[];
  waitedMs: number;
  timeoutMs: number;
  waitEnded?: "quiet" | "deadline" | "cached" | "superseded";
  saveNotification: LspDocumentTicket["saveNotification"];
  analysisComplete: "unknown";
  reason?: string;
}

interface DiagnosticPublication {
  diagnostics: LspDiagnostic[];
  version?: number;
  documentVersion?: number;
  revision: number;
  receivedAt: number;
}

interface Generation extends LspLaunch {
  id: number;
  textDocumentSync?: number | { save?: boolean | { includeText?: boolean } };
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
  private nextGeneration = 1;
  private pending = new Map<number, PendingRequest>();
  private documents = new Map<string, { version: number; digest: string }>();
  private diagnostics = new Map<string, DiagnosticPublication>();
  private diagnosticRevision = new Map<string, number>();
  private stderr: string[] = [];
  private startPromise: Promise<void> | undefined;
  private startWaiters = 0;

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

  async start(signal?: AbortSignal): Promise<void> {
    throwIfLspAborted(signal);
    if (this.stopRequested || this.generation?.closing) throw new Error(`${this.config.id} is stopping`);
    if (this.ready) return;
    if (!this.startPromise) {
      if (this.generation) throw new Error(`${this.config.id} is awaiting child close`);
      const startup = this.startFresh();
      this.startPromise = startup;
      const settled = () => {
        if (this.startPromise === startup) this.startPromise = undefined;
        if (!this.generation) this.stopRequested = false;
      };
      // Retain the launch promise even when every caller cancels its own wait.
      startup.then(settled, settled);
    }
    this.startWaiters++;
    try {
      await withSignal(this.startPromise, signal);
      throwIfLspAborted(signal);
    } finally {
      this.startWaiters--;
      if (signal?.aborted && this.startWaiters === 0 && !this.ready) await this.stop();
    }
  }

  private resetTransport(): void {
    this.buffer = Buffer.alloc(0);
    this.documents.clear();
    this.diagnostics.clear();
    this.diagnosticRevision.clear();
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
    const generation: Generation = { ...launched, id: this.nextGeneration++, closed: false, initialized: false, closedPromise, resolveClosed };
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
    const result = await this.requestOn(generation, "initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: this.root.split(/[\\/]/).pop() ?? "workspace" }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
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
    generation.textDocumentSync = (result as { capabilities?: { textDocumentSync?: Generation["textDocumentSync"] } } | null)?.capabilities?.textDocumentSync;
    this.send({ jsonrpc: "2.0", method: "initialized", params: {} }, generation);
    generation.initialized = true;
  }

  async open(path: string, content?: string, options: { saved?: boolean; signal?: AbortSignal } = {}): Promise<LspDocumentTicket> {
    const { signal } = options;
    await this.start(signal);
    const generation = this.generation;
    const uri = pathToFileURL(path).href;
    const text = content ?? (await readFile(path, { encoding: "utf8", signal }));
    throwIfLspAborted(signal);
    this.assertReady(generation);
    const digest = createHash("sha256").update(text).digest("hex");
    const current = this.documents.get(uri);
    const changed = current === undefined || current.digest !== digest;
    const version = (current?.version ?? 0) + (changed ? 1 : 0);
    let baseline = this.diagnosticRevision.get(uri) ?? 0;
    if (changed) {
      this.documents.set(uri, { version, digest });
      if (current === undefined) {
        const languageId = this.config.languageIds?.[extname(path).toLowerCase()] ?? this.config.languageId;
        this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
      } else {
        this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
      }
    }
    let saveNotification: LspDocumentTicket["saveNotification"] = "not-requested";
    if (options.saved) {
      const sync = generation!.textDocumentSync;
      const save = sync && typeof sync === "object" ? sync.save : undefined;
      if (save === true || (save !== null && typeof save === "object" && !Array.isArray(save))) {
        baseline = this.diagnosticRevision.get(uri) ?? 0;
        this.notify("textDocument/didSave", { textDocument: { uri }, ...(typeof save === "object" && save.includeText === true ? { text } : {}) });
        saveNotification = "sent";
      } else saveNotification = "not-supported";
    }
    return Object.freeze({ generation: generation!.id, uri, documentVersion: version, baseline, changed, saveNotification });
  }

  getDiagnostics(path: string): LspDiagnostic[] {
    return this.diagnostics.get(pathToFileURL(path).href)?.diagnostics ?? [];
  }

  private observation(uri: string, documentVersion = this.documents.get(uri)?.version): LspDiagnosticResult {
    const publication = this.diagnostics.get(uri);
    let freshness: LspDiagnosticResult["freshness"] = "unknown";
    if (publication) {
      if (publication.version !== undefined && documentVersion !== undefined) {
        freshness = publication.version === documentVersion ? "version-matched" : "stale";
      } else if (publication.version === undefined) {
        freshness = publication.documentVersion !== undefined && documentVersion !== undefined && publication.documentVersion !== documentVersion ? "stale" : "unversioned";
      }
    }
    return {
      outcome: publication ? "cached" : "pending", freshness, checked: false, uri, documentVersion,
      diagnosticVersion: publication?.version, publicationRevision: publication?.revision, publishedAt: publication?.receivedAt,
      diagnostics: publication?.diagnostics ?? [], waitedMs: 0, timeoutMs: 0,
      saveNotification: "not-requested", analysisComplete: "unknown",
    };
  }

  allDiagnostics(): LspDiagnosticResult[] {
    const uris = new Set([...this.documents.keys(), ...this.diagnostics.keys()]);
    return [...uris].map((uri) => this.observation(uri));
  }

  private assertReady(generation: Generation | undefined): void {
    if (!generation || this.generation !== generation || !this.ready) throw new Error(`${this.config.id} stopped or changed generation; diagnostics unavailable`);
  }

  async waitForDiagnostics(ticket: LspDocumentTicket, timeoutMs = 3000, signal?: AbortSignal): Promise<LspDiagnosticResult> {
    const generation = this.generation;
    const started = Date.now();
    const deadline = started + timeoutMs;
    let revision = ticket.baseline;
    let stableSince = started;
    while (true) {
      throwIfLspAborted(signal);
      this.assertReady(generation);
      if (generation!.id !== ticket.generation) throw new Error(`${this.config.id} changed generation; diagnostics unavailable`);
      const result = this.observation(ticket.uri, ticket.documentVersion);
      result.saveNotification = ticket.saveNotification;
      result.waitedMs = Date.now() - started;
      result.timeoutMs = timeoutMs;
      if (this.documents.get(ticket.uri)?.version !== ticket.documentVersion) {
        return { ...result, outcome: "pending", waitEnded: "superseded", reason: "document-changed-during-wait" };
      }
      const eligible = result.freshness === "version-matched" || result.freshness === "unversioned";
      const published = eligible && (result.publicationRevision ?? 0) > ticket.baseline;
      if (!ticket.changed && ticket.saveNotification !== "sent" && eligible && !published) {
        return { ...result, outcome: "cached", waitEnded: "cached" };
      }
      if (published && result.publicationRevision !== revision) {
        revision = result.publicationRevision!;
        stableSince = Date.now();
      }
      const expired = Date.now() >= deadline;
      // Quiet is only a sampling heuristic. Push diagnostics have no completion ack.
      const quiet = published && ticket.saveNotification !== "sent" && Date.now() - stableSince >= 200;
      if (expired || quiet) {
        return {
          ...result, outcome: published ? "published" : "timeout",
          checked: published && result.freshness === "version-matched",
          waitEnded: expired ? "deadline" : "quiet",
          ...(!published ? { reason: "no-current-publication" } : {}),
        };
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())), signal);
    }
  }

  async hover(path: string, line: number, character: number, signal?: AbortSignal): Promise<unknown> {
    const { uri } = await this.open(path, undefined, { signal });
    return this.request("textDocument/hover", { textDocument: { uri }, position: { line, character } }, undefined, signal);
  }

  async definition(path: string, line: number, character: number, signal?: AbortSignal): Promise<unknown> {
    const { uri } = await this.open(path, undefined, { signal });
    return this.request("textDocument/definition", { textDocument: { uri }, position: { line, character } }, undefined, signal);
  }

  async references(path: string, line: number, character: number, signal?: AbortSignal): Promise<unknown> {
    const { uri } = await this.open(path, undefined, { signal });
    return this.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    }, undefined, signal);
  }

  async renamePreview(path: string, line: number, character: number, newName: string, signal?: AbortSignal): Promise<unknown> {
    const { uri } = await this.open(path, undefined, { signal });
    return this.request("textDocument/rename", {
      textDocument: { uri },
      position: { line, character },
      newName,
    }, undefined, signal);
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
    this.rejectAll(generation, new Error(`${this.config.id} is stopping`), true);
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

  async request(method: string, params: unknown, timeoutMs = this.config.timeoutMs ?? 5000, signal?: AbortSignal): Promise<unknown> {
    await this.start(signal);
    const generation = this.generation;
    this.assertReady(generation);
    return this.requestOn(generation!, method, params, timeoutMs, signal);
  }

  private finishPending(id: number, error?: Error, result?: unknown, cancel = false): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbort();
    if (cancel && pending.sent) {
      try { this.send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }, pending.generation); }
      catch { /* The exact generation may already be closed. Cancellation is best effort. */ }
    }
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private requestOn(generation: Generation, method: string, params: unknown, timeoutMs = this.config.timeoutMs ?? 5000, signal?: AbortSignal): Promise<unknown> {
    throwIfLspAborted(signal);
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const abort = () => this.finishPending(id, lspAbortError(signal), undefined, true);
      const timer = setTimeout(() => this.finishPending(id, new LspRequestTimeout(`${this.config.id} timed out waiting for ${method}`), undefined, true), timeoutMs);
      timer.unref();
      const pending: PendingRequest = { generation, resolve, reject, timer, sent: false, removeAbort: () => signal?.removeEventListener("abort", abort) };
      this.pending.set(id, pending);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { pending.sent = true; this.send(message, generation); }
      catch (error) { this.finishPending(id, error instanceof Error ? error : new Error(String(error))); }
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
    if (typeof message.method === "string") {
      // Server request IDs have a separate namespace from our outgoing IDs.
      if (typeof message.id === "number" || typeof message.id === "string") {
        const result = message.method === "workspace/configuration" || message.method === "workspace/workspaceFolders" ? [] : null;
        this.send({ jsonrpc: "2.0", id: message.id, result }, generation);
        return;
      }
      if (message.method !== "textDocument/publishDiagnostics" || !message.params || typeof message.params !== "object") return;
      const params = message.params as { uri?: unknown; version?: unknown; diagnostics?: unknown };
      if (typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) return;
      if (params.version !== undefined && (typeof params.version !== "number" || !Number.isInteger(params.version))) return;
      const version = params.version as number | undefined;
      const document = this.documents.get(params.uri);
      const revision = (this.diagnosticRevision.get(params.uri) ?? 0) + 1;
      this.diagnosticRevision.set(params.uri, revision);
      if (document && version !== undefined && version !== document.version) return;
      this.diagnostics.set(params.uri, {
        diagnostics: params.diagnostics as LspDiagnostic[], version, documentVersion: document?.version, revision, receivedAt: Date.now(),
      });
      return;
    }
    if (message.method !== undefined || typeof message.id !== "number" || !("result" in message || "error" in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending || pending.generation !== generation) return;
    const error = message.error && typeof message.error === "object" ? new Error(JSON.stringify(message.error)) : undefined;
    this.finishPending(message.id, error, message.result);
  }

  private rejectAll(generation: Generation, error: Error, cancel = false): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation === generation) this.finishPending(id, error, undefined, cancel);
    }
  }
}
