import { randomBytes } from "node:crypto";
import {
  removeConnectionDescriptor,
  writeConnectionDescriptor,
  createRuntimeDescriptor,
} from "../runtime/connection-file.js";
import {
  runtimePathsForSession,
  type ProjectGlanceRuntimePaths,
} from "../runtime/paths.js";
import {
  createStaticSnapshot,
  STATIC_FIXTURE_SESSION_KEY,
} from "./static-snapshot.js";
import { ProjectGlanceServer } from "../protocol/server.js";
import type { ProjectGlanceRuntimeDescriptor } from "../protocol/model.js";

export interface StaticFixtureRelayHooks {
  startServer?(server: ProjectGlanceServer): Promise<void>;
  afterReplacementStart?(
    server: ProjectGlanceServer,
    descriptor: ProjectGlanceRuntimeDescriptor,
  ): Promise<void>;
  writeDescriptor?(
    paths: ProjectGlanceRuntimePaths,
    descriptor: ProjectGlanceRuntimeDescriptor,
  ): Promise<void>;
}

export interface StaticFixtureRelayOptions {
  longFeed?: boolean;
  hooks?: StaticFixtureRelayHooks;
}

export interface StaticFixtureRelay {
  readonly paths: ProjectGlanceRuntimePaths;
  readonly sessionKey: string;
  get descriptor(): ProjectGlanceRuntimeDescriptor;
  restart(now?: string): Promise<void>;
  stop(): Promise<void>;
}

class StaticFixtureRelayImpl implements StaticFixtureRelay {
  readonly paths: ProjectGlanceRuntimePaths;
  readonly sessionKey: string;
  #descriptor: ProjectGlanceRuntimeDescriptor;
  #server: ProjectGlanceServer | undefined;
  #longFeed: boolean;
  #hooks: StaticFixtureRelayHooks;
  #generationIndex = 0;
  #operation: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(
    paths: ProjectGlanceRuntimePaths,
    descriptor: ProjectGlanceRuntimeDescriptor,
    server: ProjectGlanceServer,
    options: StaticFixtureRelayOptions,
  ) {
    this.paths = paths;
    this.sessionKey = descriptor.sessionKey;
    this.#descriptor = descriptor;
    this.#server = server;
    this.#longFeed = options.longFeed === true;
    this.#hooks = options.hooks ?? {};
  }

  get descriptor(): ProjectGlanceRuntimeDescriptor {
    return this.#descriptor;
  }

  async restart(now = new Date().toISOString()): Promise<void> {
    return this.#enqueue(() => this.#restartNow(now));
  }

  async #restartNow(now: string): Promise<void> {
    if (this.#stopped || !this.#server) throw new Error("PROJECT_GLANCE_RELAY_STOPPED");
    const previousServer = this.#server;
    const previousDescriptor = this.#descriptor;
    await previousServer.stop();
    let replacement: ProjectGlanceServer | undefined;
    try {
      const descriptor = createRuntimeDescriptor(this.paths, this.sessionKey, now);
      replacement = new ProjectGlanceServer({
        paths: this.paths,
        sessionKey: descriptor.sessionKey,
        token: descriptor.token,
        generation: descriptor.generation,
        snapshot: createStaticSnapshot(
          descriptor.sessionKey,
          now,
          this.#generationIndex + 1,
          this.#longFeed,
        ),
      });
      await this.#startServer(replacement);
      await this.#hooks.afterReplacementStart?.(replacement, descriptor);
      await this.#writeDescriptor(descriptor);
      this.#server = replacement;
      this.#descriptor = descriptor;
      this.#generationIndex += 1;
      return;
    } catch (error) {
      await replacement?.stop();
      try {
        await previousServer.start();
        await this.#writeDescriptor(previousDescriptor);
        this.#server = previousServer;
        this.#descriptor = previousDescriptor;
      } catch {
        await previousServer.stop();
        await removeConnectionDescriptor(this.paths);
        this.#server = undefined;
        this.#descriptor = previousDescriptor;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    return this.#enqueue(async () => {
      this.#stopped = true;
      const server = this.#server;
      this.#server = undefined;
      if (server) await server.stop();
      await removeConnectionDescriptor(this.paths);
    });
  }

  async #startServer(server: ProjectGlanceServer): Promise<void> {
    if (this.#hooks.startServer) return this.#hooks.startServer(server);
    await server.start();
  }

  async #writeDescriptor(descriptor: ProjectGlanceRuntimeDescriptor): Promise<void> {
    if (this.#hooks.writeDescriptor) {
      await this.#hooks.writeDescriptor(this.paths, descriptor);
      return;
    }
    await writeConnectionDescriptor(this.paths, descriptor);
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#operation.then(operation, operation);
    this.#operation = next.catch(() => undefined);
    return next;
  }
}

export async function startStaticFixtureRelay(
  environment: NodeJS.ProcessEnv,
  now = "2026-09-02T00:00:00.000Z",
  options: StaticFixtureRelayOptions = {},
): Promise<StaticFixtureRelay> {
  const paths = runtimePathsForSession(STATIC_FIXTURE_SESSION_KEY, environment);
  const descriptor = createRuntimeDescriptor(paths, STATIC_FIXTURE_SESSION_KEY, now);
  const server = new ProjectGlanceServer({
    paths,
    sessionKey: descriptor.sessionKey,
    token: descriptor.token,
    generation: descriptor.generation,
    snapshot: createStaticSnapshot(descriptor.sessionKey, now, 0, options.longFeed === true),
  });
  const startServer = options.hooks?.startServer ?? ((value: ProjectGlanceServer) => value.start());
  const writeDescriptor = options.hooks?.writeDescriptor ?? writeConnectionDescriptor;
  try {
    await startServer(server);
    await writeDescriptor(paths, descriptor);
  } catch (error) {
    await server.stop();
    try {
      await removeConnectionDescriptor(paths);
    } catch {
      // Best-effort cleanup must not replace the original startup failure.
    }
    throw error;
  }
  return new StaticFixtureRelayImpl(paths, descriptor, server, options);
}

export function createDisposableFixtureEnvironment(
  base: NodeJS.ProcessEnv,
  runtimeDirectory: string,
): NodeJS.ProcessEnv {
  return {
    ...base,
    XDG_RUNTIME_DIR: runtimeDirectory,
    PI_PROJECT_GLANCE_FIXTURE: randomBytes(8).toString("hex"),
  };
}
