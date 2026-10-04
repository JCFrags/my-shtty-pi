import { createHash, randomUUID } from "node:crypto";
import { isNativeBrowserOwner, sameBrowserOwner, type BrowserOwner } from "pixel-store";
import { parseBlockingRequest, type BlockingRequest, type BlockingStatus } from "../blocking/types";
import type { AgentVisualObservation } from "../agent/types";
import { ChangeFeed, sameVisibleContext, visualFromPng, type ChangeCapture, type CompanionMode, type VisibleContext } from "../agent/change-feed";
import type { ChangeReason, PageChangeHint } from "../agent/page-changes";
export type { CompanionMode, VisibleContext } from "../agent/change-feed";

export interface CompanionIdentity { owner: BrowserOwner | null; browserSessionKey: string; runtimeInstanceId: string }
export interface CompanionAddress { schemaVersion: 1; ownerKey: string; browserSessionKey: string; runtimeInstanceId: string }
export interface RecoveryStatus {
  state: "unavailable" | "pending" | "restored" | "fresh" | "none";
  revision: string | null;
  entries: { kind: "url" | "excluded"; url: string; reason?: string }[];
  activeIndex: number | null;
  warning: string;
}
export type RecoveryResponse = CompanionAddress & RecoveryStatus;
export const RECOVERY_WARNING = "Owner-private tab URLs are retained for up to 30 days. Private paths can identify page content. URL filtering is heuristic, not a complete secret detector or a guarantee of read-only navigation.";
export interface ReceiverBinding { bindingId: string; receiverKind: "pi" | "cli"; receiverSessionId: string; receiverGeneration: string }
export interface ReceiverTuple { bindingId: string; receiverGeneration: string }
export interface CloseContext { contextId: number; contextKind: "tab" | "popup"; openerId: number | null; documentGeneration: number; title: string }
export interface CloseInventory { contexts: CloseContext[]; transfers: { id: string; contextId: number; state: string }[] }
export type CloseOutcome = "closed" | "decision-required" | "refused" | "unknown";
export interface CompanionHost {
  identity(): CompanionIdentity;
  control(): { state: CompanionMode; controlEpoch: number };
  visibleContext(): VisibleContext | null;
  captureVisible(context: VisibleContext): Promise<Buffer>;
  stopForHuman(): Promise<void>;
  closeInventory(): CloseInventory;
  closeContext(context: CloseContext, signal?: AbortSignal): Promise<CloseOutcome>;
  finishClose(): Promise<void>;
  endCloseAttempt(): void;
  blocking(contextId: number, request: BlockingRequest): BlockingStatus;
  recoveryStatus?(): RecoveryStatus;
  chooseRecovery?(choice: "restore" | "fresh", revision: string): RecoveryStatus;
  onChange?(): void;
}
export interface CompanionStatus extends CompanionAddress {
  sequence: number;
  binding: ReceiverBinding | null;
  receiverOnline: boolean;
  pendingShareId: string | null;
  updates: { enabled: boolean; suspended: boolean; active: boolean; description: string };
  mode: CompanionMode;
  controlEpoch: number;
  limits: string[];
}
export interface CompanionEvent extends CompanionAddress, ReceiverTuple {
  changed: true;
  sequence: number;
  replacedCount: number;
  kind: "auto-visual" | "control" | "human-share";
  contextId: number;
  contextKind: "tab" | "popup";
  documentGeneration: number;
  viewRevision: number;
  reasons: ChangeReason[];
  mode: CompanionMode;
  controlEpoch: number;
  capturedAt: number;
  settled: boolean;
  visual?: AgentVisualObservation;
  shareId?: string;
  url?: string;
  title?: string;
}
export interface UnchangedEvent extends CompanionAddress, ReceiverTuple { changed: false; sequence: number }
export interface HumanCapture extends CompanionAddress {
  contextId: number;
  contextKind: "tab" | "popup";
  documentGeneration: number;
  viewRevision: number;
  url: string;
  title: string;
  capturedAt: number;
  visual?: AgentVisualObservation;
}
export interface ClosePreview extends CompanionAddress, CloseInventory { revision: string }
export interface CloseResult extends CompanionAddress { status: CloseOutcome | "partial"; closedContextIds: number[]; remainingContextIds: number[] }
export interface CompanionRequest {
  cmd: string;
  owner?: unknown;
  expectedBrowserSessionKey?: unknown;
  expectedRuntimeInstanceId?: unknown;
  receiverKind?: unknown;
  receiverSessionId?: unknown;
  receiverGeneration?: unknown;
  bindingId?: unknown;
  replaceBindingId?: unknown;
  suspendAutomatic?: unknown;
  enabled?: unknown;
  after?: unknown;
  timeoutMs?: unknown;
  format?: unknown;
  expectedContextId?: unknown;
  expectedDocumentGeneration?: unknown;
  preview?: unknown;
  revision?: unknown;
  choice?: unknown;
  action?: unknown;
  site?: unknown;
}
interface Waiter { after: number; finish: (value?: CompanionEvent | UnchangedEvent, error?: unknown) => void }

