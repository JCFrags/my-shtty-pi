import { ProjectGlanceHistoryController } from "./history-controller.js";
import type { ProjectGlanceQuestion, ProjectGlanceQuestionAction, ProjectGlanceQuestionAttention } from "../questions/model.js";
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
  type ProjectGlanceUiState,
} from "../protocol/model.js";
import { validateSnapshot } from "../protocol/validation.js";
import {
  boundRecentFeed,
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
  branchId: string,
  uiState: ProjectGlanceUiState,
  focusSerial: number,
  questions: readonly ProjectGlanceQuestion[] = [],
  archive?: ProjectGlanceSnapshot["archive"],
  questionAttention: readonly ProjectGlanceQuestionAttention[] = [],
): ProjectGlanceSnapshot | undefined {
  const candidates = boundRecentFeed(feed);
  for (let removed = 0; removed <= candidates.length; removed += 1) {
    try {
      return validateSnapshot({
        protocolVersion: PROJECT_GLANCE_PROTOCOL_VERSION,
        sessionKey,
        revision,
        generatedAt,
        branchId,
        current: { ...current },
        feed: candidates.slice(removed).map((item) => ({ ...item })),
        uiState,
        ...(focusSerial > 0 ? { focusSerial } : {}),
        ...(questions.length ? { questions } : {}),
        ...(archive ? { archive } : {}),
        ...(questionAttention.length ? { questionAttention } : {}),
      });
    } catch {
      // Remove the oldest useful item until the correlated wire budget fits.
    }
  }
  return undefined;
}

export interface ProjectGlanceQuestionProvider {
  questions(): ProjectGlanceQuestion[];
  hiddenAttention?(): ProjectGlanceQuestionAttention[];
  setEditing?(owner: object, value: { questionId: string; expectedRevision: number; active: boolean }): boolean;
  releaseEditing?(owner: object): void;
  applyAction(action: ProjectGlanceQuestionAction, actionId: string): boolean | Promise<boolean>;
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
  #uiState: ProjectGlanceUiState = { dismissedIds: [], readIds: [] };
  #branchId = "root";
  #currentBranchId = "root";
  #environment: NodeJS.ProcessEnv;
  #eventBus: ProjectGlanceEventBus | undefined;
  #operation: Promise<void> = Promise.resolve();
  #lifecycleEpoch = 0;
  #feedSyncTimers = new Set<ReturnType<typeof setImmediate>>();
  #context: ProjectGlanceSessionContext | undefined;
  readonly #onUnreadChange: ((count: number, questions: number, storageError?: boolean) => void) | undefined;
  #questionAttention: ProjectGlanceQuestionAttention[] = [];
  #editingOwners = new Map<string, object>();
  readonly #questionProvider: ProjectGlanceQuestionProvider | undefined;
  #questions: ProjectGlanceQuestion[] = [];
  #focusSerial = 0;
  #publishedFocusSerial = 0;
  readonly #history: ProjectGlanceHistoryController;
  #publishedArchive: ProjectGlanceSnapshot["archive"];

