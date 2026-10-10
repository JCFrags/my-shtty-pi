import type { WebContents } from "electron";
import { ALL_INPUT } from "../agent/input-arbiter";
import { BrowserDownloads } from "../agent/downloads";
import type { BlockingRequest, BlockingStatus } from "../blocking/types";
import type { BrowserOwner } from "pixel-store";
import type { BrowserDialog, BrowserDialogs, DialogResponse } from "../agent/dialogs";
import type { CertificateRequest } from "../agent/certificates";
import type { PopupWindow } from "../page/popup";
import { BrowserAgentRuntime } from "../agent/runtime";
import type { BrowserControl } from "../agent/control";
import {
  createSlowNaturalPersonaProvider,
  type AgentPersonaProvider,
} from "../agent/interaction-profile";
import type {
  AgentActionOutcome,
  AgentActivity,
  AgentBrowserTarget,
  AgentClickRequest,
  AgentUploadRequest,
  AgentClickResult,
  AgentDragRequest,
  AgentDragResult,
  AgentGetUrlRequest,
  AgentGetUrlResult,
  AgentHoverRequest,
  AgentHoverResult,
  AgentNavigateRequest,
  AgentNavigateResult,
  AgentObservation,
  AgentVisualObservation,
  AgentObserveRequest,
  AgentPressKeyRequest,
  AgentPressKeyResult,
  AgentScrollRequest,
  AgentScrollResult,
  AgentTypeRequest,
  AgentTypeResult,
  AgentWaitForRequest,
  AgentWaitForResult,
} from "../agent/types";
import type { BrowserController } from "../page/controller";
import type { DevtoolsAction } from "../page/devtools";
import { initialBrowserState } from "../page/types";
import type { BrowserState } from "../page/types";
import type { TabRow } from "../ui/types";
import { displayUrl } from "../url";
import { sanitizeTabRecoveryUrl, TAB_RECOVERY_LIMITS } from "./tab-recovery";
import type { TabRecoveryEntry, TabRecoveryTabs } from "./tab-recovery";

export interface VisiblePage {
  contextId: number;
  contextKind: "tab" | "popup";
  documentGeneration: number;
  viewRevision: number;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  contents: WebContents;
}
export interface VisiblePageChange {
  contextId: number;
  reason: "navigation" | "paint" | "context" | "geometry";
  dirtyRect?: { x: number; y: number; width: number; height: number };
}

export interface TabApp {
  name: string | null;
  id: string;
}

export interface TabOptions {
  app?: TabApp;
  partition?: string | null;
}

export interface Tab {
  readonly id: number;
  state: BrowserState;
  controller: BrowserController;
  agentRuntime: BrowserAgentRuntime;
  targetId: string | null;
  app: TabApp | null;
  agentControlAt: number | null;
}

type DormantTab = Omit<Tab, "controller" | "agentRuntime">;
type RootTab = Tab | DormantTab;

function liveTab(tab: RootTab): tab is Tab { return "controller" in tab; }

export interface TabRecoveryChange {
  reason: "navigation" | "created" | "activated" | "closed" | "restored";
  immediate: boolean;
  snapshot: TabRecoveryTabs | null;
}

interface PopupContext {
  id: number;
  openerId: number;
  rootId: number;
  controller: PopupWindow;
  agentRuntime: BrowserAgentRuntime;
}

export interface TabTarget {
  contextId: number;
  openerId: number | null;
  kind: "tab" | "popup";
  id: number;
  url: string;
  title: string;
  active: boolean;
  targetId: string | null;
  app?: TabApp | null;
  timeOrigin?: number | null;
  agentControlled: boolean;
  dormant?: boolean;
}


export interface TabHost {
  owner?: BrowserOwner | null;
  projectRoot?: string | null;
  onDownload?: (value: import("../agent/downloads").BrowserDownload) => void;
  createController(
    url: string,
    visible: boolean,
    onState: (state: BrowserState) => void,
    options: TabOptions & { tabId: number },
  ): BrowserController;
  onActivated(): void;
  onActiveState(state: BrowserState, urlChanged: boolean): void;
  onCursorChanged(): void;
  onDevtoolsChanged(): void;
  onDevtoolsAction(action: DevtoolsAction): void;
  onPageMenu(params: Electron.ContextMenuParams): void;
  onTabsChanged(): void;
  requestAgentRender(): void;
  onTabOpened(opener: BrowserController, url: string): void;
  onTabClosed(id: number): void;
  tabSwitchAllowed(): boolean;
  agentTabSwitchAllowed(): boolean;
  requestRender(): void;
}

const parsedTtl = Number(process.env.TERMINAL_BROWSER_AGENT_CONTROL_MS);
const AGENT_CONTROL_TTL_MS = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : 10_000;
const AGENT_CONTROL_SWEEP_MS = 500;

