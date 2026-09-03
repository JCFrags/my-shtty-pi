import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  PROJECT_GLANCE_PROTOCOL_VERSION,
  type ProjectGlanceRuntimeDescriptor,
  type ProjectGlanceServerFrame,
  type ProjectGlanceSnapshot,
} from "./model.js";
import { ProjectGlanceFrameDecoder, encodeFrame } from "./framing.js";
import { validateServerFrame } from "./validation.js";
import { readConnectionDescriptor } from "../runtime/connection-file.js";

export type ProjectGlanceConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface ProjectGlanceSnapshotContext {
  sessionKey: string;
  generation: string;
}

export interface ProjectGlanceClientOptions {
  descriptorPath: string;
  onState?(state: ProjectGlanceConnectionState): void;
  onSnapshot?(snapshot: ProjectGlanceSnapshot, context: ProjectGlanceSnapshotContext): void;
  onDescriptor?(descriptor: Pick<ProjectGlanceRuntimeDescriptor, "sessionKey" | "generation">): void;
  onError?(code: "descriptor" | "frame" | "server"): void;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

const DEFAULT_RECONNECT_MIN_MS = 100;
const DEFAULT_RECONNECT_MAX_MS = 2_000;
const HANDSHAKE_TIMEOUT_MS = 2_000;

export class ProjectGlanceClient {
  readonly #descriptorPath: string;
  readonly #onState: (state: ProjectGlanceConnectionState) => void;
  readonly #onSnapshot: (snapshot: ProjectGlanceSnapshot, context: ProjectGlanceSnapshotContext) => void;
  readonly #onDescriptor: (
    descriptor: Pick<ProjectGlanceRuntimeDescriptor, "sessionKey" | "generation">,
  ) => void;
  readonly #onError: (code: "descriptor" | "frame" | "server") => void;
  readonly #reconnectMinMs: number;
  readonly #reconnectMaxMs: number;
  #running = false;
  #state: ProjectGlanceConnectionState = "disconnected";
  #socket: Socket | undefined;
  #decoder: ProjectGlanceFrameDecoder | undefined;
  #descriptor: ProjectGlanceRuntimeDescriptor | undefined;
  #connectionSerial = 0;
  #activeConnectionId = 0;
  #requestCounter = 0;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #authenticated = false;
  #pendingHelloRequestId: string | undefined;
  #helloCompleted = false;
  #initialSnapshotPending = false;
  #pendingSnapshotRequestId: string | undefined;
  #snapshotNotificationPending = false;

  constructor(options: ProjectGlanceClientOptions) {
    this.#descriptorPath = options.descriptorPath;
    this.#onState = options.onState ?? (() => undefined);
    this.#onSnapshot = options.onSnapshot ?? (() => undefined);
    this.#onDescriptor = options.onDescriptor ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
    this.#reconnectMinMs = Math.max(25, options.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS);
    this.#reconnectMaxMs = Math.max(this.#reconnectMinMs, options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS);
  }

  get state(): ProjectGlanceConnectionState {
    return this.#state;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#setState("connecting");
    void this.#connect();
  }

  stop(): void {
    this.#running = false;
    this.#clearTimers();
    this.#activeConnectionId = 0;
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#decoder = undefined;
    this.#authenticated = false;
    this.#clearRequestState();
    this.#setState("disconnected");
  }

