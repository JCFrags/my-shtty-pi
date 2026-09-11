import { timingSafeEqual } from "node:crypto";
import type { PageResult, BodyResult } from "../history/contracts.js";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  MAX_FRAME_BYTES,
  PROJECT_GLANCE_PROTOCOL_VERSION,
  type ProjectGlanceClientFrame,
  type ProjectGlanceErrorCode,
  type ProjectGlanceHelloRequest,
  type ProjectGlanceServerFrame,
  type ProjectGlanceSnapshot,
} from "./model.js";
import { ProjectGlanceFrameDecoder, encodeFrame } from "./framing.js";
import {
  ProjectGlanceValidationError,
  validateClientFrame,
  validateGeneration,
  validateSessionKey,
  validateSnapshot,
  validateToken,
} from "./validation.js";
import {
  assertPathInRuntimeDirectory,
  assertPrivateRuntimeDirectory,
  assertPrivateSocket,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
  type ProjectGlanceRuntimePaths,
} from "../runtime/paths.js";

const SOCKET_PROBE_TIMEOUT_MS = 250;
const ERROR_MESSAGES: Record<ProjectGlanceErrorCode, string> = {
  invalid_frame: "The relay rejected the frame.",
  authentication_required: "Authentication is required.",
  authentication_failed: "Authentication failed.",
  unsupported_request: "The relay does not support that request.",
  server_unavailable: "The relay is unavailable.",
  stale_action: "The pane state is stale.",
  replayed_action: "The action was already handled.",
  invalid_action: "The action is invalid.",
};

type SocketProbe = "absent" | "stale" | "live" | "unknown";

export interface ProjectGlanceServerOptions {
  paths: ProjectGlanceRuntimePaths;
  sessionKey: string;
  token: string;
  generation: string;
  snapshot: ProjectGlanceSnapshot;
  onAction?(frame: Extract<ProjectGlanceClientFrame, { type: "action" }>): Promise<number | undefined> | number | undefined;
  onPage?(frame: Extract<ProjectGlanceClientFrame, { type: "page_request" }>): Promise<PageResult> | PageResult;
  onBody?(frame: Extract<ProjectGlanceClientFrame, { type: "body_request" }>): Promise<BodyResult> | BodyResult;
  onEditingChanged?(): void;
  onConnected?(): void | Promise<void>;
}

interface ClientState {
  socket: Socket;
  decoder: ProjectGlanceFrameDecoder;
  authenticated: boolean;
  closed: boolean;
  pendingReads: number;
  editing?: { branchId: string; questionId: string; revision: number } | undefined;
}

function tokenMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function closeSocket(client: ClientState): void {
  if (client.closed) return;
  client.closed = true;
  client.socket.destroy();
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function probeSocket(
  path: string,
  runtimeDirectory: string,
): Promise<SocketProbe> {
  await assertPrivateRuntimeDirectory(runtimeDirectory);
  assertPathInRuntimeDirectory(runtimeDirectory, path);
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  if (!entry.isSocket() || entry.isSymbolicLink()) throw new Error("Unsafe Project Glance socket.");
  await assertPrivateSocket(path, runtimeDirectory);
  return await new Promise<SocketProbe>((resolve, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve("unknown");
    }, SOCKET_PROBE_TIMEOUT_MS);
    timer.unref?.();
    const finish = (value: SocketProbe, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.once("connect", () => finish("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "ECONNRESET") {
        finish("stale");
      } else {
        finish("unknown", error);
      }
    });
  });
}

export async function recoverStaleSocket(
  path: string,
  runtimeDirectory: string,
): Promise<"absent" | "removed"> {
  await assertPrivateRuntimeDirectory(runtimeDirectory);
  assertPathInRuntimeDirectory(runtimeDirectory, path);
  const state = await probeSocket(path, runtimeDirectory);
  if (state === "absent") return "absent";
  if (state !== "stale") throw new Error("A Project Glance relay is already listening.");
  await unlink(path);
  return "removed";
}

function sendFrame(client: ClientState, frame: ProjectGlanceServerFrame): boolean {
  if (client.closed || !client.socket.writable) return false;
  try {
    client.socket.write(encodeFrame(frame));
    return true;
  } catch {
    closeSocket(client);
    return false;
  }
}

function sendError(
  client: ClientState,
  code: ProjectGlanceErrorCode,
  requestId?: string,
): void {
  sendFrame(client, {
    version: PROJECT_GLANCE_PROTOCOL_VERSION,
    type: "error",
    ...(requestId === undefined ? {} : { requestId }),
    code,
    message: ERROR_MESSAGES[code],
  });
}