/** One receiver and bounded pending data per BrowserSession. Owner IDs route, not authenticate. */
export class CompanionService {
  private readonly initial: CompanionIdentity;
  private readonly feed: ChangeFeed;
  private binding: ReceiverBinding | null = null;
  private former: ReceiverTuple | null = null;
  private updatesEnabled = true;
  private automaticSuspended = false;
  private sequence = 0;
  private automatic: CompanionEvent | null = null;
  private shareEvent: CompanionEvent | null = null;
  private waiter: Waiter | null = null;
  private captureBusy = false;
  private shareBusy = false;
  private closing = false;
  private disposed = false;
  private captureGeneration = 0;
  private lastMode: CompanionMode;
  private lastEpoch: number;

  constructor(private readonly host: CompanionHost) {
    const identity = host.identity();
    this.initial = { ...identity, owner: identity.owner ? { ...identity.owner } : null };
    const control = host.control();
    this.lastMode = control.state;
    this.lastEpoch = control.controlEpoch;
    this.feed = new ChangeFeed({
      visibleContext: () => host.visibleContext(),
      canCapture: () => this.autoEligible() && !!this.waiter && !this.captureBusy && !this.shareBusy,
      demandToken: () => this.waiter,
      capture: context => this.captureVisual(context),
      publish: capture => this.publishCapture(capture),
    });
  }

  status(): CompanionStatus {
    this.assertLive();
    const control = this.host.control();
    return {
      ...this.address(), sequence: this.sequence, binding: this.binding ? { ...this.binding } : null,
      receiverOnline: !!this.waiter, pendingShareId: this.shareEvent?.shareId ?? null,
      updates: { enabled: this.updatesEnabled, suspended: this.automaticSuspended, active: this.autoEligible(), description: this.automaticSuspended ? "Automatic screenshots are suspended for this connection. Select Shared or set the updates preference explicitly to clear suspension." : "Shared page screenshots go to the associated receiver. They do not request an automatic reply." },
      mode: control.state, controlEpoch: control.controlEpoch,
      limits: ["Visual changes are heuristic, not complete page observation.", "Host occlusion and terminal IME preedit are not reported.", "Delivered pixels cannot be recalled from the receiver."],
    };
  }

  recoveryStatus(): RecoveryResponse {
    this.assertLive();
    const status: RecoveryStatus = typeof this.host.recoveryStatus === "function" ? this.host.recoveryStatus() : {
      state: "unavailable", revision: null, entries: [], activeIndex: null, warning: RECOVERY_WARNING,
    };
    return { ...status, ...this.address() };
  }

