import { randomBytes } from "node:crypto";
import { removeConnectionDescriptor, writeConnectionDescriptor, createRuntimeDescriptor } from "../runtime/connection-file.js";
import { runtimePathsForSession, type ProjectGlanceRuntimePaths } from "../runtime/paths.js";
import { createStaticSnapshot, STATIC_FIXTURE_SESSION_KEY } from "./static-snapshot.js";
import { ProjectGlanceServer } from "../protocol/server.js";
import type { ProjectGlanceRuntimeDescriptor } from "../protocol/model.js";

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
  #server: ProjectGlanceServer;

  constructor(
    paths: ProjectGlanceRuntimePaths,
    descriptor: ProjectGlanceRuntimeDescriptor,
    server: ProjectGlanceServer,
  ) {
    this.paths = paths;
    this.sessionKey = descriptor.sessionKey;
    this.#descriptor = descriptor;
    this.#server = server;
  }

  get descriptor(): ProjectGlanceRuntimeDescriptor {
    return this.#descriptor;
  }

  async restart(now = new Date().toISOString()): Promise<void> {
    await this.#server.stop();
    const descriptor = createRuntimeDescriptor(this.paths, this.sessionKey, now);
    const server = new ProjectGlanceServer({
      paths: this.paths,
      sessionKey: descriptor.sessionKey,
      token: descriptor.token,
      generation: descriptor.generation,
      snapshot: createStaticSnapshot(descriptor.sessionKey, now),
    });
    await server.start();
    await writeConnectionDescriptor(this.paths, descriptor);
    this.#server = server;
    this.#descriptor = descriptor;
  }

  async stop(): Promise<void> {
    await this.#server.stop();
    await removeConnectionDescriptor(this.paths);
  }
}

export async function startStaticFixtureRelay(
  environment: NodeJS.ProcessEnv,
  now = "2026-09-02T00:00:00.000Z",
): Promise<StaticFixtureRelay> {
  const paths = runtimePathsForSession(STATIC_FIXTURE_SESSION_KEY, environment);
  const descriptor = createRuntimeDescriptor(paths, STATIC_FIXTURE_SESSION_KEY, now);
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
  return new StaticFixtureRelayImpl(paths, descriptor, server);
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
