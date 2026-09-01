export const SESSION_PROVIDER_PROTOCOL_VERSION = 1 as const;
export const SESSION_OPERATION_SERVICE_PROTOCOL_VERSION = 2 as const;
export const SESSION_FILE_RESOURCE_PROTOCOL_VERSION = 1 as const;

export type SessionBackend = "local" | "ssh";
export type SessionLifecycleState = "opening" | "idle" | "running" | "closing" | "closed" | "tainted";
export type SessionStream = "stdout" | "stderr" | "terminal";

export interface SessionCapabilities {
  backend: SessionBackend;
  providerId: string;
  protocolVersion: typeof SESSION_PROVIDER_PROTOCOL_VERSION;
  pty: boolean;
  input: boolean;
}

export interface SessionOpenRequest {
  cwd: string;
  env: NodeJS.ProcessEnv;
  pty: boolean;
  target?: string;
  openTimeoutMs: number;
  commandTimeoutMs: number;
  idleTimeoutMs: number;
  closeTimeoutMs: number;
}

export interface SessionOutputChunk {
  sequence: number;
  stream: SessionStream;
  dataBase64: string;
  bytes: number;
}

export interface SessionCommandResult {
  requestId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cwd: string;
  cancelled: boolean;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  terminalBytes: number;
  truncated: boolean;
  chunks: SessionOutputChunk[];
  logPath: string;
}

export interface SessionBackendStatus {
  state: SessionLifecycleState;
  cwd: string;
  pid?: number;
  generation: number;
  openedAt: number;
  lastActivityAt: number;
  taintReason?: string;
}

export interface SessionFileSnapshot {
  canonicalPath: string;
  exists: boolean;
  dataBase64?: string;
  bytes?: number;
  rawDigest?: string;
  mode?: number;
  hardLinks?: number;
}

export interface SessionFileCommitResult {
  canonicalPath: string;
  bytes: number;
  rawDigest: string;
  created: boolean;
  atomic: boolean;
  preservedHardLinks: boolean;
  hardLinksBefore: number;
  rollbackAvailable: boolean;
}

export interface SessionFileResource {
  readonly protocolVersion: typeof SESSION_FILE_RESOURCE_PROTOCOL_VERSION;
  readonly queueIdentity: string;
  resolve(path: string, options?: { signal?: AbortSignal }): Promise<string>;
  read(
    path: string,
    options?: { allowMissing?: boolean; maxBytes?: number; signal?: AbortSignal },
  ): Promise<SessionFileSnapshot>;
  commit(
    request: {
      path: string;
      canonicalPath: string;
      dataBase64: string;
      expectedExists: boolean;
      expectedRawDigest?: string;
    },
    options?: { signal?: AbortSignal },
  ): Promise<SessionFileCommitResult>;
  searchText(
    request: {
      query: string;
      path: string;
      fileGlob?: string;
      ignoreCase?: boolean;
      literal?: boolean;
      contextLines?: number;
    },
    options?: { signal?: AbortSignal },
  ): Promise<{ hits: Array<{
    path: string;
    line: number;
    byteColumn: number;
    text: string;
    snippet: string;
    snippetStartLine: number;
    snippetEndLine: number;
    submatchCount: number;
  }> }>;
  searchFiles(
    request: { path: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ hits: Array<{ path: string; kind: "file" | "directory" }> }>;
}

export interface SessionBackendHandle {
  readonly providerId: string;
  readonly backend: SessionBackend;
  readonly pty: boolean;
  readonly fileResource?: SessionFileResource;
  status(): SessionBackendStatus;
  execute(command: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SessionCommandResult>;
  input(data: Buffer): void;
  interrupt(): void;
  whenClosed(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionProvider {
  readonly id: string;
  readonly backend: SessionBackend;
  readonly protocolVersion: typeof SESSION_PROVIDER_PROTOCOL_VERSION;
  capabilities(): SessionCapabilities;
  open(request: SessionOpenRequest): Promise<SessionBackendHandle>;
}

export class SessionServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionServiceError";
    this.code = code;
  }
}

export class SessionProviderRegistry {
  private readonly providers = new Map<SessionBackend, SessionProvider>();

  register(provider: SessionProvider): void {
    if (provider.protocolVersion !== SESSION_PROVIDER_PROTOCOL_VERSION) {
      throw new SessionServiceError(
        "SESSION_PROVIDER_VERSION_UNSUPPORTED",
        `Session provider ${provider.id} uses unsupported protocol version ${provider.protocolVersion}`,
      );
    }
    const existing = this.providers.get(provider.backend);
    if (existing) {
      throw new SessionServiceError(
        "SESSION_PROVIDER_DUPLICATE",
        `Session backend ${provider.backend} is already owned by provider ${existing.id}`,
      );
    }
    if ([...this.providers.values()].some((entry) => entry.id === provider.id)) {
      throw new SessionServiceError("SESSION_PROVIDER_DUPLICATE", `Session provider id is already registered: ${provider.id}`);
    }
    this.providers.set(provider.backend, provider);
  }

  get(backend: SessionBackend): SessionProvider {
    const provider = this.providers.get(backend);
    if (!provider) {
      throw new SessionServiceError("SESSION_BACKEND_UNAVAILABLE", `Session backend is not available: ${backend}`);
    }
    return provider;
  }

  list(): SessionCapabilities[] {
    return [...this.providers.values()].map((provider) => provider.capabilities());
  }
}

export const SESSION_PROVIDER_REGISTER_EVENT = "grounded:session-provider-register-v1";
export const SESSION_PROVIDER_READY_EVENT = "grounded:session-provider-registry-ready-v1";
export const SESSION_OPERATION_SERVICE_READY_EVENT = "grounded:session-operation-service-ready-v1";
export const SESSION_OPERATION_SERVICE_REQUEST_EVENT = "grounded:session-operation-service-request-v1";
export const SESSION_OPERATION_SERVICE_V2_READY_EVENT = "grounded:session-operation-service-ready-v2";
export const SESSION_OPERATION_SERVICE_V2_REQUEST_EVENT = "grounded:session-operation-service-request-v2";

export interface SessionProviderRegistrationEvent {
  protocolVersion: typeof SESSION_PROVIDER_PROTOCOL_VERSION;
  provider: SessionProvider;
}

export interface SessionProviderReadyEvent {
  protocolVersion: typeof SESSION_PROVIDER_PROTOCOL_VERSION;
  register(provider: SessionProvider): void;
}

export interface SessionOperationContext {
  id: string;
  backend: SessionBackend;
  providerId: string;
  pty: boolean;
  cwd: string;
  generation: number;
}

export interface SessionOperationService {
  protocolVersion: typeof SESSION_PROVIDER_PROTOCOL_VERSION;
  withLocalSession<T>(
    sessionId: string,
    operation: (context: SessionOperationContext) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
}

export interface SessionOperationServiceRequestEvent {
  protocolVersion: typeof SESSION_PROVIDER_PROTOCOL_VERSION;
  accept(service: SessionOperationService): void;
}

export interface SessionOperationContextV2 extends SessionOperationContext {
  fileResource?: SessionFileResource;
}

export interface SessionOperationServiceV2 {
  protocolVersion: typeof SESSION_OPERATION_SERVICE_PROTOCOL_VERSION;
  withSession<T>(
    sessionId: string,
    operation: (context: SessionOperationContextV2) => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
}

export interface SessionOperationServiceV2RequestEvent {
  protocolVersion: typeof SESSION_OPERATION_SERVICE_PROTOCOL_VERSION;
  accept(service: SessionOperationServiceV2): void;
}