  chooseRecovery(choice: "restore" | "fresh", revision: string): RecoveryResponse {
    this.assertLive();
    if (choice !== "restore" && choice !== "fresh") throw new Error("recovery choice must be restore or fresh");
    if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("invalid recovery confirmation revision");
    if (typeof this.host.recoveryStatus !== "function" || typeof this.host.chooseRecovery !== "function") throw new Error("tab recovery is unavailable for this session");
    // The host checks this confirmation against the exact loaded pending snapshot.
    const status = this.host.chooseRecovery(choice, revision);
    return { ...status, ...this.address() };
  }

  bind(options: { receiverKind: "pi" | "cli"; receiverSessionId: string; receiverGeneration: string; replaceBindingId?: string; suspendAutomatic?: boolean }): CompanionStatus {
    this.assertLive();
    receiverKind(options.receiverKind);
    boundedString(options.receiverSessionId, "receiverSessionId", 512);
    uuid(options.receiverGeneration, "receiverGeneration");
    if (options.replaceBindingId !== undefined) uuid(options.replaceBindingId, "replaceBindingId");
    if (options.suspendAutomatic !== undefined && typeof options.suspendAutomatic !== "boolean") throw new Error("suspendAutomatic must be boolean");
    const same = this.binding && this.binding.receiverKind === options.receiverKind && this.binding.receiverSessionId === options.receiverSessionId && this.binding.receiverGeneration === options.receiverGeneration;
    if (same) {
      if (options.replaceBindingId !== undefined && options.replaceBindingId !== this.binding!.bindingId) throw new Error("receiver replacement binding changed");
      if (options.suspendAutomatic === true && !this.automaticSuspended) {
        this.automaticSuspended = true;
        this.refreshAutomatic();
      }
      return this.status();
    }
    if (this.binding) {
      if (options.replaceBindingId !== this.binding.bindingId) throw new Error("another receiver is bound; confirm replacement of its exact binding");
    } else if (options.replaceBindingId !== undefined) throw new Error("receiver replacement binding no longer exists");
    this.clearBindingData("receiver binding changed");
    this.binding = { bindingId: randomUUID(), receiverKind: options.receiverKind, receiverSessionId: options.receiverSessionId, receiverGeneration: options.receiverGeneration };
    this.former = null;
    this.automaticSuspended = options.suspendAutomatic === true;
    if (this.autoEligible()) this.feed.start("follow-start");
    this.notify();
    return this.status();
  }

  unbind(tuple: ReceiverTuple): CompanionAddress & { unbound: true } {
    this.assertLive();
    validateTuple(tuple);
    if (!this.binding && this.former?.bindingId === tuple.bindingId && this.former.receiverGeneration === tuple.receiverGeneration) return { ...this.address(), unbound: true };
    this.requireBinding(tuple);
    this.clearBindingData("receiver was unbound");
    this.binding = null;
    this.automaticSuspended = false;
    this.former = { ...tuple };
    this.notify();
    return { ...this.address(), unbound: true };
  }

  setUpdates(options: ReceiverTuple & { enabled: boolean }): CompanionStatus {
    this.requireBinding(options);
    if (typeof options.enabled !== "boolean") throw new Error("enabled must be boolean");
    if (this.updatesEnabled === options.enabled && !this.automaticSuspended) return this.status();
    this.updatesEnabled = options.enabled;
    this.automaticSuspended = false;
    this.refreshAutomatic();
    return this.status();
  }

  /** Call only after an explicit Shared choice succeeds, including a same-mode choice. */
  explicitSharedChoice() {
    this.assertLive();
    if (this.host.control().state !== "shared" || !this.binding || !this.automaticSuspended) return;
    this.automaticSuspended = false;
    this.refreshAutomatic();
  }

  private refreshAutomatic() {
    this.captureGeneration++;
    this.automatic = null;
    this.feed.clear();
    if (this.autoEligible()) this.feed.start("follow-start");
    else this.publishControl();
    this.notify();
  }

