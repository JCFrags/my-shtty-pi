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
import { createStaticSnapshot } from "../fixture/static-snapshot.js";
import { ProjectGlanceServer } from "../protocol/server.js";
import type { ProjectGlanceRuntimeDescriptor } from "../protocol/model.js";

export class ProjectGlanceRelayRuntime {
  #paths: ProjectGlanceRuntimePaths | undefined;
  #server: ProjectGlanceServer | undefined;
  #sessionKey: string | undefined;
  #environment: NodeJS.ProcessEnv;
  #operation: Promise<void> = Promise.resolve();

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.#environment = environment;
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

  async ensureForContext(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionKey = deriveSessionKey(sessionId);
    return this.#enqueue(async () => {
      if (this.#sessionKey === sessionKey && this.#server?.started) return;
      await this.#stopNow();
      await this.#startNow(sessionKey);
    });
  }

  async start(sessionKey: string, now = new Date().toISOString()): Promise<void> {
    return this.#enqueue(() => this.#startNow(sessionKey, now));
  }

  async #startNow(sessionKey: string, now = new Date().toISOString()): Promise<void> {
    if (this.#server?.started && this.#sessionKey === sessionKey) return;
    await this.#stopNow();
    const paths = runtimePathsForSession(sessionKey, this.#environment);
    const descriptor = createRuntimeDescriptor(paths, sessionKey, now);
    const server = new ProjectGlanceServer({
      paths,
      sessionKey: descriptor.sessionKey,
      token: descriptor.token,
      generation: descriptor.generation,
      snapshot: createStaticSnapshot(descriptor.sessionKey, now),
    });
    try {
      await server.start();
      await writeConnectionDescriptor(paths, descriptor);
    } catch (error) {
      await server.stop();
      throw error;
    }
    this.#paths = paths;
    this.#server = server;
    this.#sessionKey = descriptor.sessionKey;
  }

  async restart(now = new Date().toISOString()): Promise<void> {
    return this.#enqueue(async () => {
      const sessionKey = this.#sessionKey;
      if (!sessionKey) throw new Error("PROJECT_GLANCE_RUNTIME_MISSING");
      await this.#stopNow();
      await this.#startNow(sessionKey, now);
    });
  }

  async stop(): Promise<void> {
    return this.#enqueue(() => this.#stopNow());
  }

  async #stopNow(): Promise<void> {
    const server = this.#server;
    const paths = this.#paths;
    this.#server = undefined;
    this.#paths = undefined;
    this.#sessionKey = undefined;
    if (server) await server.stop();
    if (paths) await removeConnectionDescriptor(paths);
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#operation.then(operation, operation);
    this.#operation = next.catch(() => undefined);
    return next;
  }

  onSessionTree(): void {
    // Session-tree navigation keeps the same session reference and relay.
  }
}
