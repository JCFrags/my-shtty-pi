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

export interface ProjectGlanceClientOptions {
  descriptorPath: string;
  onState?(state: ProjectGlanceConnectionState): void;
  onSnapshot?(snapshot: ProjectGlanceSnapshot): void;
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
  readonly #onSnapshot: (snapshot: ProjectGlanceSnapshot) => void;
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
  #requestCounter = 0;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #authenticated = false;

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
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#decoder = undefined;
    this.#authenticated = false;
    this.#setState("disconnected");
  }

  #setState(state: ProjectGlanceConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#onState(state);
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
    if (!this.#running) return;
    this.#descriptor = descriptor;
    this.#onDescriptor({
      sessionKey: descriptor.sessionKey,
      generation: descriptor.generation,
    });
    const socket = createConnection(descriptor.socketPath);
    this.#socket = socket;
    this.#decoder = new ProjectGlanceFrameDecoder();
    this.#authenticated = false;
    let failed = false;
    const fail = (code: "frame" | "server"): void => {
      if (failed) return;
      failed = true;
      this.#onError(code);
      this.#dropConnection();
    };
    this.#handshakeTimer = setTimeout(() => fail("server"), HANDSHAKE_TIMEOUT_MS);
    this.#handshakeTimer.unref?.();
    socket.setNoDelay(true);
    socket.on("connect", () => {
      if (!this.#running || this.#descriptor !== descriptor) return;
      try {
        socket.write(
          encodeFrame({
            version: PROJECT_GLANCE_PROTOCOL_VERSION,
            type: "hello",
            requestId: this.#nextRequestId(),
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
      try {
        for (const value of this.#decoder?.push(chunk) ?? []) {
          const frame = validateServerFrame(value);
          this.#handleFrame(frame, descriptor, fail);
        }
      } catch {
        fail("frame");
      }
    });
    socket.on("error", () => fail("server"));
    socket.on("close", () => {
      if (!failed) this.#dropConnection();
    });
  }

  #handleFrame(
    frame: ProjectGlanceServerFrame,
    descriptor: ProjectGlanceRuntimeDescriptor,
    fail: (code: "frame" | "server") => void,
  ): void {
    if (frame.type === "error") {
      fail("server");
      return;
    }
    if (frame.type === "hello") {
      if (
        frame.sessionKey !== descriptor.sessionKey ||
        frame.generation !== descriptor.generation
      ) {
        fail("frame");
        return;
      }
      this.#authenticated = true;
      this.#attempt = 0;
      if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = undefined;
      this.#setState("connected");
      return;
    }
    if (!this.#authenticated) {
      fail("frame");
      return;
    }
    if (frame.type === "snapshot") {
      if (frame.snapshot.sessionKey !== descriptor.sessionKey) {
        fail("frame");
        return;
      }
      this.#onSnapshot(frame.snapshot);
      return;
    }
    if (frame.type === "snapshot_changed") {
      this.#sendSnapshotRequest();
      return;
    }
    if (frame.type === "pong") return;
  }

  #sendSnapshotRequest(): void {
    const socket = this.#socket;
    if (!socket || !socket.writable || !this.#authenticated) return;
    try {
      socket.write(
        encodeFrame({
          version: PROJECT_GLANCE_PROTOCOL_VERSION,
          type: "snapshot_request",
          requestId: this.#nextRequestId(),
        }),
      );
    } catch {
      this.#dropConnection();
    }
  }

  #nextRequestId(): string {
    this.#requestCounter += 1;
    return `glance-${this.#requestCounter.toString(36)}-${randomUUID().slice(0, 8)}`;
  }

  #dropConnection(): void {
    this.#clearHandshakeTimer();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#decoder = undefined;
    this.#authenticated = false;
    socket?.destroy();
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
            requestId: "probe",
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
          if (frame.type === "snapshot") {
            if (frame.snapshot.sessionKey !== descriptor.sessionKey) {
              finish(new Error("RELAY_PROBE_FAILED"));
            } else {
              finish(undefined, frame.snapshot);
            }
          } else if (frame.type === "error") {
            finish(new Error("RELAY_PROBE_FAILED"));
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
