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
  type ProjectGlanceFeedItem,
  type ProjectGlanceSnapshot,
} from "../protocol/model.js";
import { validateSnapshot } from "../protocol/validation.js";
import {
  boundRecentFeed,
  rebuildProgressFeed,
  compareFeedItems,
} from "../feed/index.js";
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

type ProjectGlanceSessionContext = Pick<ExtensionContext, "sessionManager">;

function boundedSnapshot(
  sessionKey: string,
  revision: number,
  generatedAt: string,
  current: ProjectGlanceCurrent,
  feed: readonly ProjectGlanceFeedItem[],
): ProjectGlanceSnapshot | undefined {
  const candidates = boundRecentFeed(feed);
  for (let removed = 0; removed <= candidates.length; removed += 1) {
    try {
      return validateSnapshot({
        protocolVersion: PROJECT_GLANCE_PROTOCOL_VERSION,
        sessionKey,
        revision,
        generatedAt,
        current: { ...current },
        feed: candidates.slice(removed).map((item) => ({ ...item })),
      });
    } catch {
      // Remove the oldest useful item until the correlated wire budget fits.
    }
  }
  return undefined;
}

export class ProjectGlanceRelayRuntime {
  #paths: ProjectGlanceRuntimePaths | undefined;
  #server: ProjectGlanceServer | undefined;
  #controller: ProjectGlanceCurrentController | undefined;
  #sessionKey: string | undefined;
  #generationIndex = 0;
  #revision = 1;
  #current: ProjectGlanceCurrent = {};
  #feed: ProjectGlanceFeedItem[] = [];
  #branchId = "root";
  #environment: NodeJS.ProcessEnv;
  #eventBus: ProjectGlanceEventBus | undefined;
  #operation: Promise<void> = Promise.resolve();
  #lifecycleEpoch = 0;
  #feedSyncTimers = new Set<ReturnType<typeof setImmediate>>();
  #context: ProjectGlanceSessionContext | undefined;

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

  get feed(): ProjectGlanceFeedItem[] {
    return this.#feed.map((item) => ({ ...item }));
  }

  async ensureForContext(ctx: ExtensionContext): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionKey = deriveSessionKey(sessionId);
    const branchId = branchIdForContext(ctx);
    return this.#enqueue(async () => {
      this.#context = ctx;
      if (this.#sessionKey === sessionKey && this.#server?.started) {
        if (this.#branchId !== branchId) await this.#transitionBranch(branchId);
        await this.#syncFeedFromContext(ctx);
        return;
      }
      await this.#stopNow();
      await this.#startNow(sessionKey, new Date().toISOString(), 0, branchId);
      this.#context = ctx;
      await this.#syncFeedFromContext(ctx);
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
    this.#feed = [];
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
      const context = this.#context;
      await this.#stopNow(true);
      await this.#startNow(sessionKey, now, nextGenerationIndex, branchId);
      if (context) {
        this.#context = context;
        await this.#syncFeedFromContext(context);
      }
    });
  }

  async stop(): Promise<void> {
    return this.#enqueue(() => this.#stopNow());
  }

  refreshCurrent(): void {
    this.#controller?.refresh();
  }

  /** Rebuild the bounded feed from the supplied active session branch. */
  async syncFeed(ctx: ProjectGlanceSessionContext): Promise<void> {
    return this.#enqueue(async () => {
      this.#context = ctx;
      await this.#syncFeedFromContext(ctx);
    });
  }

  /**
   * Schedule a rebuild after Pi's message_end handler returns. AgentSession
   * persists the finalized message immediately after extension handlers and
   * listeners, so the next turn sees the stable SessionManager entry ID.
   */
  onMessageEnd(ctx: ProjectGlanceSessionContext): void {
    const sessionKey = (() => {
      try {
        return deriveSessionKey(ctx.sessionManager.getSessionId());
      } catch {
        return undefined;
      }
    })();
    if (!sessionKey) return;
    const epoch = this.#lifecycleEpoch;
    const timer = setImmediate(() => {
      this.#feedSyncTimers.delete(timer);
      void this.#enqueue(async () => {
        if (epoch !== this.#lifecycleEpoch || sessionKey !== this.#sessionKey || !this.#server?.started) return;
        await this.#syncFeedFromContext(ctx);
      }).catch(() => undefined);
    });
    timer.unref?.();
    this.#feedSyncTimers.add(timer);
  }

  async onSessionTree(ctx: ExtensionContext): Promise<void> {
    const branchId = branchIdForContext(ctx);
    return this.#enqueue(async () => {
      this.#context = ctx;
      await this.#transitionBranch(branchId);
      await this.#syncFeedFromContext(ctx);
    });
  }

  async #transitionBranch(branchId: string): Promise<void> {
    if (this.#branchId === branchId) return;
    this.#lifecycleEpoch += 1;
    this.#branchId = branchId;
    this.#feed = [];
    if (this.#controller) {
      this.#controller.onSessionTree(branchId);
    } else {
      this.#publishCurrent({}, []);
    }
  }

  async #syncFeedFromContext(ctx: ProjectGlanceSessionContext): Promise<void> {
    if (!this.#server?.started || !this.#sessionKey) return;
    let nextFeed: ProjectGlanceFeedItem[];
    try {
      nextFeed = rebuildProgressFeed(ctx.sessionManager.getBranch());
    } catch {
      return;
    }
    this.#publishCurrent(this.#current, nextFeed);
  }

  #publishCurrent(current: ProjectGlanceCurrent, feed: readonly ProjectGlanceFeedItem[] = this.#feed): boolean {
    const server = this.#server;
    if (!server?.started || !this.#sessionKey) return false;
    if (JSON.stringify(current) === JSON.stringify(this.#current) && compareFeedItems(feed, this.#feed)) return true;
    const nextRevision = this.#revision + 1;
    const next = boundedSnapshot(
      this.#sessionKey,
      nextRevision,
      new Date().toISOString(),
      current,
      feed,
    );
    if (!next) return false;
    try {
      if (!server.publish(next)) return false;
    } catch {
      return false;
    }
    this.#revision = nextRevision;
    this.#current = { ...current };
    this.#feed = next.feed.map((item) => ({ ...item }));
    return true;
  }

  async #stopNow(preserveContext = false): Promise<void> {
    this.#lifecycleEpoch += 1;
    for (const timer of this.#feedSyncTimers) clearImmediate(timer);
    this.#feedSyncTimers.clear();
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
    this.#feed = [];
    this.#branchId = "root";
    if (!preserveContext) this.#context = undefined;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#operation.then(operation, operation);
    this.#operation = next.catch(() => undefined);
    return next;
  }
}