  #setState(state: ProjectGlanceConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onState(state);
  }

  #isCurrent(socket: Socket, connectionId: number): boolean {
    return this.#socket === socket && this.#activeConnectionId === connectionId;
  }

  async #connect(): Promise<void> {
    if (!this.#running || this.#socket) return;
    let descriptor: ProjectGlanceRuntimeDescriptor;
    try {
      descriptor = await readConnectionDescriptor(this.#descriptorPath);
    } catch {
      this.#onError("descriptor");
      this.#setState(this.#attempt === 0 ? "connecting" : "reconnecting");
      this.#scheduleReconnect();
      return;
    }
    if (!this.#running || this.#socket) return;
    this.#descriptor = descriptor;
    this.#onDescriptor({
      sessionKey: descriptor.sessionKey,
      generation: descriptor.generation,
    });

    let socket: Socket;
    try {
      socket = createConnection(descriptor.socketPath);
    } catch {
      this.#onError("server");
      this.#setState("reconnecting");
      this.#scheduleReconnect();
      return;
    }
    const connectionId = ++this.#connectionSerial;
    this.#activeConnectionId = connectionId;
    this.#socket = socket;
    this.#decoder = new ProjectGlanceFrameDecoder();
    this.#authenticated = false;
    this.#pendingHelloRequestId = undefined;
    this.#helloCompleted = false;
    this.#initialSnapshotPending = false;
    this.#clearRequestState(false);
    let failed = false;
    const fail = (code: "frame" | "server"): void => {
      if (failed || !this.#isCurrent(socket, connectionId)) return;
      failed = true;
      this.#onError(code);
      this.#dropConnection(socket, connectionId);
    };
    this.#handshakeTimer = setTimeout(() => fail("server"), HANDSHAKE_TIMEOUT_MS);
    this.#handshakeTimer.unref?.();
    socket.setNoDelay(true);
    socket.on("connect", () => {
      if (!this.#running || !this.#isCurrent(socket, connectionId)) return;
      const requestId = this.#nextRequestId();
      this.#pendingHelloRequestId = requestId;
      try {
        socket.write(
          encodeFrame({
            version: PROJECT_GLANCE_PROTOCOL_VERSION,
            type: "hello",
            requestId,
            sessionKey: descriptor.sessionKey,
            token: descriptor.token,
            generation: descriptor.generation,
          }),
        );
      } catch {
        fail("frame");
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (!this.#isCurrent(socket, connectionId)) return;
      try {
        for (const value of this.#decoder?.push(chunk) ?? []) {
          const frame = validateServerFrame(value);
          this.#handleFrame(frame, descriptor, socket, connectionId, fail);
        }
      } catch {
        fail("frame");
      }
    });
    socket.on("error", () => fail("server"));
    socket.on("close", () => {
      if (!failed && this.#isCurrent(socket, connectionId)) this.#dropConnection(socket, connectionId);
    });
  }

  #handleFrame(
    frame: ProjectGlanceServerFrame,
    descriptor: ProjectGlanceRuntimeDescriptor,
    socket: Socket,
    connectionId: number,
    fail: (code: "frame" | "server") => void,
  ): void {
    if (!this.#isCurrent(socket, connectionId)) return;
    if (frame.type === "error") {
      fail("server");
      return;
    }
    if (frame.type === "hello") {
      if (
        this.#helloCompleted ||
        this.#pendingHelloRequestId === undefined ||
        frame.requestId !== this.#pendingHelloRequestId ||
        frame.sessionKey !== descriptor.sessionKey ||
        frame.generation !== descriptor.generation
      ) {
        fail("frame");
        return;
      }
      this.#pendingHelloRequestId = undefined;
      this.#helloCompleted = true;
      this.#initialSnapshotPending = true;
      this.#authenticated = true;
      this.#attempt = 0;
      if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = undefined;
      this.#setState("connected");
      return;
    }
    if (!this.#authenticated || !this.#helloCompleted) {
      fail("frame");
      return;
    }
    if (frame.type === "snapshot") {
      if (frame.snapshot.sessionKey !== descriptor.sessionKey) {
        fail("frame");
        return;
      }
      let requestAgain = false;
      if (frame.requestId === undefined) {
        if (!this.#initialSnapshotPending) {
          fail("frame");
          return;
        }
        this.#initialSnapshotPending = false;
      } else {
        if (
          this.#pendingSnapshotRequestId === undefined ||
          frame.requestId !== this.#pendingSnapshotRequestId
        ) {
          fail("frame");
          return;
        }
        this.#pendingSnapshotRequestId = undefined;
        requestAgain = this.#snapshotNotificationPending;
        this.#snapshotNotificationPending = false;
      }
      try {
        this.#onSnapshot(frame.snapshot, {
          sessionKey: descriptor.sessionKey,
          generation: descriptor.generation,
        });
      } catch {
        fail("frame");
        return;
      }
      if (requestAgain && this.#isCurrent(socket, connectionId)) {
        this.#sendSnapshotRequest(socket, connectionId, fail);
      }
      return;
    }
    if (frame.type === "snapshot_changed") {
      this.#sendSnapshotRequest(socket, connectionId, fail);
      return;
    }
    // The client does not send ping in V1, so no uncorrelated pong is valid.
    fail("frame");
  }

  #sendSnapshotRequest(
    socket: Socket,
    connectionId: number,
    fail: (code: "frame" | "server") => void,
  ): void {
    if (!this.#isCurrent(socket, connectionId) || !socket.writable || !this.#authenticated) return;
    if (this.#pendingSnapshotRequestId !== undefined) {
      this.#snapshotNotificationPending = true;
      return;
    }
    const requestId = this.#nextRequestId();
    this.#pendingSnapshotRequestId = requestId;
    try {
      socket.write(
        encodeFrame({
          version: PROJECT_GLANCE_PROTOCOL_VERSION,
          type: "snapshot_request",
          requestId,
        }),
      );
    } catch {
      fail("frame");
    }
  }

  #nextRequestId(): string {
    this.#requestCounter += 1;
    return `glance-${this.#requestCounter.toString(36)}-${randomUUID().slice(0, 8)}`;
  }

  #clearRequestState(clearHello = true): void {
    if (clearHello) this.#pendingHelloRequestId = undefined;
    this.#helloCompleted = false;
    this.#initialSnapshotPending = false;
    this.#pendingSnapshotRequestId = undefined;
    this.#snapshotNotificationPending = false;
  }

  #dropConnection(socket: Socket, connectionId: number): void {
    if (!this.#isCurrent(socket, connectionId)) return;
    this.#clearHandshakeTimer();
    this.#socket = undefined;
    this.#decoder = undefined;
    this.#activeConnectionId = 0;
    this.#authenticated = false;
    this.#clearRequestState();
    socket.destroy();
    if (!this.#running) {
      this.#setState("disconnected");
      return;
    }
    this.#setState("reconnecting");
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer) return;
    const exponent = Math.min(this.#attempt, 6);
    const delay = Math.min(this.#reconnectMaxMs, this.#reconnectMinMs * 2 ** exponent);
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
  }

  #clearTimers(): void {
    this.#clearHandshakeTimer();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }
}

export async function probeProjectGlanceRelay(
  descriptorPath: string,
  timeoutMs = 2_000,
): Promise<ProjectGlanceSnapshot> {
  const descriptor = await readConnectionDescriptor(descriptorPath);
  return await new Promise<ProjectGlanceSnapshot>((resolve, reject) => {
    const socket = createConnection(descriptor.socketPath);
    const decoder = new ProjectGlanceFrameDecoder();
    const helloRequestId = "probe";
    let helloCompleted = false;
    let initialSnapshotReceived = false;
    let finished = false;
    const finish = (error?: Error, snapshot?: ProjectGlanceSnapshot): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (snapshot) resolve(snapshot);
      else reject(new Error("RELAY_PROBE_FAILED"));
    };
    const timer = setTimeout(() => finish(new Error("RELAY_PROBE_TIMEOUT")), timeoutMs);
    timer.unref?.();
    socket.on("connect", () => {
      try {
        socket.write(
          encodeFrame({
            version: PROJECT_GLANCE_PROTOCOL_VERSION,
            type: "hello",
            requestId: helloRequestId,
            sessionKey: descriptor.sessionKey,
            token: descriptor.token,
            generation: descriptor.generation,
          }),
        );
      } catch {
        finish(new Error("RELAY_PROBE_FAILED"));
      }
    });
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const value of decoder.push(chunk)) {
          const frame = validateServerFrame(value);
          if (frame.type === "hello") {
            if (
              helloCompleted ||
              frame.requestId !== helloRequestId ||
              frame.sessionKey !== descriptor.sessionKey ||
              frame.generation !== descriptor.generation
            ) {
              finish(new Error("RELAY_PROBE_FAILED"));
              return;
            }
            helloCompleted = true;
          } else if (frame.type === "snapshot") {
            if (
              !helloCompleted ||
              initialSnapshotReceived ||
              frame.requestId !== undefined ||
              frame.snapshot.sessionKey !== descriptor.sessionKey
            ) {
              finish(new Error("RELAY_PROBE_FAILED"));
              return;
            }
            initialSnapshotReceived = true;
            finish(undefined, frame.snapshot);
            return;
          } else {
            finish(new Error("RELAY_PROBE_FAILED"));
            return;
          }
        }
      } catch {
        finish(new Error("RELAY_PROBE_FAILED"));
      }
    });
    socket.on("error", () => finish(new Error("RELAY_PROBE_FAILED")));
    socket.on("close", () => {
      if (!finished) finish(new Error("RELAY_PROBE_FAILED"));
    });
  });
}
