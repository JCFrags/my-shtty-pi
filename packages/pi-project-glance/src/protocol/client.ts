import type { ProjectGlanceQuestionAction } from "../questions/model.js";
import type { PageResult, BodyResult, HistoryView } from "../history/contracts.js";
import { validateQuestionAction } from "./question-validation.js";
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
  #pendingActions = new Map<string, string>();
  #questionReceipts = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  #actionQueue: Array<{ branchId: string; baseRevision: number; action: { type: "mark_read" | "dismiss" | "focus"; itemId?: string } }> = [];
  #latestSnapshot: ProjectGlanceSnapshot | undefined;
  #actionNeedsSnapshot = false;
  #sentBaseRevision = 0;
  #reads = new Map<string, { type: "page" | "body"; branchId: string; view?: HistoryView; itemId?: string; offset?: number; resolve(value: PageResult | BodyResult): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  requestPage(branchId: string, view: HistoryView, cursor?: string): Promise<PageResult> {
    return this.#requestRead(branchId, { type: "page_request", view, ...(cursor === undefined ? {} : { cursor }) }) as Promise<PageResult>;
  }

  requestBody(branchId: string, itemId: string, offset = 0): Promise<BodyResult> {
    return this.#requestRead(branchId, { type: "body_request", itemId, offset }) as Promise<BodyResult>;
  }

  #requestRead(branchId: string, request: { type: "page_request"; view: HistoryView; cursor?: string } | { type: "body_request"; itemId: string; offset: number }): Promise<PageResult | BodyResult> {
    const socket = this.#socket, descriptor = this.#descriptor;
    if (!socket?.writable || !descriptor || !this.#authenticated || branchId !== this.#latestSnapshot?.branchId || this.#reads.size >= 4) return Promise.reject(new Error("History is unavailable. Retry after reconnecting."));
    const requestId = this.#nextRequestId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#reads.delete(requestId);
        reject(new Error("History request timed out. No stored update was removed."));
      }, 10_000);
      timer.unref?.();
      this.#reads.set(requestId, { type: request.type === "page_request" ? "page" : "body", branchId,
        ...(request.type === "page_request" ? { view: request.view } : { itemId: request.itemId, offset: request.offset }), resolve, reject, timer });
      try { socket.write(encodeFrame({ ...request, version: PROJECT_GLANCE_PROTOCOL_VERSION, requestId, sessionKey: descriptor.sessionKey, generation: descriptor.generation, branchId })); }
      catch { clearTimeout(timer); this.#reads.delete(requestId); reject(new Error("History request could not be sent.")); }
    });
  }

  setQuestionEditing(branchId: string, questionId: string, revision: number, active: boolean): boolean {
    const socket = this.#socket, descriptor = this.#descriptor;
    if (!socket?.writable || !descriptor || !this.#authenticated || branchId !== this.#latestSnapshot?.branchId) return false;
    try { socket.write(encodeFrame({ version: PROJECT_GLANCE_PROTOCOL_VERSION, type: "question_editing", requestId: this.#nextRequestId(), sessionKey: descriptor.sessionKey, generation: descriptor.generation, branchId, questionId, revision, active })); return true; }
    catch { return false; }
  }

  sendFeedAction(branchId: string, baseRevision: number, action: { type: "dismiss"; itemId: string }): Promise<void> {
    const socket = this.#socket, descriptor = this.#descriptor, snapshot = this.#latestSnapshot;
    if (!socket?.writable || !descriptor || !this.#authenticated || !snapshot || this.#pendingActions.size || this.#actionNeedsSnapshot) return Promise.reject(new Error("An update is in progress. Retry after it completes."));
    if (branchId !== snapshot.branchId || baseRevision !== snapshot.revision) return Promise.reject(new Error("Inbox changed. Review it and retry."));
    const requestId = this.#nextRequestId(), actionId = `action-${randomUUID()}`;
    this.#pendingActions.set(requestId, actionId); this.#sentBaseRevision = baseRevision;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#dropConnection(socket, this.#activeConnectionId), 10_000); timer.unref?.();
      this.#questionReceipts.set(requestId, { resolve, reject, timer });
      try { socket.write(encodeFrame({ version: PROJECT_GLANCE_PROTOCOL_VERSION, type: "action", requestId, actionId, sessionKey: descriptor.sessionKey, generation: descriptor.generation, branchId, baseRevision, action })); }
      catch { this.#pendingActions.delete(requestId); this.#finishQuestion(requestId, new Error("Archive action failed. Review the restored inbox before retrying.")); }
    });
  }

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

  sendAction(
    branchId: string,
    baseRevision: number,
    action: { type: "mark_read" | "dismiss" | "focus"; itemId?: string },
  ): boolean {
    const socket = this.#socket;
    const descriptor = this.#descriptor;
    if (!socket?.writable || !this.#authenticated || !descriptor) return false;
    if (this.#actionQueue.length >= 100) return false;
    this.#actionQueue.push({ branchId, baseRevision, action: { ...action } });
    this.#drainActions();
    return true;
  }

  /** Resolves only after a correlated persisted action receipt, never queue admission. */
  sendQuestionAction(branchId: string, baseRevision: number, action: ProjectGlanceQuestionAction): Promise<void> {
    const socket = this.#socket;
    const descriptor = this.#descriptor;
    const snapshot = this.#latestSnapshot;
    if (!socket?.writable || !this.#authenticated || !descriptor || !snapshot) return Promise.reject(new Error("Disconnected. Reconnect before submitting."));
    if (this.#pendingActions.size || this.#actionNeedsSnapshot) return Promise.reject(new Error("An update is in progress. Retry after it completes."));
    const visible = snapshot.questions?.some((question) => question.id === action.questionId && question.revision === action.expectedRevision);
    const hiddenRetry = action.type === "question_retry" && snapshot.questionAttention?.some((entry) => entry.questionId === action.questionId && entry.revision === action.expectedRevision && entry.retryAvailable);
    if (branchId !== snapshot.branchId || baseRevision !== snapshot.revision || (!visible && !hiddenRetry)) return Promise.reject(new Error("Question changed. Review the current question and retry."));
    let checked: ProjectGlanceQuestionAction;
    try { checked = validateQuestionAction(action); } catch { return Promise.reject(new Error("Invalid or oversized answer.")); }
    const requestId = this.#nextRequestId();
    const actionId = `action-${randomUUID()}`;
    this.#pendingActions.set(requestId, actionId);
    this.#sentBaseRevision = snapshot.revision;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // An uncertain receipt must not be replayed automatically. Reconcile via
        // a fresh connection/snapshot before the user can retry.
        this.#dropConnection(socket, this.#activeConnectionId);
      }, 10_000);
      timer.unref?.();
      this.#questionReceipts.set(requestId, { resolve, reject, timer });
      try {
        socket.write(encodeFrame({ version: PROJECT_GLANCE_PROTOCOL_VERSION, type: "action", requestId, actionId, sessionKey: descriptor.sessionKey, generation: descriptor.generation, branchId, baseRevision, action: checked }));
      } catch {
        this.#pendingActions.delete(requestId);
        this.#finishQuestion(requestId, new Error("Submission failed. Reconnect and review its state."));
      }
    });
  }

  #finishQuestion(requestId: string, error?: Error): void {
    const receipt = this.#questionReceipts.get(requestId);
    if (!receipt) return;
    this.#questionReceipts.delete(requestId);
    clearTimeout(receipt.timer);
    if (error) receipt.reject(error); else receipt.resolve();
  }

  #drainActions(): void {
    const socket = this.#socket;
    const descriptor = this.#descriptor;
    const snapshot = this.#latestSnapshot;
    if (!socket?.writable || !this.#authenticated || !descriptor || !snapshot ||
        this.#pendingActions.size > 0 || this.#actionNeedsSnapshot) return;
    while (this.#actionQueue.length > 0) {
      const queued = this.#actionQueue.shift()!;
      if (queued.branchId !== snapshot.branchId) continue;
      // Never broaden a focus acknowledgement to arrivals the user did not see.
      if (queued.baseRevision !== snapshot.revision) continue;
      if (queued.action.type !== "focus" && !snapshot.feed.some((item) => item.id === queued.action.itemId)) continue;
      const requestId = this.#nextRequestId();
      const actionId = `action-${randomUUID()}`;
      this.#pendingActions.set(requestId, actionId);
      this.#sentBaseRevision = snapshot.revision;
      try {
        socket.write(encodeFrame({
          version: PROJECT_GLANCE_PROTOCOL_VERSION, type: "action", requestId, actionId,
          sessionKey: descriptor.sessionKey, generation: descriptor.generation,
          branchId: queued.branchId, baseRevision: snapshot.revision, action: queued.action,
        }));
      } catch {
        this.#pendingActions.delete(requestId);
      }
      return;
    }
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
      const read = frame.requestId ? this.#reads.get(frame.requestId) : undefined;
      if (read && frame.requestId) {
        clearTimeout(read.timer); this.#reads.delete(frame.requestId);
        read.reject(new Error("History request failed. Stored updates were not removed.")); return;
      }
      if (frame.requestId && this.#pendingActions.has(frame.requestId)) {
        this.#pendingActions.delete(frame.requestId);
        this.#finishQuestion(frame.requestId, new Error(frame.code === "stale_action" ? "Question changed. Review it and retry." : "Submission was not accepted. Review the question and retry."));
        this.#actionNeedsSnapshot = true;
        this.#sendSnapshotRequest(socket, connectionId, fail);
        return;
      }
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
    if (frame.type === "page" || frame.type === "body") {
      const pending = this.#reads.get(frame.requestId);
      if (!pending) return; // A timed-out read is never replayed as an action.
      clearTimeout(pending.timer); this.#reads.delete(frame.requestId);
      if (pending.type !== frame.type || pending.branchId !== frame.branchId || frame.branchId !== this.#latestSnapshot?.branchId ||
          (frame.type === "page" && pending.view !== frame.view) ||
          (frame.type === "body" && (pending.itemId !== frame.itemId || pending.offset !== frame.offset))) {
        pending.reject(new Error("History view changed. Reload its page.")); return;
      }
      pending.resolve(frame); return;
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
      if (this.#latestSnapshot?.branchId !== frame.snapshot.branchId) this.#actionQueue = [];
      this.#latestSnapshot = frame.snapshot;
      if (frame.requestId !== undefined) this.#actionNeedsSnapshot = false;
      try {
        this.#onSnapshot(frame.snapshot, {
          sessionKey: descriptor.sessionKey,
          generation: descriptor.generation,
        });
      } catch {
        fail("frame");
        return;
      }
      this.#drainActions();
      if (requestAgain && this.#isCurrent(socket, connectionId)) {
        this.#sendSnapshotRequest(socket, connectionId, fail);
      }
      return;
    }
    if (frame.type === "snapshot_changed") {
      this.#sendSnapshotRequest(socket, connectionId, fail);
      return;
    }
    if (frame.type === "action_result") {
      const actionId = this.#pendingActions.get(frame.requestId);
      if (!actionId || actionId !== frame.actionId) {
        fail("frame");
        return;
      }
      this.#pendingActions.delete(frame.requestId);
      this.#finishQuestion(frame.requestId);
      // Rebase only across our own accepted mutation, never an unrelated
      // append, branch round trip, or provider publication. Focus is never rebased.
      for (const queued of this.#actionQueue) {
        if (queued.action.type !== "focus" && queued.baseRevision === this.#sentBaseRevision) queued.baseRevision = frame.revision;
      }
      this.#actionNeedsSnapshot = true;
      this.#sendSnapshotRequest(socket, connectionId, fail);
      return;
    }
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
    for (const requestId of this.#questionReceipts.keys()) this.#finishQuestion(requestId, new Error("Connection changed. Review the restored question before retrying."));
    this.#pendingActions.clear();
    for (const read of this.#reads.values()) { clearTimeout(read.timer); read.reject(new Error("Connection changed. Reload the history page.")); }
    this.#reads.clear();
    this.#actionQueue = [];
    this.#latestSnapshot = undefined;
    this.#actionNeedsSnapshot = false;
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