  constructor(environment: NodeJS.ProcessEnv = process.env, eventBus?: ProjectGlanceEventBus, _appendUiEntry?: (data: unknown) => void, onUnreadChange?: (count: number, questions: number, storageError?: boolean) => void, questionProvider?: ProjectGlanceQuestionProvider) {
    this.#environment = environment;
    this.#history = new ProjectGlanceHistoryController(environment);
    this.#eventBus = eventBus;
    this.#onUnreadChange = onUnreadChange;
    this.#questionProvider = questionProvider;
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
        // Leaf IDs advance on every ordinary append. Only session_tree is a
        // branch transition; command reconciliation must not reset state.
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
      snapshot: { ...createLiveSnapshot(descriptor.sessionKey, now), branchId },
      onConnected: () => {
        const epoch = this.#lifecycleEpoch;
        return this.#enqueue(async () => {
          if (epoch !== this.#lifecycleEpoch || this.#server !== server || !this.#context) return;
          await this.#syncFeedFromContext(this.#context);
        });
      },
      onEditingChanged: () => this.#syncEditing(),
      onPage: (frame) => {
        try { return this.#history.page({ branchId: frame.branchId, view: frame.view, ...(frame.cursor ? { cursor: frame.cursor } : {}) }); }
        finally { this.#publishCurrent(this.#current); }
      },
      onBody: (frame) => {
        try { return this.#history.body({ branchId: frame.branchId, itemId: frame.itemId, offset: frame.offset }); }
        finally { this.#publishCurrent(this.#current); }
      },
      onAction: (frame) => {
        const epoch = this.#lifecycleEpoch;
        return this.#enqueue(async () => {
          if (epoch !== this.#lifecycleEpoch || this.#server !== server || !this.#context ||
              frame.branchId !== this.#branchId || frame.baseRevision !== this.#revision) return undefined;
          if ("questionId" in frame.action) {
            if (!await this.#questionProvider?.applyAction(frame.action, frame.actionId)) return undefined;
            await this.#syncFeedFromContext(this.#context);
            return this.#revision;
          }
          // Focus and expansion never change inbox state. Only durable archive
          // success can acknowledge a dismissal.
          if (frame.action.type !== "dismiss") return this.#revision;
          if (!frame.action.itemId) return undefined;
          const accepted = this.#history.archive(this.#branchId, frame.action.itemId, frame.actionId);
          this.#publishCurrent(this.#current, []);
          return accepted ? this.#revision : undefined;
        });
      },
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
    this.#uiState = { dismissedIds: [], readIds: [] };
    this.#focusSerial = 0;
    this.#publishedFocusSerial = 0;
    this.#branchId = branchId;
    this.#currentBranchId = this.#context ? branchIdForContext(this.#context as ExtensionContext) : branchId;
    if (this.#eventBus) {
      this.#controller = new ProjectGlanceCurrentController({
        eventBus: this.#eventBus,
        onChange: (current) => this.#publishCurrent(current),
      });
      this.#controller.start(this.#currentBranchId);
    }
  }

  async restart(now = new Date().toISOString()): Promise<void> {
    return this.#enqueue(async () => {
      const sessionKey = this.#sessionKey;
      if (!sessionKey) throw new Error("PROJECT_GLANCE_RUNTIME_MISSING");
      const nextGenerationIndex = this.#generationIndex + 1;
      const branchId = this.#currentBranchId;
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
    this.#lifecycleEpoch += 1;
    return this.#enqueue(() => this.#stopNow());
  }

  async refreshQuestions(): Promise<void> {
    return this.#enqueue(async () => { this.#publishCurrent(this.#current); });
  }

  refreshCurrent(): void {
    this.#controller?.refresh();
  }

  capturePaneFocus(): () => Promise<void> {
    const epoch = this.#lifecycleEpoch;
    const server = this.#server;
    return async () => {
      // A new pane must receive its passive baseline first. Never leave a focus
      // request behind for a later unattended reconnect to consume.
      const deadline = Date.now() + 2_000;
      while (server?.started && server.connectedClients === 0 && epoch === this.#lifecycleEpoch && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await this.#enqueue(async () => {
        if (epoch !== this.#lifecycleEpoch || server !== this.#server || !server?.connectedClients) return;
        this.#focusSerial += 1;
        this.#publishCurrent(this.#current, this.#feed);
      });
    };
  }

  async notifyPaneFocused(): Promise<void> {
    await this.capturePaneFocus()();
  }

  /** Rebuild the bounded feed from the supplied active session branch. */
  async syncFeed(ctx: ProjectGlanceSessionContext): Promise<void> {
    return this.#enqueue(async () => {
      this.#context = ctx;
      await this.#syncFeedFromContext(ctx);
    });
  }

  /**
   * Best-effort early rebuild. Later asynchronous message_end handlers can
   * delay persistence beyond this timer. Ordered tool/turn/agent boundaries
   * perform the reliable post-persistence rebuild with stable entry IDs.
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
    this.#lifecycleEpoch += 1;
    const branchId = branchIdForContext(ctx);
    return this.#enqueue(async () => {
      this.#context = ctx;
      this.#currentBranchId = branchId;
      this.#controller?.onSessionTree(branchId);
      const durableBranch = this.#sessionKey ? this.#history.sync(this.#sessionKey, ctx.sessionManager, "tree") : undefined;
      await this.#transitionBranch(durableBranch ?? branchId);
      this.#publishCurrent(this.#current, []);
    });
  }

  async #transitionBranch(branchId: string): Promise<void> {
    if (this.#branchId === branchId) return;
    this.#lifecycleEpoch += 1;
    this.#branchId = branchId;
    this.#focusSerial = 0;
    this.#publishedFocusSerial = -1;
    // The CURRENT providers use Pi leaf identities, not archive branch IDs.
    // Publish the empty destination before rebuilding it. Do not mutate the
    // accepted feed first: publication comparison must still see the old
    // branch so an empty destination cannot leave old cards on the relay.
    this.#publishCurrent({}, []);
  }

  async #syncFeedFromContext(ctx: ProjectGlanceSessionContext): Promise<void> {
    if (!this.#server?.started || !this.#sessionKey) return;
    const branchId = this.#history.sync(this.#sessionKey, ctx.sessionManager);
    if (branchId && branchId !== this.#branchId) {
      this.#branchId = branchId;
      this.#publishedArchive = undefined;
    }
    this.#publishCurrent(this.#current, []);
  }

  #publishCurrent(current: ProjectGlanceCurrent, feed: readonly ProjectGlanceFeedItem[] = this.#feed): boolean {
    const server = this.#server;
    if (!server?.started || !this.#sessionKey) return false;
    const nextUiState: ProjectGlanceUiState = { dismissedIds: [], readIds: [] };
    const archive = this.#history.status;
    const questions = this.#questionProvider?.questions() ?? [];
    const questionAttention = this.#questionProvider?.hiddenAttention?.() ?? [];
    const unchanged =
      JSON.stringify(questionAttention) === JSON.stringify(this.#questionAttention) &&
      JSON.stringify(archive) === JSON.stringify(this.#publishedArchive) &&
      JSON.stringify(questions) === JSON.stringify(this.#questions) &&
      JSON.stringify(current) === JSON.stringify(this.#current) &&
      compareFeedItems(feed, this.#feed) &&
      JSON.stringify(nextUiState) === JSON.stringify(this.#uiState) &&
      this.#focusSerial === this.#publishedFocusSerial;
    if (unchanged) return true;
    const nextRevision = this.#revision + 1;
    const next = boundedSnapshot(
      this.#sessionKey,
      nextRevision,
      new Date().toISOString(),
      current,
      feed,
      this.#branchId,
      nextUiState,
      this.#focusSerial,
      questions,
      archive,
      questionAttention,
    );
    if (!next) return false;
    try {
      if (!server.publish(next)) return false;
    } catch {
      return false;
    }
    this.#questionAttention = structuredClone(next.questionAttention ?? []);
    this.#publishedArchive = next.archive;
    this.#questions = structuredClone(next.questions ?? []);
    this.#revision = nextRevision;
    this.#current = { ...current };
    this.#feed = next.feed.map((item) => ({ ...item }));
    this.#uiState = {
      dismissedIds: [...(next.uiState?.dismissedIds ?? [])],
      readIds: [...(next.uiState?.readIds ?? [])],
    };
    this.#publishedFocusSerial = this.#focusSerial;
    this.#onUnreadChange?.(archive.inboxCount, this.#questions.length + this.#questionAttention.length, archive.state === "error");
    return true;
  }

  #syncEditing(): void {
    const active = new Set<string>();
    for (const question of this.#questionProvider?.questions() ?? []) {
      if (!this.#server?.isQuestionEditing(this.#branchId, question.id, question.revision)) continue;
      active.add(question.id);
      let owner = this.#editingOwners.get(question.id);
      if (!owner) { owner = {}; this.#editingOwners.set(question.id, owner); }
      this.#questionProvider?.setEditing?.(owner, { questionId: question.id, expectedRevision: question.revision, active: true });
    }
    for (const [id, owner] of this.#editingOwners) {
      if (active.has(id)) continue;
      this.#editingOwners.delete(id);
      this.#questionProvider?.releaseEditing?.(owner);
    }
  }

  async #stopNow(preserveContext = false): Promise<void> {
    this.#lifecycleEpoch += 1;
    this.#onUnreadChange?.(0, 0);
    this.#questions = [];
    this.#questionAttention = [];
    for (const owner of this.#editingOwners.values()) this.#questionProvider?.releaseEditing?.(owner);
    this.#editingOwners.clear();
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
    this.#uiState = { dismissedIds: [], readIds: [] };
    this.#focusSerial = 0;
    this.#publishedFocusSerial = 0;
    this.#branchId = "root";
    this.#history.close();
    this.#publishedArchive = undefined;
    if (!preserveContext) this.#context = undefined;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#operation.then(operation, operation);
    this.#operation = next.then(() => undefined, () => undefined);
    return next;
  }
}