export class TabManager {
  readonly downloads: BrowserDownloads;
  private tabs: RootTab[] = [];
  private readonly recoveryEntries = new Map<number, TabRecoveryEntry>();
  private readonly initialRecoveryLoads = new Set<number>();
  private readonly recoveryListeners = new Set<(change: TabRecoveryChange) => void>();
  private recoveryBatch = 0;
  private recoveryStopped = false;
  private activeId = 0;
  private activeContextId = 0;
  private readonly popups = new Map<number, PopupContext>();
  private readonly contextListeners = new Set<() => void>();
  private seq = 1;
  private readonly pageListeners = new Set<(change: VisiblePageChange) => void>();
  private pageObserver: { binding: string; source: string; listener: (hint: import("../agent/frames").FramePageChange & { contextId: number }) => void } | null = null;

  installPageChangeObserver(binding: string, source: string, listener: (hint: import("../agent/frames").FramePageChange & { contextId: number }) => void): void {
    if (this.pageObserver) throw new Error("page-change observer is already installed");
    this.pageObserver = { binding, source, listener };
    for (const context of [...this.tabs.filter(liveTab), ...this.popups.values()]) this.attachPageObserver(context.id, context.controller);
  }
  private attachPageObserver(contextId: number, controller: BrowserController | PopupWindow): void {
    const observer = this.pageObserver;
    if (!observer) return;
    void controller.frames.installPageChangeObserver(observer.binding, observer.source, hint => {
      if (this.currentVisiblePage()?.contextId === contextId) observer.listener({ contextId, ...hint });
    }).catch(() => { /* Native paint/navigation remain available if a frame observer is unavailable. */ });
  }
  sessionClosePending = false;
  get visibleContextId(): number { return this.activeContextId; }
  private agentSweep: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly host: TabHost,
    private readonly fallbackUrl: string,
    private readonly control: BrowserControl,
    private readonly personaProvider: AgentPersonaProvider = createSlowNaturalPersonaProvider(),
  ) { this.downloads = new BrowserDownloads(host.projectRoot ?? null, host.owner ?? null, host.onDownload); }

  get active(): Tab | null {
    const tab = this.tabs.find((tab) => tab.id === this.activeId);
    return tab && liveTab(tab) ? tab : null;
  }

  get activeAgentActivity(): AgentActivity | null {
    return this.context(this.activeContextId)?.agentRuntime.activity ?? null;
  }

  get activeController(): BrowserController | null {
    return this.active?.controller ?? null;
  }

  get activeState(): BrowserState | null {
    return this.active?.state ?? null;
  }

  get count(): number {
    return this.tabs.length;
  }

  subscribeRecoveryChanges(listener: (change: TabRecoveryChange) => void): () => void {
    this.recoveryListeners.add(listener);
    return () => this.recoveryListeners.delete(listener);
  }

  recoverySnapshot(): TabRecoveryTabs | null {
    const roots = this.tabs.filter(tab => !tab.app);
    if (roots.length > TAB_RECOVERY_LIMITS.tabs) return null;
    const entries = roots.map(tab => {
      const entry = this.recoveryEntries.get(tab.id) ?? sanitizeTabRecoveryUrl("about:blank");
      return entry.kind === "url" ? { kind: "url" as const, url: entry.url }
        : { kind: "excluded" as const, url: "about:blank" as const, reason: entry.reason };
    });
    const active = roots.findIndex(tab => tab.id === this.activeId);
    return { entries, activeIndex: entries.length ? Math.max(0, active) : null };
  }

  private emitRecoveryChange(reason: TabRecoveryChange["reason"]): void {
    if (this.recoveryStopped || this.recoveryBatch) return;
    const change = { reason, immediate: reason === "closed", snapshot: this.recoverySnapshot() };
    for (const listener of this.recoveryListeners) listener(change);
  }

  /** Only a validated, explicit recovery choice may populate an empty paused manager. */
  restoreRecovery(snapshot: TabRecoveryTabs): number[] {
    if (this.tabs.length || this.popups.size || this.control.state !== "paused" || this.pendingDialog || this.sessionClosePending || this.recoveryStopped) throw new Error("tab recovery requires an empty paused browser");
    if (!Array.isArray(snapshot?.entries) || snapshot.entries.length > TAB_RECOVERY_LIMITS.tabs ||
      (snapshot.entries.length ? !Number.isSafeInteger(snapshot.activeIndex) || snapshot.activeIndex! < 0 || snapshot.activeIndex! >= snapshot.entries.length : snapshot.activeIndex !== null)) throw new Error("invalid tab recovery snapshot");
    const entries: TabRecoveryEntry[] = snapshot.entries.map(entry => {
      if (entry?.kind === "url") {
        const sanitized = sanitizeTabRecoveryUrl(entry.url);
        if (sanitized.kind === "url" && sanitized.url === entry.url) return sanitized;
      } else if (entry?.kind === "excluded" && entry.url === "about:blank" && [
        "non-web", "invalid-url", "control-character", "malformed-encoding", "userinfo",
        "sensitive-route", "auth-marker", "token-path", "url-too-long",
      ].includes(entry.reason)) return { kind: "excluded", url: "about:blank", reason: entry.reason };
      throw new Error("invalid tab recovery snapshot");
    });
    const ids: number[] = [];
    this.recoveryBatch += 1;
    try {
      for (const entry of entries) {
        const id = this.seq++;
        this.tabs.push({ id, state: { ...initialBrowserState(entry.url), loading: false }, targetId: null, app: null, agentControlAt: null });
        this.recoveryEntries.set(id, entry);
        ids.push(id);
      }
      if (snapshot.activeIndex !== null && !this.activate(ids[snapshot.activeIndex])) throw new Error("tab recovery selection was refused");
    } catch { throw new Error("tab recovery could not be created"); }
    finally { this.recoveryBatch -= 1; }
    this.host.onTabsChanged();
    this.host.requestRender();
    this.emitRecoveryChange("restored");
    return ids;
  }

  private materialize(root: RootTab): Tab {
    if (liveTab(root)) return root;
    const entry = this.recoveryEntries.get(root.id);
    if (!entry) throw new Error("dormant tab recovery metadata is unavailable");
    const tab = { id: root.id, state: initialBrowserState(entry.url), targetId: null, app: null, agentControlAt: null } as Tab;
    this.initialRecoveryLoads.add(tab.id);
    try { this.attachController(tab, entry.url, false, {}); }
    catch {
      this.initialRecoveryLoads.delete(tab.id);
      try { tab.controller?.stop(); } catch {}
      throw new Error("dormant tab could not be opened");
    }
    this.tabs[this.tabs.indexOf(root)] = tab;
    return tab;
  }

  create(url: string, activate = true, options: TabOptions = {}): Tab {
    if (this.pendingDialog) throw new Error("a browser dialog is pending");
    const tab = {
      id: this.seq++,
      state: initialBrowserState(url),
      targetId: null,
      app: options.app ?? null,
      agentControlAt: null,
    } as Tab;
    this.recoveryEntries.set(tab.id, sanitizeTabRecoveryUrl("about:blank"));
    this.recoveryBatch += 1;
    try {
      this.attachController(tab, url, activate, options);
      this.tabs.push(tab);
      if (activate) this.activate(tab.id);
    } finally { this.recoveryBatch -= 1; }
    this.host.onTabsChanged();
    this.emitRecoveryChange("created");
    return tab;
  }

  private attachController(tab: Tab, url: string, visible: boolean, options: TabOptions) {
    tab.controller = this.host.createController(url, visible, (state) => {
      const urlChanged = state.url !== tab.state.url;
      tab.state = state;
      if (tab.id === this.activeId) this.host.onActiveState(state, urlChanged);
      this.host.requestRender();
    }, { ...options, tabId: tab.id });
    tab.agentRuntime = new BrowserAgentRuntime(tab.controller, {
      control: this.control,
      personaProvider: this.personaProvider,
      onActivityChange: () => this.host.requestAgentRender(),
    });
    tab.controller.onNativePageChange = change => {
      if (change.reason === "navigation" && !tab.app && !this.recoveryStopped) {
        const committed = tab.controller.currentUrl();
        // Controller initialization loads an internal blank before the selected restored URL.
        if (!this.initialRecoveryLoads.has(tab.id) || committed !== "about:blank") {
          this.initialRecoveryLoads.delete(tab.id);
          this.recoveryEntries.set(tab.id, sanitizeTabRecoveryUrl(committed));
          this.emitRecoveryChange("navigation");
        }
      }
      this.emitPageChange({ contextId: tab.id, ...change });
    };
    this.attachPageObserver(tab.id, tab.controller);
    tab.controller.trackDownloads(this.downloads, tab.id);
    this.bindDialogs(tab.id, tab.controller.dialogs, tab.agentRuntime);
    tab.controller.onPopupCreated = (popup, opener) => this.adoptPopup(tab, popup, opener);
    tab.controller.onPopupClosed = (popup) => this.removePopup(popup);
    tab.controller.onMainFrameNavigationStart = () => tab.agentRuntime.invalidateDocument();
    tab.controller.onCursorChange = () => {
      if (tab.id === this.activeId) this.host.onCursorChanged();
    };
    tab.controller.onOpenTab = (openUrl, activateNew) => {
      this.create(openUrl, activateNew);
      this.host.onTabOpened(tab.controller, openUrl);
    };
    tab.controller.onPopupChange = () => { this.contextChanged(); this.host.requestRender(); };
    tab.controller.onClosed = () => this.host.onTabClosed(tab.id);
    tab.controller.onDevtoolsChange = () => {
      if (tab.id === this.activeId) this.host.onDevtoolsChanged();
      else this.host.requestRender();
    };
    tab.controller.onDevtoolsAction = (action) => {
      if (tab.id === this.activeId) this.host.onDevtoolsAction(action);
    };
    tab.controller.onContextMenu = (params) => {
      if (tab.id === this.activeId) this.host.onPageMenu(params);
    };
    tab.targetId = null;
    void tab.controller.targetId().then((targetId) => {
      tab.targetId = targetId;
      this.host.onTabsChanged();
    });
  }

  activate(id: number): boolean {
    const root = this.tabs.find((t) => t.id === id);
    if (!root || this.pendingDialog || (id !== this.activeId && !this.host.tabSwitchAllowed())) return false;
    const changed = this.activeId !== id;
    const tab = this.materialize(root);
    if (changed) {
      const previous = this.active;
      previous?.controller.setVisible(false);
    }
    if (this.activeContextId !== id) {
      this.context(this.activeContextId)?.agentRuntime.invalidateControl();
      tab.agentRuntime.invalidateControl();
    }
    this.activeId = id;
    this.activeContextId = id;
    tab.controller.selectPopup(null);
    tab.controller.setVisible(true);
    tab.controller.focusContent();
    this.contextChanged();
    this.host.onActivated();
    this.host.requestRender();
    if (changed) this.emitRecoveryChange("activated");
    return true;
  }

  async agentObserve(id: number, request: AgentObserveRequest): Promise<AgentActionOutcome<AgentObservation>> {
    request.signal?.throwIfAborted();
    if (!this.has(id)) throw new Error(`no context ${id}`);
    this.control.assertAgent();
    const dialog = this.pendingDialog;
    if (dialog) return { contextId: dialog.contextId, dialog, completed: false };
    if (!await this.prepareAgentContext(id, request.signal)) throw new Error("cannot activate context");
    const tab = this.context(id);
    if (!tab) throw new Error("selected context is unavailable");
    return { ...await tab.agentRuntime.observe(request), contextId: id };
  }

  private async prepareAgentContext(id: number, signal?: AbortSignal): Promise<boolean> {
    const epoch = this.control.assertAgent().controlEpoch;
    if (this.activeContextId !== id) {
      await this.control.input.permit(ALL_INPUT, () => this.control.assertAgent(epoch), signal);
      signal?.throwIfAborted();
      this.control.assertAgent(epoch);
    }
    return this.agentActivate(id);
  }

  agentActivate(id: number): boolean {
    if (!this.has(id) || !this.control.agentEligible || this.pendingDialog) return false;
    // Same-context reads must not steal focus from a human editor or menu.
    if (this.activeContextId === id) return true;
    if (!this.host.agentTabSwitchAllowed() || this.control.input.conflicts(ALL_INPUT)) return false;
    const popup = this.popups.get(id);
    if (!popup) return this.activate(id);
    if (this.activeContextId === id) return true;
    this.context(this.activeContextId)?.agentRuntime.invalidateControl();
    popup.agentRuntime.invalidateControl();
    if (this.activeId !== popup.rootId && !this.activate(popup.rootId)) return false;
    this.activeContextId = id;
    this.activeController?.selectPopup(popup.controller);
    popup.controller.focus();
    this.contextChanged();
    return true;
  }

  async agentClick(id: number, request: AgentClickRequest): Promise<AgentActionOutcome<AgentClickResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    request.signal?.throwIfAborted();
    return this.mutate(id, request.expectedControlEpoch, async () => {
      request.signal?.throwIfAborted();
      if (!await this.prepareAgentContext(id, request.signal)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.click(request);
      } finally {
        await tab.controller.releaseAgentInput();
      }
    });
  }

  async agentUpload(id: number, request: AgentUploadRequest): Promise<AgentActionOutcome<AgentClickResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    request.signal?.throwIfAborted();
    return this.mutate(id, request.expectedControlEpoch, async () => {
      request.signal?.throwIfAborted();
      if (!await this.prepareAgentContext(id, request.signal)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.upload(request, this.host.projectRoot ?? null);
      } finally {
        await tab.controller.releaseAgentInput();
      }
    });
  }

  async agentHover(id: number, request: AgentHoverRequest): Promise<AgentActionOutcome<AgentHoverResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    request.signal?.throwIfAborted();
    return this.mutate(id, request.expectedControlEpoch, async () => {
      request.signal?.throwIfAborted();
      if (!await this.prepareAgentContext(id, request.signal)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.hover(request);
      } finally {
        await tab.controller.releaseAgentInput();
      }
    });
  }

  async agentDrag(id: number, request: AgentDragRequest): Promise<AgentActionOutcome<AgentDragResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    request.signal?.throwIfAborted();
    return this.mutate(id, request.expectedControlEpoch, async () => {
      request.signal?.throwIfAborted();
      if (!await this.prepareAgentContext(id, request.signal)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.drag(request);
      } finally {
        await tab.controller.releaseAgentInput();
      }
    });
  }

  async agentType(id: number, request: AgentTypeRequest): Promise<AgentActionOutcome<AgentTypeResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    request.signal?.throwIfAborted();
    return this.mutate(id, request.expectedControlEpoch, async () => {
      request.signal?.throwIfAborted();
      if (!await this.prepareAgentContext(id, request.signal)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.type(request);
      } finally {
        await tab.controller.releaseAgentInput();
      }
    });
  }

  async agentPressKey(id: number, request: AgentPressKeyRequest): Promise<AgentActionOutcome<AgentPressKeyResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    request.signal?.throwIfAborted();
    return this.mutate(id, request.expectedControlEpoch, async () => {
      request.signal?.throwIfAborted();
      if (!await this.prepareAgentContext(id, request.signal)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.pressKey(request);
      } finally {
        await tab.controller.releaseAgentInput();
      }
    });
  }

  async agentScroll(id: number, request: AgentScrollRequest): Promise<AgentActionOutcome<AgentScrollResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    request.signal?.throwIfAborted();
    return this.mutate(id, request.expectedControlEpoch, async () => {
      request.signal?.throwIfAborted();
      if (!await this.prepareAgentContext(id, request.signal)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.scroll(request);
      } finally {
        await tab.controller.releaseAgentInput();
      }
    });
  }

  async agentNavigate(id: number, request: AgentNavigateRequest): Promise<AgentActionOutcome<AgentNavigateResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    request.signal?.throwIfAborted();
    return this.mutate(id, request.expectedControlEpoch, async () => {
      request.signal?.throwIfAborted();
      if (!await this.prepareAgentContext(id, request.signal)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.navigate(request);
      } finally {
        await tab.controller.releaseAgentInput();
      }
    });
  }

  async agentGetUrl(id: number, request: AgentGetUrlRequest): Promise<AgentActionOutcome<AgentGetUrlResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    request.signal?.throwIfAborted();
    return this.mutate(id, request.expectedControlEpoch, async () => {
      request.signal?.throwIfAborted();
      if (!await this.prepareAgentContext(id, request.signal)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.getUrl(request);
      } finally {
        await tab.controller.releaseAgentInput();
      }
    });
  }

  async agentWaitFor(id: number, request: AgentWaitForRequest): Promise<AgentActionOutcome<AgentWaitForResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no context ${id}`);
    this.control.assertAgent(request.expectedControlEpoch);
    if (this.pendingDialog) throw new Error("a browser dialog is pending");
    return this.interruptible(id, () => tab.agentRuntime.waitFor(request));
  }

  get pendingDialog(): BrowserDialog | null {
    for (const tab of this.tabs.filter(liveTab)) if (tab.controller.dialogs.pending) return tab.controller.dialogs.pending;
    for (const popup of this.popups.values()) if (popup.controller.dialogs.pending) return popup.controller.dialogs.pending;
    return null;
  }

  async certificate(id: number, request: CertificateRequest, epoch?: number, signal?: AbortSignal) {
    const context = this.context(id);
    if (!context) throw new Error(`no context ${id}`);
    if (request.action === "status") return { contextId: id, ...context.controller.certificates.status() };
    if (epoch === undefined) throw new Error("certificate mutation requires a control epoch");
    signal?.throwIfAborted();
    this.control.assertAgent(epoch);
    if (request.action === "revoke") {
      if (this.control.busy || this.pendingDialog) throw new Error("browser input or dialog is busy");
      await this.control.input.permit(ALL_INPUT, () => this.control.assertAgent(epoch), signal);
      signal?.throwIfAborted();
      this.control.assertAgent(epoch);
      if (this.control.busy || this.pendingDialog) throw new Error("browser input or dialog is busy");
      context.controller.certificates.revoke(request);
    } else {
      if (this.pendingDialog?.contextId !== id || this.pendingDialog.id !== request.dialogId) throw new Error("another decision is pending");
      await context.controller.certificates.decide(request, epoch, signal);
    }
    this.host.requestRender();
    return { contextId: id, ...context.controller.certificates.status() };
  }

  revokeHumanCertificates(id: number) {
    if (this.currentVisiblePage()?.contextId !== id) throw new Error("certificate settings require the current visible context");
    if (this.pendingDialog) throw new Error("a browser dialog is pending");
    const context = this.context(id);
    if (!context) throw new Error("visible context is no longer available");
    context.controller.certificates.revokeAll();
    this.host.requestRender();
  }

  blocking(id: number, request: BlockingRequest, epoch?: number): BlockingStatus & { contextId: number } {
    const context = this.context(id);
    if (!context) throw new Error(`no context ${id}`);
    if (request.action !== "status") {
      if (epoch === undefined) throw new Error("blocking mutation requires a control epoch");
      this.control.assertAgent(epoch);
      if (this.control.snapshot.busy || this.pendingDialog) throw new Error("browser input or dialog is busy");
    }
    const result = context.controller.blocking(request);
    if (request.action !== "status") this.host.requestRender();
    return { ...result, contextId: id };
  }

  humanBlocking(contextId: number, request: BlockingRequest): BlockingStatus {
    if (this.currentVisiblePage()?.contextId !== contextId) throw new Error("human settings require the current visible context");
    const context = this.context(contextId);
    if (!context) throw new Error("visible context is no longer available");
    const result = context.controller.blocking(request);
    if (request.action !== "status") this.host.requestRender();
    return result;
  }

  async agentContext(action: "open" | "activate" | "close", id: number | undefined, url: string | undefined, epoch: number) {
    return this.mutate(id ?? this.activeContextId, epoch, async () => {
      await this.control.input.permit(ALL_INPUT, () => this.control.assertAgent(epoch));
      if (action === "open") this.create(url ?? this.fallbackUrl);
      else {
        if (!id || !this.has(id)) throw new Error(`no context ${id}`);
        if (action === "activate" && !this.agentActivate(id)) throw new Error("cannot activate context");
        if (action === "close") this.close(id);
      }
      return { tabs: this.registryView() };
    });
  }

  async respondDialog(id: number, request: DialogResponse) {
    const context = this.context(id);
    if (!context) throw new Error(`no context ${id}`);
    await context.controller.dialogs.respond(request);
    return { contextId: id, completed: true };
  }

  async answerHumanDialog(id: string, accept: boolean, text?: string) {
    const dialog = this.pendingDialog;
    if (!dialog || dialog.id !== id) throw new Error("stale or unknown dialog");
    const certificate = dialog.certificate?.origin && dialog.certificate.fingerprint
      ? { origin: dialog.certificate.origin, fingerprint: dialog.certificate.fingerprint } : undefined;
    await this.context(dialog.contextId)!.controller.dialogs.answer(id, accept, text, undefined, certificate);
  }

  async waitContexts(afterId: number, timeoutMs: number, expectedEpoch: number) {
    this.control.assertAgent(expectedEpoch);
    return new Promise<{ tabs: TabTarget[]; matched: boolean }>((resolve, reject) => {
      const finish = (matched: boolean, error?: unknown) => {
        clearTimeout(timer);
        this.contextListeners.delete(check);
        unsubscribe();
        if (error) reject(error);
        else resolve({ tabs: this.registryView(), matched });
      };
      const check = () => {
        try {
          this.control.assertAgent(expectedEpoch);
          if (this.registryView().some(tab => tab.id > afterId)) finish(true);
        } catch (error) { finish(false, error); }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const unsubscribe = this.control.subscribe(check);
      this.contextListeners.add(check);
      check();
    });
  }

  private context(id: number): { id: number; controller: BrowserController | PopupWindow; agentRuntime: BrowserAgentRuntime } | undefined {
    return this.tabs.filter(liveTab).find(tab => tab.id === id) ?? this.popups.get(id);
  }

  private bindDialogs(id: number, dialogs: BrowserDialogs, runtime: BrowserAgentRuntime) {
    dialogs.configure(id, this.control);
    dialogs.subscribe(() => {
      if (dialogs.pending) runtime.invalidateControl();
      this.contextChanged();
      this.host.requestRender();
    });
  }

  private adoptPopup(root: Tab, controller: PopupWindow, openerContentsId: number) {
    const id = this.seq++;
    const openerId = [...this.popups.values()].find(popup => popup.controller.contentsId === openerContentsId)?.id ?? root.id;
    const agentRuntime = new BrowserAgentRuntime(controller, {
      control: this.control, personaProvider: this.personaProvider,
      onActivityChange: () => this.host.requestAgentRender(),
    });
    this.popups.set(id, { id, openerId, rootId: root.id, controller, agentRuntime });
    controller.onMainFrameNavigationStart = () => agentRuntime.invalidateDocument();
    controller.onNativePageChange = change => this.emitPageChange({ contextId: id, ...change });
    this.attachPageObserver(id, controller);
    controller.trackDownloads(this.downloads, id);
    this.bindDialogs(id, controller.dialogs, agentRuntime);
    this.context(this.activeContextId)?.agentRuntime.invalidateControl();
    const rootChanged = this.activeId !== root.id;
    if (rootChanged) this.activeController?.setVisible(false);
    this.activeContextId = id;
    this.activeId = root.id;
    root.controller.setVisible(true);
    root.controller.selectPopup(controller);
    this.contextChanged();
    this.host.onTabsChanged();
    if (rootChanged) this.emitRecoveryChange("activated");
  }

  private removePopup(controller: PopupWindow) {
    const popup = [...this.popups.values()].find(item => item.controller === controller);
    if (!popup) return;
    popup.agentRuntime.invalidateControl();
    this.downloads.interruptContext(popup.id);
    this.popups.delete(popup.id);
    if (this.activeContextId === popup.id) {
      this.activeContextId = popup.rootId;
      this.context(popup.rootId)?.agentRuntime.invalidateControl();
    }
    this.contextChanged();
    this.host.onTabsChanged();
  }

  private contextChanged() {
    for (const listener of this.contextListeners) listener();
    this.emitPageChange({ contextId: this.activeContextId, reason: "context" });
  }

  subscribePageChanges(listener: (change: VisiblePageChange) => void): () => void {
    this.pageListeners.add(listener);
    return () => this.pageListeners.delete(listener);
  }
  private emitPageChange(change: VisiblePageChange): void {
    for (const listener of this.pageListeners) listener(change);
  }
  currentVisiblePage(): VisiblePage | null {
    const context = this.context(this.activeContextId);
    if (!context || !context.controller.pageVisible) return null;
    const controller = context.controller;
    const popup = this.popups.get(context.id);
    return { contextId: context.id, contextKind: popup ? "popup" : "tab",
      documentGeneration: controller.pageDocumentGeneration, viewRevision: controller.pageViewRevision,
      url: controller.currentUrl().slice(0, 8192),
      title: (popup?.controller.state.title ?? this.active?.state.title ?? "").slice(0, 512),
      viewport: controller.viewportSize(), contents: controller.pageContents };
  }
  noteVisibleGeometryChange(contextId: number): void {
    if (contextId === this.activeContextId) this.context(contextId)?.controller.noteGeometryChange();
  }
  async captureVisiblePage(expected: Pick<VisiblePage, "contextId" | "documentGeneration" | "viewRevision">, visual: boolean) {
    const check = () => {
      const page = this.currentVisiblePage();
      if (!page || page.contextId !== expected.contextId || page.documentGeneration !== expected.documentGeneration ||
        page.viewRevision !== expected.viewRevision) throw new Error("visible page changed during capture");
      return page;
    };
    const page = check();
    let image: AgentVisualObservation | undefined;
    if (visual) {
      const data = await this.context(page.contextId)!.controller.capturePage();
      check();
      if (data.byteLength < 24 || data.toString("ascii", 1, 4) !== "PNG" || data.byteLength > 2 * 1024 * 1024) throw new Error("invalid bounded page capture");
      image = { mimeType: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20),
        bytes: data.byteLength, scope: "viewport", rect: { x: 0, y: 0, ...page.viewport }, data };
    }
    check();
    const { contents: _contents, viewport: _viewport, ...metadata } = page;
    return { ...metadata, ...(image ? { visual: image } : {}) };
  }

  closeInventory() {
    return { contexts: this.registryView().map(context => ({ contextId: context.id, contextKind: context.kind,
      openerId: context.openerId, title: context.title,
      documentGeneration: this.context(context.id)?.controller.pageDocumentGeneration ?? 0 })),
      transfers: this.downloads.list().map(({ id, contextId, state }) => ({ id, contextId, state })) };
  }
  async releaseAgentInput(): Promise<void> {
    await Promise.all([...this.tabs.filter(liveTab), ...this.popups.values()].map(context => context.controller.releaseAgentInput()));
  }
  /** The whole-session coordinator must verify an empty inventory before teardown. */
  async closeContext(expected: { contextId: number; documentGeneration: number }, signal?: AbortSignal): Promise<"closed" | "decision-required" | "refused" | "unknown"> {
    signal?.throwIfAborted();
    const root = this.tabs.find(tab => tab.id === expected.contextId);
    if (root && !liveTab(root)) {
      if (expected.documentGeneration !== 0) return "refused";
      if (this.pendingDialog) return "decision-required";
      this.sessionClosePending = true;
      this.close(root.id);
      return this.has(root.id) ? "unknown" : "closed";
    }
    const context = this.context(expected.contextId);
    if (!context || context.controller.pageDocumentGeneration !== expected.documentGeneration) return "refused";
    if (this.pendingDialog) return "decision-required";
    this.sessionClosePending = true;
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (result: "closed" | "decision-required" | "refused" | "unknown") => {
        clearTimeout(timer); this.contextListeners.delete(check); signal?.removeEventListener("abort", abort); resolve(result);
      };
      const check = () => {
        if (!this.has(expected.contextId)) finish("closed");
        else if (this.pendingDialog) finish("decision-required");
      };
      const abort = () => finish("unknown");
      this.contextListeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish("unknown"), 2_000);
      try { this.close(expected.contextId); check(); } catch { finish("refused"); }
    });
  }

  private mutate<T>(id: number, epoch: number, operation: () => Promise<T>): Promise<AgentActionOutcome<T>> {
    if (this.pendingDialog) return Promise.reject(new Error("a browser dialog is pending"));
    return this.interruptible(id, () => this.control.runMutation(epoch, () => {
      if (this.pendingDialog) throw new Error("a browser dialog is pending");
      return operation();
    }));
  }

  private async interruptible<T>(id: number, operation: () => Promise<T>): Promise<AgentActionOutcome<T>> {
    let listener: () => void = () => {};
    const dialog = new Promise<AgentActionOutcome<T>>(resolve => {
      listener = () => {
        const pending = this.pendingDialog;
        if (pending) resolve({ contextId: id, dialog: pending, completed: false });
        else if (this.activeContextId !== id && this.popups.has(this.activeContextId)) resolve({ contextId: id, openedContextId: this.activeContextId, completed: false });
      };
      this.contextListeners.add(listener);
    });
    try { return await Promise.race([operation(), dialog]); }
    finally { this.contextListeners.delete(listener); }
  }

  close(id: number) {
    if (this.pendingDialog) throw new Error("a browser dialog is pending");
    const popup = this.popups.get(id);
    if (popup) { popup.controller.close(); return; }
    const tab = this.tabs.find(item => item.id === id);
    if (tab && !liveTab(tab)) this.host.onTabClosed(id);
    else if (tab) tab.controller.requestClose();
  }

  removeClosed(id: number, createFallback = true) {
    const at = this.tabs.findIndex((t) => t.id === id);
    if (at < 0) return;
    const [closed] = this.tabs.splice(at, 1);
    this.downloads.interruptContext(id);
    this.recoveryEntries.delete(id);
    this.initialRecoveryLoads.delete(id);
    if (liveTab(closed)) {
      closed.agentRuntime.invalidateControl();
      closed.controller.stop();
    }
    if (this.activeId === id) {
      const fallback = this.tabs[Math.min(at, this.tabs.length - 1)];
      if (fallback) {
        if (!this.sessionClosePending || liveTab(fallback)) this.activate(fallback.id);
        else { this.activeId = 0; this.activeContextId = 0; }
      } else if (createFallback && !this.sessionClosePending) this.create(this.fallbackUrl);
      else { this.activeId = 0; this.activeContextId = 0; }
    }
    this.contextChanged();
    this.host.onTabsChanged();
    this.host.requestRender();
    this.emitRecoveryChange("closed");
  }

  has(id: number): boolean {
    return this.tabs.some(tab => tab.id === id) || this.popups.has(id);
  }

  touchAgentControl(id: number): boolean {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || !liveTab(tab)) return false;
    const fresh = tab.agentControlAt == null;
    tab.agentControlAt = Date.now();
    this.startAgentSweep();
    if (fresh) {
      this.host.onTabsChanged();
      this.host.requestRender();
    }
    return true;
  }

  releaseAgentControl() {
    this.invalidateAgentControl();
    this.stopAgentSweep();
    let changed = false;
    for (const tab of this.tabs) {
      if (tab.agentControlAt == null) continue;
      tab.agentControlAt = null;
      changed = true;
    }
    if (!changed) return;
    this.host.onTabsChanged();
    this.host.requestRender();
  }

  private startAgentSweep() {
    if (this.agentSweep) return;
    this.agentSweep = setInterval(() => {
      const cutoff = Date.now() - AGENT_CONTROL_TTL_MS;
      let changed = false;
      let remaining = false;
      for (const tab of this.tabs) {
        if (tab.agentControlAt == null) continue;
        if (tab.agentControlAt < cutoff) {
          tab.agentControlAt = null;
          changed = true;
        } else {
          remaining = true;
        }
      }
      if (!remaining) this.stopAgentSweep();
      if (changed) {
        this.host.onTabsChanged();
        this.host.requestRender();
      }
    }, AGENT_CONTROL_SWEEP_MS);
  }

  private stopAgentSweep() {
    if (!this.agentSweep) return;
    clearInterval(this.agentSweep);
    this.agentSweep = null;
  }

  soleAppTab(): boolean {
    return this.tabs.length === 1 && this.tabs[0].app != null;
  }

  findByContents(contentsId: number): Tab | null {
    return this.tabs.filter(liveTab).find((tab) => tab.controller.hasContents(contentsId)) ?? null;
  }

  stateFor(controller: BrowserController): BrowserState | null {
    return this.tabs.filter(liveTab).find((tab) => tab.controller === controller)?.state ?? null;
  }

  private label(tab: RootTab): string {
    if (tab.app?.name) return tab.app.name;
    return tab.state.title || displayUrl(tab.state.url);
  }

  view(): TabRow[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      title: this.label(tab),
      favicon: tab.app ? null : tab.state.favicon,
      active: tab.id === this.activeId,
      app: tab.app != null,
      agentControlled: tab.agentControlAt != null,
    }));
  }

  registryView(): TabTarget[] {
    return [
      ...this.tabs.map(tab => ({
        id: tab.id, contextId: tab.id, openerId: null, kind: "tab" as const,
        url: tab.state.url.slice(0, 8192), title: tab.state.title.slice(0, 512),
        active: tab.id === this.activeContextId, targetId: tab.targetId,
        app: tab.app, agentControlled: tab.agentControlAt != null, dormant: !liveTab(tab),
      })),
      ...[...this.popups.values()].map(popup => ({
        id: popup.id, contextId: popup.id, openerId: popup.openerId, kind: "popup" as const,
        url: popup.controller.state.url.slice(0, 8192), title: popup.controller.state.title.slice(0, 512),
        active: popup.id === this.activeContextId, targetId: null,
        agentControlled: this.control.agentEligible,
      })),
    ];
  }

  async targets(): Promise<TabTarget[]> { return this.registryView(); }

  eachController(fn: (controller: BrowserController) => void) {
    for (const tab of this.tabs.filter(liveTab)) fn(tab.controller);
  }

  invalidateAgentControl() {
    for (const popup of this.popups.values()) {
      void Promise.resolve(popup.controller.releaseAgentInput()).catch(() => {});
      popup.agentRuntime.invalidateControl();
    }
    for (const tab of this.tabs.filter(liveTab)) {
      void Promise.resolve(tab.controller.releaseAgentInput()).catch(() => {});
      tab.agentRuntime.invalidateControl();
    }
  }

  stopAll() {
    this.recoveryStopped = true;
    this.downloads.stop();
    this.stopAgentSweep();
    for (const tab of this.tabs.filter(liveTab)) {
      tab.agentRuntime.invalidateControl();
      tab.controller.stop();
    }
    this.popups.clear();
    this.contextChanged();
    this.tabs = [];
    this.recoveryEntries.clear();
    this.initialRecoveryLoads.clear();
    this.activeId = 0;
    this.activeContextId = 0;
  }
}