  controlChanged() {
    if (this.disposed) return;
    const control = this.host.control();
    if (control.state === this.lastMode && control.controlEpoch === this.lastEpoch) return;
    this.lastMode = control.state;
    this.lastEpoch = control.controlEpoch;
    this.captureGeneration++;
    this.automatic = null;
    this.feed.clear();
    if (this.autoEligible()) this.feed.start("follow-start");
    else this.publishControl();
    this.notify();
  }

  contextChanged() {
    if (this.disposed) return;
    this.captureGeneration++;
    this.automatic = null;
    this.feed.clear();
    if (this.autoEligible()) this.feed.start("context");
    this.notify();
  }

  changed(hint: PageChangeHint) {
    if (!this.autoEligible()) return;
    this.feed.changed(hint);
  }

  wait(options: ReceiverTuple & { after: number; timeoutMs: number }, signal?: AbortSignal): Promise<CompanionEvent | UnchangedEvent> {
    this.requireBinding(options);
    integer(options.after, "after", 0, this.sequence);
    integer(options.timeoutMs, "timeoutMs", 0, 30_000);
    signal?.throwIfAborted();
    if (this.waiter) throw new Error("receiver already has an event wait online");
    if (this.shareEvent && options.after >= this.shareEvent.sequence) this.shareEvent = null;
    if (this.automatic && options.after >= this.automatic.sequence) this.automatic = null;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish: Waiter["finish"] = (value, error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.waiter === waiter) this.waiter = null;
        this.feed.wake();
        this.notify();
        if (error) reject(error); else resolve(value!);
      };
      const waiter: Waiter = { after: options.after, finish };
      const abort = () => finish(undefined, signal?.reason ?? new Error("event wait canceled"));
      const timer = setTimeout(() => {
        try {
          this.requireBinding(options);
          finish({ ...this.address(), changed: false, sequence: this.sequence, bindingId: options.bindingId, receiverGeneration: options.receiverGeneration });
        } catch (error) { finish(undefined, error); }
      }, options.timeoutMs);
      this.waiter = waiter;
      signal?.addEventListener("abort", abort, { once: true });
      this.notify();
      this.flush();
      this.feed.wake();
    });
  }

  async capture(format: "link" | "visual", signal?: AbortSignal): Promise<HumanCapture> {
    this.assertLive();
    captureFormat(format);
    signal?.throwIfAborted();
    const context = this.host.visibleContext();
    if (!context?.visible) throw new Error("no displayed browser context");
    const address = this.address();
    const visual = format === "visual" ? await this.captureVisual(context) : undefined;
    signal?.throwIfAborted();
    this.assertLive();
    if (!sameVisibleContext(context, this.host.visibleContext())) throw new Error("displayed page changed during capture");
    return {
      ...address, contextId: context.contextId, contextKind: context.contextKind,
      documentGeneration: context.documentGeneration, viewRevision: context.viewRevision,
      url: pageString(context.url, 8192), title: pageString(context.title, 512), capturedAt: Date.now(),
      ...(visual ? { visual } : {}),
    };
  }

  async share(options: ReceiverTuple & { format: "link" | "visual"; expectedContextId: number; expectedDocumentGeneration: number }, signal?: AbortSignal) {
    this.requireBinding(options);
    integer(options.expectedContextId, "expectedContextId", 1, Number.MAX_SAFE_INTEGER);
    integer(options.expectedDocumentGeneration, "expectedDocumentGeneration", 0, Number.MAX_SAFE_INTEGER);
    const preview = this.host.visibleContext();
    if (!preview?.visible || preview.contextId !== options.expectedContextId || preview.documentGeneration !== options.expectedDocumentGeneration) throw new Error("Send preview context changed; preview and confirm the current page");
    if (!this.waiter) throw new Error("the exact receiver is not online; reconnect before Send");
    if (this.shareBusy || this.shareEvent) throw new Error("a human share is already pending");
    this.shareBusy = true;
    const generation = this.captureGeneration;
    try {
      const capture = await this.capture(options.format, signal);
      signal?.throwIfAborted();
      this.requireBinding(options);
      if (!this.waiter || generation !== this.captureGeneration) throw new Error("receiver or displayed context changed during Send");
      const context = this.host.visibleContext();
      if (!context?.visible || context.contextId !== options.expectedContextId || context.documentGeneration !== options.expectedDocumentGeneration) throw new Error("Send preview context changed during capture");
      const event: CompanionEvent = { ...this.envelope("human-share", context, []), ...capture, shareId: randomUUID() };
      this.shareEvent = event;
      this.flush();
      this.notify();
      return { ...this.address(), shareId: event.shareId!, status: "queued" as const, sequence: event.sequence };
    } finally { this.shareBusy = false; this.feed.wake(); }
  }

  previewClose(): ClosePreview {
    this.assertLive();
    const inventory = this.inventory();
    return { ...this.address(), ...inventory, revision: this.closeRevision(inventory) };
  }

  async confirmClose(revision: string, signal?: AbortSignal): Promise<CloseResult> {
    this.assertLive();
    if (this.closing) throw new Error("a confirmed close is already in progress");
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("invalid close revision");
    const inventory = this.inventory();
    if (this.closeRevision(inventory) !== revision) throw new Error("close scope changed; preview and confirm the new scope");
    signal?.throwIfAborted();
    const address = this.address();
    const approved = new Map(inventory.contexts.map(context => [context.contextId, context]));
    const closed = new Set<number>();
    const result = (status: CloseResult["status"]): CloseResult => ({ ...address, status, closedContextIds: [...closed], remainingContextIds: this.inventory().contexts.map(context => context.contextId) });
    this.closing = true;
    this.captureGeneration++;
    this.automatic = null;
    this.feed.clear();
    try {
      await this.host.stopForHuman();
      this.controlChanged();
      if (this.host.control().state !== "human") throw new Error("close requires strict Human control");
      const order = [...inventory.contexts].sort((a, b) => closeDepth(b, approved) - closeDepth(a, approved));
      for (const context of order) {
        signal?.throwIfAborted();
        this.assertLive();
        const current = this.inventory();
        if (!approvedInventory(current, inventory, closed)) return result(closed.size ? "partial" : "refused");
        for (const id of approved.keys()) if (!current.contexts.some(item => item.contextId === id)) closed.add(id);
        if (closed.has(context.contextId)) continue;
        let outcome: CloseOutcome;
        try { outcome = await this.host.closeContext(context, signal); }
        catch { outcome = "unknown"; }
        const after = this.inventory();
        for (const id of approved.keys()) if (!after.contexts.some(item => item.contextId === id)) closed.add(id);
        if (outcome !== "closed") return result(outcome);
        if (!closed.has(context.contextId)) return result("unknown");
        if (!approvedInventory(after, inventory, closed)) return result("partial");
      }
      if (this.inventory().contexts.length) return result("partial");
      await this.host.finishClose();
      return { ...address, status: "closed", closedContextIds: [...closed], remainingContextIds: [] };
    } finally {
      this.closing = false;
      try { this.host.endCloseAttempt(); }
      finally { this.notify(); }
    }
  }

  humanBlocking(request: BlockingRequest) {
    this.assertLive();
    const context = this.host.visibleContext();
    if (!context?.visible) throw new Error("no displayed browser context");
    const parsed = parseBlockingRequest(request.action, request.site);
    return { ...this.address(), ...this.host.blocking(context.contextId, parsed), contextId: context.contextId, settingScope: "profile" as const };
  }

  /** Only the registry uses this parser. Native chrome calls the typed methods. */
  request(request: CompanionRequest, signal?: AbortSignal): unknown | Promise<unknown> {
    this.assertScope(request);
    const tuple = () => ({ bindingId: uuid(request.bindingId, "bindingId"), receiverGeneration: uuid(request.receiverGeneration, "receiverGeneration") });
    switch (request.cmd) {
      case "recovery.status": return this.recoveryStatus();
      case "recovery.choose": {
        if (request.choice !== "restore" && request.choice !== "fresh") throw new Error("recovery choice must be restore or fresh");
        if (typeof request.revision !== "string") throw new Error("recovery confirmation revision required");
        return this.chooseRecovery(request.choice, request.revision);
      }
      case "receiver.status": return this.status();
      case "receiver.bind": {
        if (request.suspendAutomatic !== undefined && typeof request.suspendAutomatic !== "boolean") throw new Error("suspendAutomatic must be boolean");
        return this.bind({ receiverKind: receiverKind(request.receiverKind), receiverSessionId: boundedString(request.receiverSessionId, "receiverSessionId", 512), receiverGeneration: uuid(request.receiverGeneration, "receiverGeneration"), ...(request.replaceBindingId === undefined ? {} : { replaceBindingId: uuid(request.replaceBindingId, "replaceBindingId") }), ...(request.suspendAutomatic === undefined ? {} : { suspendAutomatic: request.suspendAutomatic }) });
      }
      case "receiver.unbind": return this.unbind(tuple());
      case "updates.set": {
        if (typeof request.enabled !== "boolean") throw new Error("enabled must be boolean");
        return this.setUpdates({ ...tuple(), enabled: request.enabled });
      }
      case "events.wait": return this.wait({ ...tuple(), after: integer(request.after, "after", 0, this.sequence), timeoutMs: integer(request.timeoutMs ?? 25000, "timeoutMs", 0, 30000) }, signal);
      case "human.capture": return this.capture(captureFormat(request.format), signal);
      case "human.share": return this.share({ ...tuple(), format: captureFormat(request.format), expectedContextId: integer(request.expectedContextId, "expectedContextId", 1, Number.MAX_SAFE_INTEGER), expectedDocumentGeneration: integer(request.expectedDocumentGeneration, "expectedDocumentGeneration", 0, Number.MAX_SAFE_INTEGER) }, signal);
      case "human.close": {
        if (request.preview === true && request.revision === undefined) return this.previewClose();
        if (request.preview === undefined && typeof request.revision === "string") return this.confirmClose(request.revision, signal);
        throw new Error("close needs preview or an exact confirmed revision");
      }
      case "human.blocking": return this.humanBlocking(parseBlockingRequest(request.action, request.site));
      default: throw new Error("unknown companion service command");
    }
  }

  dispose() { if (!this.disposed) { this.disposed = true; this.clearBindingData("browser session closed"); this.binding = null; this.feed.dispose(); } }

  private assertLive() {
    if (this.disposed) throw new Error("browser companion service is closed");
    const current = this.host.identity();
    if (!sameIdentity(current, this.initial)) { this.dispose(); throw new Error("browser companion identity changed"); }
    if (!current.owner) throw new Error("companion service requires an explicit browser owner");
  }

  private assertScope(request: CompanionRequest) {
    this.assertLive();
    if (!matchesOwner(request.owner, this.initial.owner)) throw new Error("browser owner mismatch");
    if (request.expectedBrowserSessionKey !== undefined && request.expectedBrowserSessionKey !== this.initial.browserSessionKey) throw new Error("browser session key mismatch");
    if (request.expectedRuntimeInstanceId !== undefined && request.expectedRuntimeInstanceId !== this.initial.runtimeInstanceId) throw new Error("browser runtime instance mismatch");
  }

  private address(): CompanionAddress {
    return { schemaVersion: 1, ownerKey: ownerKey(this.initial.owner), browserSessionKey: this.initial.browserSessionKey, runtimeInstanceId: this.initial.runtimeInstanceId };
  }

  private requireBinding(tuple: ReceiverTuple) {
    this.assertLive();
    validateTuple(tuple);
    if (!this.binding || this.binding.bindingId !== tuple.bindingId || this.binding.receiverGeneration !== tuple.receiverGeneration) throw new Error("stale or mismatched receiver binding");
    return this.binding;
  }

  private autoEligible() {
    return !this.disposed && !this.closing && !!this.binding && this.updatesEnabled && !this.automaticSuspended && this.host.control().state === "shared";
  }

  private clearBindingData(reason: string) {
    this.captureGeneration++;
    this.automatic = this.shareEvent = null;
    this.feed.clear();
    this.waiter?.finish(undefined, new Error(reason));
  }

  private async captureVisual(context: VisibleContext) {
    this.assertLive();
    if (this.captureBusy) throw new Error("a page capture is already in progress");
    if (!sameVisibleContext(context, this.host.visibleContext())) throw new Error("displayed page changed before capture");
    this.captureBusy = true;
    try {
      const png = await this.host.captureVisible(context);
      this.assertLive();
      if (!sameVisibleContext(context, this.host.visibleContext())) throw new Error("displayed page changed during capture");
      return visualFromPng(png, context.viewport);
    } finally { this.captureBusy = false; this.feed.wake(); }
  }

  private envelope(kind: CompanionEvent["kind"], context: VisibleContext | null, reasons: ChangeReason[]): CompanionEvent {
    const binding = this.binding!;
    const control = this.host.control();
    return {
      ...this.address(), changed: true, bindingId: binding.bindingId, receiverGeneration: binding.receiverGeneration,
      sequence: ++this.sequence, replacedCount: 0, kind,
      contextId: context?.contextId ?? 0, contextKind: context?.contextKind ?? "tab",
      documentGeneration: context?.documentGeneration ?? 0, viewRevision: context?.viewRevision ?? 0,
      reasons: [...new Set(reasons)].slice(0, 6), mode: control.state, controlEpoch: control.controlEpoch, capturedAt: Date.now(), settled: true,
    };
  }

  private publishCapture(capture: ChangeCapture) {
    if (!this.autoEligible() || !this.waiter || !sameVisibleContext(capture.context, this.host.visibleContext())) return;
    this.assertLive();
    const event = { ...this.envelope("auto-visual", capture.context, capture.reasons), visual: capture.visual, capturedAt: capture.capturedAt, settled: capture.settled };
    event.replacedCount = this.automatic ? this.automatic.replacedCount + 1 : 0;
    this.automatic = event;
    this.flush();
  }

  private publishControl() {
    if (!this.binding) return;
    this.automatic = this.envelope("control", this.host.visibleContext(), ["updates-stopped"]);
    this.flush();
  }

  private flush() {
    const waiter = this.waiter;
    if (!waiter) return;
    try { this.assertLive(); } catch (error) { waiter.finish(undefined, error); return; }
    if (this.automatic?.kind === "auto-visual") {
      const current = this.host.visibleContext();
      const control = this.host.control();
      if (!this.autoEligible() || !current?.visible || current.contextId !== this.automatic.contextId ||
          current.documentGeneration !== this.automatic.documentGeneration || current.viewRevision !== this.automatic.viewRevision ||
          control.controlEpoch !== this.automatic.controlEpoch) this.automatic = null;
    }
    // An older explicit share must not be skipped by a newer automatic cursor.
    const candidates = [this.shareEvent, this.automatic].filter((event): event is CompanionEvent => !!event && event.sequence > waiter.after);
    const event = candidates.sort((a, b) => a.sequence - b.sequence)[0];
    if (!event) return;
    if (event === this.automatic) this.automatic = null; // no old automatic pixels on reconnect
    waiter.finish(event);
  }

  private inventory(): CloseInventory {
    const value = this.host.closeInventory();
    if (!Array.isArray(value.contexts) || value.contexts.length > 128 || !Array.isArray(value.transfers) || value.transfers.length > 64) throw new Error("close scope exceeds bounded preview; close contexts individually");
    const ids = new Set<number>();
    const contexts = value.contexts.map(context => {
      integer(context.contextId, "close context", 1, Number.MAX_SAFE_INTEGER);
      if (ids.has(context.contextId)) throw new Error("duplicate close context");
      ids.add(context.contextId);
      if (context.contextKind !== "tab" && context.contextKind !== "popup") throw new Error("invalid close context kind");
      integer(context.documentGeneration, "documentGeneration", 0, Number.MAX_SAFE_INTEGER);
      if (context.openerId !== null) integer(context.openerId, "openerId", 1, Number.MAX_SAFE_INTEGER);
      return { contextId: context.contextId, contextKind: context.contextKind, openerId: context.openerId, documentGeneration: context.documentGeneration, title: pageString(context.title, 512) };
    }).sort((a, b) => a.contextId - b.contextId);
    const transfers = value.transfers.map(transfer => ({ id: boundedString(transfer.id, "transfer id", 128), contextId: integer(transfer.contextId, "transfer context", 1, Number.MAX_SAFE_INTEGER), state: boundedString(transfer.state, "transfer state", 32) })).sort((a, b) => a.id.localeCompare(b.id));
    return { contexts, transfers };
  }

  private closeRevision(inventory: CloseInventory) {
    return createHash("sha256").update(JSON.stringify({ ...this.address(), ...inventory })).digest("hex");
  }

  private notify() { try { this.host.onChange?.(); } catch {} }
}

