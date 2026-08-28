import { randomBytes } from "node:crypto";
import {
  SessionProviderRegistry,
  SessionServiceError,
  type SessionBackend,
  type SessionBackendHandle,
  type SessionCapabilities,
  type SessionCommandResult,
  type SessionOperationContext,
  type SessionOperationContextV2,
  type SessionProvider,
} from "./session-contract.ts";

export interface SessionRegistryOptions {
  maximumSessions?: number;
  openTimeoutMs?: number;
  commandTimeoutMs?: number;
  idleTimeoutMs?: number;
  closeTimeoutMs?: number;
  maximumCommandTimeoutMs?: number;
}

export interface SessionOpenOptions {
  backend: SessionBackend;
  cwd: string;
  env: NodeJS.ProcessEnv;
  pty?: boolean;
  target?: string;
}

export interface SessionSnapshot {
  id: string;
  backend: SessionBackend;
  providerId: string;
  pty: boolean;
  state: ReturnType<SessionBackendHandle["status"]>["state"];
  cwd: string;
  pid?: number;
  generation: number;
  openedAt: number;
  lastActivityAt: number;
  taintReason?: string;
}

interface RegisteredSession {
  id: string;
  handle: SessionBackendHandle;
  closing: boolean;
  queue: Promise<void>;
}

export class SessionRegistry {
  private readonly providers = new SessionProviderRegistry();
  private readonly sessions = new Map<string, RegisteredSession>();
  private readonly maximumSessions: number;
  private readonly openTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly maximumCommandTimeoutMs: number;

  constructor(options: SessionRegistryOptions = {}) {
    this.maximumSessions = options.maximumSessions ?? 4;
    this.openTimeoutMs = options.openTimeoutMs ?? 10_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.maximumCommandTimeoutMs = options.maximumCommandTimeoutMs ?? 86_400_000;
  }

  registerProvider(provider: SessionProvider): void {
    this.providers.register(provider);
  }

  capabilities(): SessionCapabilities[] {
    return this.providers.list();
  }

  async open(options: SessionOpenOptions): Promise<SessionSnapshot> {
    if (this.sessions.size >= this.maximumSessions) {
      throw new SessionServiceError("SESSION_LIMIT", `At most ${this.maximumSessions} live sessions are allowed`);
    }
    if (options.pty && options.backend !== "local") {
      throw new SessionServiceError("SESSION_PTY_UNAVAILABLE", `PTY is not available for backend ${options.backend}`);
    }
    const provider = this.providers.get(options.backend);
    const id = `s_${randomBytes(16).toString("hex")}`;
    const placeholder = { id, handle: undefined, closing: false, queue: Promise.resolve() } as unknown as RegisteredSession;
    this.sessions.set(id, placeholder);
    try {
      const handle = await provider.open({
        cwd: options.cwd,
        env: options.env,
        pty: options.pty ?? false,
        ...(options.target !== undefined ? { target: options.target } : {}),
        openTimeoutMs: this.openTimeoutMs,
        commandTimeoutMs: this.commandTimeoutMs,
        idleTimeoutMs: this.idleTimeoutMs,
        closeTimeoutMs: this.closeTimeoutMs,
      });
      placeholder.handle = handle;
      void handle.whenClosed().then(() => {
        const current = this.sessions.get(id);
        if (current === placeholder && !current.closing && handle.status().state === "closed") this.sessions.delete(id);
      });
      return this.snapshot(placeholder);
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
  }

  list(): SessionSnapshot[] {
    return [...this.sessions.values()].filter((entry) => entry.handle).map((entry) => this.snapshot(entry));
  }

  status(id: string): SessionSnapshot {
    return this.snapshot(this.require(id));
  }

  execute(id: string, command: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SessionCommandResult> {
    const session = this.require(id);
    if (session.closing) throw new SessionServiceError("SESSION_CLOSING", `Session is closing: ${id}`);
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > this.maximumCommandTimeoutMs) {
      throw new SessionServiceError(
        "SESSION_TIMEOUT_INVALID",
        `Session command timeout must be between 0 and ${this.maximumCommandTimeoutMs} milliseconds`,
      );
    }
    const operation = session.queue.then(async () => {
      if (session.closing || !this.sessions.has(id)) throw new SessionServiceError("SESSION_CLOSING", `Session is closing: ${id}`);
      return session.handle.execute(command, { timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
    });
    session.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  withLocalSession<T>(
    id: string,
    operation: (context: SessionOperationContext) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const session = this.require(id);
    if (session.handle.backend !== "local") {
      throw new SessionServiceError(
        "SESSION_OPERATION_REQUIRES_LOCAL",
        `Session-aware local file operations require a local session: ${id}`,
      );
    }
    return this.enqueueSessionOperation(session, id, operation, options);
  }

  withSession<T>(
    id: string,
    operation: (context: SessionOperationContextV2) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const session = this.require(id);
    return this.enqueueSessionOperation(session, id, operation, options);
  }

  input(id: string, data: Buffer): void {
    const session = this.require(id);
    if (!session.handle.pty) {
      throw new SessionServiceError("SESSION_INPUT_REQUIRES_PTY", `Session input requires a PTY session: ${id}`);
    }
    session.handle.input(data);
  }

  interrupt(id: string): void {
    this.require(id).handle.interrupt();
  }

  async close(id: string): Promise<void> {
    const session = this.require(id);
    if (session.closing) {
      await session.queue;
      return;
    }
    session.closing = true;
    try {
      await session.handle.close();
      await session.queue;
    } finally {
      this.sessions.delete(id);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)));
    this.sessions.clear();
  }

  private enqueueSessionOperation<T>(
    session: RegisteredSession,
    id: string,
    operation: (context: SessionOperationContextV2) => Promise<T>,
    options: { signal?: AbortSignal },
  ): Promise<T> {
    if (session.closing) throw new SessionServiceError("SESSION_CLOSING", `Session is closing: ${id}`);
    if (options.signal?.aborted) throw new Error("Operation aborted");
    const queued = session.queue.then(async () => {
      if (session.closing || !this.sessions.has(id)) {
        throw new SessionServiceError("SESSION_CLOSING", `Session is closing: ${id}`);
      }
      if (options.signal?.aborted) throw new Error("Operation aborted");
      const snapshot = this.snapshot(session);
      if (snapshot.state !== "idle") {
        throw new SessionServiceError(
          "SESSION_NOT_IDLE",
          `Session must be idle for a session-aware file operation: ${id}`,
        );
      }
      return operation({
        id: snapshot.id,
        backend: snapshot.backend,
        providerId: snapshot.providerId,
        pty: snapshot.pty,
        cwd: snapshot.cwd,
        generation: snapshot.generation,
        ...(session.handle.fileResource ? { fileResource: session.handle.fileResource } : {}),
      });
    });
    session.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private require(id: string): RegisteredSession {
    const session = this.sessions.get(id);
    if (!session?.handle) throw new SessionServiceError("SESSION_UNKNOWN", `Unknown session id: ${id}`);
    return session;
  }

  private snapshot(session: RegisteredSession): SessionSnapshot {
    const status = session.handle.status();
    return {
      id: session.id,
      backend: session.handle.backend,
      providerId: session.handle.providerId,
      pty: session.handle.pty,
      state: status.state,
      cwd: status.cwd,
      ...(status.pid !== undefined ? { pid: status.pid } : {}),
      generation: status.generation,
      openedAt: status.openedAt,
      lastActivityAt: status.lastActivityAt,
      ...(status.taintReason !== undefined ? { taintReason: status.taintReason } : {}),
    };
  }
}