export class ProjectGlanceServer {
  readonly #paths: ProjectGlanceRuntimePaths;
  readonly #sessionKey: string;
  readonly #token: string;
  readonly #generation: string;
  #snapshot: ProjectGlanceSnapshot;
  #server: Server | undefined;
  #clients = new Set<ClientState>();
  #started = false;
  readonly #onAction: NonNullable<ProjectGlanceServerOptions["onAction"]>;
  readonly #seenActions = new Set<string>();
  readonly #onPage: ProjectGlanceServerOptions["onPage"];
  readonly #onBody: ProjectGlanceServerOptions["onBody"];
  readonly #onEditingChanged: () => void;
  readonly #onConnected: ProjectGlanceServerOptions["onConnected"];

  isQuestionEditing(branchId: string, questionId: string, revision: number): boolean {
    return [...this.#clients].some((client) => !client.closed && client.authenticated &&
      client.editing?.branchId === branchId && client.editing.questionId === questionId && client.editing.revision === revision);
  }

  constructor(options: ProjectGlanceServerOptions) {
    this.#paths = options.paths;
    this.#sessionKey = validateSessionKey(options.sessionKey);
    this.#token = validateToken(options.token);
    this.#generation = validateGeneration(options.generation);
    this.#snapshot = validateSnapshot(options.snapshot);
    this.#onAction = options.onAction ?? (() => undefined);
    this.#onPage = options.onPage;
    this.#onBody = options.onBody;
    this.#onEditingChanged = options.onEditingChanged ?? (() => undefined);
    this.#onConnected = options.onConnected;
    if (this.#snapshot.sessionKey !== this.#sessionKey) {
      throw new ProjectGlanceValidationError();
    }
  }

  get socketPath(): string {
    return this.#paths.socketPath;
  }

  get started(): boolean {
    return this.#started;
  }