function approvedInventory(current: CloseInventory, approved: CloseInventory, closed: Set<number>) {
  return current.contexts.every(context => !closed.has(context.contextId) && approved.contexts.some(old => old.contextId === context.contextId && old.documentGeneration === context.documentGeneration && old.contextKind === context.contextKind && old.openerId === context.openerId)) &&
    current.transfers.every(transfer => approved.transfers.some(old => old.id === transfer.id && old.contextId === transfer.contextId));
}
function closeDepth(context: CloseContext, contexts: Map<number, CloseContext>) {
  let depth = 0, current: CloseContext | undefined = context;
  const seen = new Set<number>();
  while (current?.openerId != null) {
    if (seen.has(current.contextId) || depth >= 128) throw new Error("invalid close context ancestry");
    seen.add(current.contextId); depth++; current = contexts.get(current.openerId);
  }
  return depth;
}
function ownerKey(owner: BrowserOwner | null) { return createHash("sha256").update(JSON.stringify(owner ? [owner.workspaceId, owner.tabId, owner.paneId, owner.projectDir] : null)).digest("hex"); }
function matchesOwner(value: unknown, expected: BrowserOwner | null): value is BrowserOwner {
  if (!value || typeof value !== "object" || !expected) return false;
  const actual = value as BrowserOwner;
  return sameBrowserOwner(actual, expected) && actual.projectDir === expected.projectDir && (!isNativeBrowserOwner(expected) || actual.sessionId === expected.sessionId);
}
function sameIdentity(left: CompanionIdentity, right: CompanionIdentity) {
  return left.browserSessionKey === right.browserSessionKey && left.runtimeInstanceId === right.runtimeInstanceId &&
    (left.owner === null && right.owner === null || matchesOwner(left.owner, right.owner));
}
function validateTuple(value: ReceiverTuple) { uuid(value.bindingId, "bindingId"); uuid(value.receiverGeneration, "receiverGeneration"); }
function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`invalid ${name}`);
  return value;
}
function uuid(value: unknown, name: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new Error(`invalid ${name}`);
  return value;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`invalid ${name}`);
  return value;
}
function captureFormat(value: unknown): "link" | "visual" { if (value !== "link" && value !== "visual") throw new Error("format must be link or visual"); return value; }
function receiverKind(value: unknown): "pi" | "cli" { if (value !== "pi" && value !== "cli") throw new Error("receiverKind must be pi or cli"); return value; }
function pageString(value: string, max: number) { return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max); }
