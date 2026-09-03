import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createRuntimeDescriptor,
  removeConnectionDescriptor,
  writeConnectionDescriptor,
} from "../runtime/connection-file.js";
import {
  deriveSessionKey,
  runtimePathsForSession,
  type ProjectGlanceRuntimePaths,
} from "../runtime/paths.js";
import { ProjectGlanceServer } from "../protocol/server.js";
import {
  PROJECT_GLANCE_PROTOCOL_VERSION,
  type ProjectGlanceCurrent,
  type ProjectGlanceSnapshot,
} from "../protocol/model.js";
import {
  ProjectGlanceCurrentController,
  type ProjectGlanceEventBus,
} from "../current/controller.js";

export function branchIdForContext(ctx: ExtensionContext): string {
  const leafId = ctx.sessionManager.getLeafId();
  if (typeof leafId !== "string" || !leafId || /[\/\\\0]/u.test(leafId) || /[\uD800-\uDFFF]/u.test(leafId) || /\p{Cc}/u.test(leafId) || Buffer.byteLength(leafId, "utf8") > 128) return "root";
  return leafId;
}

export function createLiveSnapshot(
  sessionKey: string,
  now: string,
): ProjectGlanceSnapshot {
  return {
    protocolVersion: PROJECT_GLANCE_PROTOCOL_VERSION,
    sessionKey,
    revision: 1,
    generatedAt: now,
    current: {},
    feed: [],
  };
}

export class ProjectGlanceRelayRuntime {
  #paths: ProjectGlanceRuntimePaths | undefined;
  #server: ProjectGlanceServer | undefined;
  #controller: ProjectGlanceCurrentController | undefined;
  #sessionKey: string | undefined;
  #generationIndex = 0;
  #revision = 1;
  #current: ProjectGlanceCurrent = {};
  #branchId = "root";
  #environment: NodeJS.ProcessEnv;
  #eventBus: ProjectGlanceEventBus | undefined;
  #operation: Promise<void> = Promise.resolve();

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    eventBus?: ProjectGlanceEventBus,
  ) {
    this.#environment = environment;
    this.#eventBus = eventBus;
  }

  get sessionKey(): string | undefined {
    return this.#sessionKey;
  }

  get descriptorPath(): string | undefined {
    return this.#paths?.descriptorPath;
  }

  get started(): boolean {
    return this.#server?.started === true;
  }

  get branchId(): string {
    return this.#branchId;
  }

  get current(): ProjectGlanceCurrent {
    return { ...this.#current };
  }

  async ensureForContext(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionKey = deriveSessionKey(sessionId);
    const branchId = branchIdForContext(ctx);
    return this.#enqueue(async () => {
      if (this.#sessionKey === sessionKey && this.#server?.started) {
        if (this.#branchId !== branchId) await this.#transitionBranch(branchId);
        return;
      }
      await this.#stopNow();
      await this.#startNow(sessionKey, new Date().toISOString(), 0, branchId);
    });
  }

  async start(sessionKey: string, now = new Date().toISOString()): Promise<void> {
    return this.#enqueue(() => this.#startNow(sessionKey, now, 0, this.#branchId));
  }

  async #startNow(
    sessionKey: string,
    now = new Date().toISOString(),
    generationIndex = 0,
    branchId = "root",
  ): Promise<void> {
    if (this.#server?.started && this.#sessionKey === sessionKey) return;
    await this.#stopNow();
    const paths = runtimePathsForSession(sessionKey, this.#environment);
    const descriptor = createRuntimeDescriptor(paths, sessionKey, now);
    const server = new ProjectGlanceServer({
      paths,
      sessionKey: descriptor.sessionKey,
      token: descriptor.token,
      generation: descriptor.generation,
      snapshot: createLiveSnapshot(descriptor.sessionKey, now),
    });
    try {
      await server.start();
      await writeConnectionDescriptor(paths, descriptor);
    } catch (error) {
      await server.stop();
      try {
        await removeConnectionDescriptor(paths);
      } catch {
        // Best-effort cleanup must not replace the original startup failure.
      }
      throw error;
    }
    this.#paths = paths;
    this.#server = server;
    this.#sessionKey = descriptor.sessionKey;
    this.#generationIndex = generationIndex;
    this.#revision = 1;
    this.#current = {};
    this.#branchId = branchId;
    if (this.#eventBus) {
      this.#controller = new ProjectGlanceCurrentController({
        eventBus: this.#eventBus,
        onChange: (current) => this.#publishCurrent(current),
      });
      this.#controller.start(branchId);
    }
  }

  async restart(now = new Date().toISOString()): Promise<void> {
    return this.#enqueue(async () => {
      const sessionKey = this.#sessionKey;
      if (!sessionKey) throw new Error("PROJECT_GLANCE_RUNTIME_MISSING");
      const nextGenerationIndex = this.#generationIndex + 1;
      const branchId = this.#branchId;
      await this.#stopNow();
      await this.#startNow(sessionKey, now, nextGenerationIndex, branchId);
    });
  }

  async stop(): Promise<void> {
    return this.#enqueue(() => this.#stopNow());
  }

  refreshCurrent(): void {
    this.#controller?.refresh();
  }

  async onSessionTree(ctx: ExtensionContext): Promise<void> {
    const branchId = branchIdForContext(ctx);
    return this.#enqueue(() => this.#transitionBranch(branchId));
  }

  async #transitionBranch(branchId: string): Promise<void> {
    if (this.#branchId === branchId) return;
    this.#branchId = branchId;
    if (this.#controller) {
      this.#controller.onSessionTree(branchId);
    } else {
      this.#current = {};
    }
  }

  #publishCurrent(current: ProjectGlanceCurrent): boolean {
    const server = this.#server;
    if (!server?.started) return false;
    if (JSON.stringify(current) === JSON.stringify(this.#current)) return true;
    const nextRevision = this.#revision + 1;
    const next: ProjectGlanceSnapshot = {
      protocolVersion: PROJECT_GLANCE_PROTOCOL_VERSION,
      sessionKey: this.#sessionKey!,
      revision: nextRevision,
      generatedAt: new Date().toISOString(),
      current: { ...current },
      feed: [],
    };
    try {
      if (!server.publish(next)) return false;
    } catch {
      return false;
    }
    this.#revision = nextRevision;
    this.#current = { ...current };
    return true;
  }

  async #stopNow(): Promise<void> {
    const controller = this.#controller;
    const server = this.#server;
    const paths = this.#paths;
    this.#controller = undefined;
    this.#server = undefined;
    this.#paths = undefined;
    controller?.dispose();
    if (server) await server.stop();
    if (paths) await removeConnectionDescriptor(paths);
    this.#sessionKey = undefined;
    this.#revision = 1;
    this.#current = {};
    this.#branchId = "root";
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#operation.then(operation, operation);
    this.#operation = next.catch(() => undefined);
    return next;
  }
}