  get connectedClients(): number {
    return [...this.#clients].filter((client) => client.authenticated && !client.closed).length;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    await ensurePrivateDirectory(this.#paths.runtimeDirectory);
    assertPathInRuntimeDirectory(this.#paths.runtimeDirectory, this.#paths.socketPath);
    await recoverStaleSocket(this.#paths.socketPath, this.#paths.runtimeDirectory);
    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.#paths.socketPath);
      });
      // The private parent prevents access before this explicit socket mode is
      // asserted; no process-global umask is changed during this await.
      await chmod(this.#paths.socketPath, PRIVATE_FILE_MODE);
      await assertPrivateSocket(this.#paths.socketPath, this.#paths.runtimeDirectory);
      this.#started = true;
    } catch (error) {
      await closeServer(server);
      this.#server = undefined;
      try {
        const state = await probeSocket(this.#paths.socketPath, this.#paths.runtimeDirectory);
        if (state !== "live") await unlink(this.#paths.socketPath);
      } catch {
        // The socket may not have been created.
      }
      throw error;
    }
  }

  publish(snapshot: ProjectGlanceSnapshot): boolean {
    const next = validateSnapshot(snapshot);
    if (next.sessionKey !== this.#sessionKey || next.revision <= this.#snapshot.revision) return false;
    this.#snapshot = next;
    for (const client of this.#clients) {
      if (client.authenticated) {
        sendFrame(client, {
          version: PROJECT_GLANCE_PROTOCOL_VERSION,
          type: "snapshot_changed",
          revision: next.revision,
        });
      }
    }
    return true;
  }

  async stop(): Promise<void> {
    if (!this.#server && !this.#started) return;
    for (const client of this.#clients) closeSocket(client);
    this.#clients.clear();
    const server = this.#server;
    this.#server = undefined;
    this.#started = false;
    if (server) await closeServer(server);
    try {
      await assertPrivateRuntimeDirectory(this.#paths.runtimeDirectory);
      const state = await probeSocket(this.#paths.socketPath, this.#paths.runtimeDirectory);
      if (state === "stale") await unlink(this.#paths.socketPath);
    } catch {
      // Cleanup must not expose local paths or interrupt the caller.
    }
  }

  #accept(socket: Socket): void {
    socket.setNoDelay(true);
    const client: ClientState = {
      socket,
      decoder: new ProjectGlanceFrameDecoder(),
      authenticated: false,
      closed: false,
      pendingReads: 0,
    };
    this.#clients.add(client);
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const value of client.decoder.push(chunk)) this.#handle(client, value);
      } catch {
        sendError(client, "invalid_frame");
        closeSocket(client);
      }
    });
    socket.on("error", () => closeSocket(client));
    socket.on("close", () => {
      client.closed = true;
      this.#clients.delete(client);
      if (client.editing) { client.editing = undefined; this.#onEditingChanged(); }
    });
  }

  #handle(client: ClientState, value: unknown): void {
    let frame: ProjectGlanceClientFrame;
    try {
      frame = validateClientFrame(value);
    } catch {
      sendError(client, "invalid_frame");
      closeSocket(client);
      return;
    }
    if (!client.authenticated) {
      if (frame.type !== "hello") {
        sendError(client, "authentication_required");
        closeSocket(client);
        return;
      }
      const hello: ProjectGlanceHelloRequest = frame;
      if (
        hello.sessionKey !== this.#sessionKey ||
        hello.generation !== this.#generation ||
        !tokenMatches(this.#token, hello.token)
      ) {
        sendError(client, "authentication_failed", hello.requestId);
        closeSocket(client);
        return;
      }
      client.authenticated = true;
      sendFrame(client, {
        version: PROJECT_GLANCE_PROTOCOL_VERSION,
        type: "hello",
        requestId: hello.requestId,
        accepted: true,
        sessionKey: this.#sessionKey,
        generation: this.#generation,
      });
      sendFrame(client, {
        version: PROJECT_GLANCE_PROTOCOL_VERSION,
        type: "snapshot",
        snapshot: this.#snapshot,
      });
      // Reconcile persisted entries once for this authenticated connection.
      // Ordinary snapshot requests do not re-extract the session.
      void Promise.resolve().then(() => this.#onConnected?.()).catch(() => {
        if (!client.closed) sendError(client, "server_unavailable");
      });
      return;
    }
    if (frame.type === "ping") {
      sendFrame(client, {
        version: PROJECT_GLANCE_PROTOCOL_VERSION,
        type: "pong",
        requestId: frame.requestId,
      });
      return;
    }
    if (frame.type === "page_request" || frame.type === "body_request" || frame.type === "question_editing") {
      if (frame.sessionKey !== this.#sessionKey || frame.generation !== this.#generation) {
        sendError(client, "authentication_failed", frame.requestId); return;
      }
      if (frame.branchId !== this.#snapshot.branchId) { sendError(client, "stale_action", frame.requestId); return; }
      if (frame.type === "question_editing") {
        if (frame.active && !this.#snapshot.questions?.some((q) => q.id === frame.questionId && q.revision === frame.revision)) {
          sendError(client, "stale_action", frame.requestId); return;
        }
        if (frame.active) client.editing = { branchId: frame.branchId, questionId: frame.questionId, revision: frame.revision };
        else if (client.editing?.questionId === frame.questionId && client.editing.revision === frame.revision) client.editing = undefined;
        this.#onEditingChanged();
        return;
      }
      if (client.pendingReads >= 4) { sendError(client, "server_unavailable", frame.requestId); return; }
      client.pendingReads += 1;
      void Promise.resolve().then(async () => {
        if (frame.type === "page_request") {
          if (!this.#onPage) throw new Error("ARCHIVE_UNAVAILABLE");
          const page = await this.#onPage(frame);
          if (!client.closed && frame.branchId === this.#snapshot.branchId) sendFrame(client, { ...page, version: PROJECT_GLANCE_PROTOCOL_VERSION, type: "page", requestId: frame.requestId });
          else if (!client.closed) sendError(client, "stale_action", frame.requestId);
        } else {
          if (!this.#onBody) throw new Error("ARCHIVE_UNAVAILABLE");
          const body = await this.#onBody(frame);
          if (!client.closed && frame.branchId === this.#snapshot.branchId) sendFrame(client, { ...body, branchId: frame.branchId, version: PROJECT_GLANCE_PROTOCOL_VERSION, type: "body", requestId: frame.requestId });
          else if (!client.closed) sendError(client, "stale_action", frame.requestId);
        }
      }).catch(() => { if (!client.closed) sendError(client, "server_unavailable", frame.requestId); })
        .finally(() => { client.pendingReads -= 1; });
      return;
    }
    if (frame.type === "action") {
      if (
        frame.sessionKey !== this.#sessionKey ||
        frame.generation !== this.#generation
      ) {
        sendError(client, "authentication_failed", frame.requestId);
        return;
      }
      if (this.#seenActions.has(frame.actionId)) {
        sendError(client, "replayed_action", frame.requestId);
        return;
      }
      if (
        frame.baseRevision !== this.#snapshot.revision ||
        frame.branchId !== this.#snapshot.branchId
      ) {
        sendError(client, "stale_action", frame.requestId);
        return;
      }
      if (this.#seenActions.size >= 256) {
        this.#seenActions.delete(this.#seenActions.values().next().value!);
      }
      this.#seenActions.add(frame.actionId);
      void Promise.resolve().then(() => this.#onAction(frame))
        .then((revision) => {
          if (client.closed) return;
          if (revision === undefined) {
            sendError(client, "invalid_action", frame.requestId);
            return;
          }
          sendFrame(client, {
            version: PROJECT_GLANCE_PROTOCOL_VERSION,
            type: "action_result",
            requestId: frame.requestId,
            actionId: frame.actionId,
            accepted: true,
            revision,
          });
        })
        .catch(() => {
          if (!client.closed) {
            sendError(client, "server_unavailable", frame.requestId);
          }
        });
      return;
    }
    if (frame.type === "snapshot_request") {
      sendFrame(client, {
        version: PROJECT_GLANCE_PROTOCOL_VERSION,
        type: "snapshot",
        requestId: frame.requestId,
        snapshot: this.#snapshot,
      });
      return;
    }
    sendError(client, "unsupported_request", frame.requestId);
    closeSocket(client);
  }
}
