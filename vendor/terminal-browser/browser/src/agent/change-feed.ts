import type { AgentVisualObservation } from "./types";
import { PageChanges, type ChangeReason, type PageChangeHint } from "./page-changes";

export type CompanionMode = "agent" | "human" | "shared" | "paused";
export interface VisibleContext {
  contextId: number;
  contextKind: "tab" | "popup";
  documentGeneration: number;
  viewRevision: number;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  visible: boolean;
}

export interface ChangeCapture {
  context: VisibleContext;
  visual: AgentVisualObservation;
  capturedAt: number;
  reasons: ChangeReason[];
  settled: boolean;
}

export interface ChangeFeedHost {
  visibleContext(): VisibleContext | null;
  canCapture(): boolean;
  demandToken(): unknown;
  capture(context: VisibleContext): Promise<AgentVisualObservation>;
  publish(capture: ChangeCapture): void;
}

/** Demand-driven: one timer for recorded changes and one capture, never a poll loop. */
export class ChangeFeed {
  private readonly changes = new PageChanges();
  private contextKey = "";
  private revision = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private disposed = false;
  private fingerprint: Buffer | null = null;

  constructor(private readonly host: ChangeFeedHost) {}

  changed(hint: PageChangeHint) {
    const current = this.host.visibleContext();
    if (!current?.visible || hint.contextId !== current.contextId || hint.documentGeneration !== current.documentGeneration || hint.viewRevision !== current.viewRevision) return;
    this.reconcile(current);
    this.changes.note(hint);
    this.schedule();
  }

  start(reason: "context" | "follow-start") {
    const current = this.host.visibleContext();
    if (!current?.visible) { this.clear(); return; }
    this.reconcile(current);
    this.changes.start(reason);
    this.schedule();
  }

  wake() { this.schedule(); }

  clear() {
    this.revision++;
    this.contextKey = "";
    this.fingerprint = null;
    this.changes.reset();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  dispose() { this.disposed = true; this.clear(); }

  private reconcile(context: VisibleContext) {
    const key = `${context.contextId}:${context.documentGeneration}:${context.viewport.width}:${context.viewport.height}`;
    if (this.contextKey === key) return;
    this.clear();
    this.contextKey = key;
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed || this.inFlight || !this.host.canCapture()) return;
    const due = this.changes.due();
    if (due === null) return;
    this.timer = setTimeout(() => { this.timer = null; void this.capture(); }, Math.max(0, due - Date.now()));
  }

  private async capture() {
    if (this.disposed || this.inFlight || !this.host.canCapture()) return;
    const context = this.host.visibleContext();
    if (!context?.visible) return;
    this.reconcile(context);
    const candidate = this.changes.take();
    if (!candidate) return;
    const revision = this.revision;
    const demand = this.host.demandToken();
    this.inFlight = true;
    try {
      const visual = await this.host.capture(context);
      if (this.disposed || revision !== this.revision || demand !== this.host.demandToken() || !this.host.canCapture() || !sameVisibleContext(context, this.host.visibleContext())) return;
      const fingerprint = coarseFingerprint(visual.data);
      const forced = candidate.reasons.some(reason => reason !== "visual");
      if (!forced && this.fingerprint && !differentPixels(this.fingerprint, fingerprint)) return;
      this.fingerprint = fingerprint;
      this.changes.captured();
      this.host.publish({ context, visual, capturedAt: Date.now(), ...candidate });
    } catch {
      // No uncertain retry. A later native change or explicit capture can try again.
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }
}

export function sameVisibleContext(expected: VisibleContext, current: VisibleContext | null): boolean {
  return current?.visible === true && expected.visible && current.contextId === expected.contextId &&
    current.contextKind === expected.contextKind && current.documentGeneration === expected.documentGeneration &&
    current.viewRevision === expected.viewRevision && current.viewport.width === expected.viewport.width &&
    current.viewport.height === expected.viewport.height;
}

export function visualFromPng(data: Buffer, viewport: VisibleContext["viewport"]): AgentVisualObservation {
  if (!Buffer.isBuffer(data) || data.length < 24 || data.length > 2 * 1024 * 1024 ||
      !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("invalid or oversized page PNG");
  }
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width > 1600 || height > 1600 || ![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0 && value <= 1_000_000)) {
    throw new Error("invalid page capture dimensions");
  }
  return { mimeType: "image/png", width, height, bytes: data.length, scope: "viewport", rect: { x: 0, y: 0, ...viewport }, data };
}

function coarseFingerprint(png: Buffer): Buffer {
  // Decode only the bounded PNG. Never retain an offscreen texture or paint buffer.
  const { nativeImage } = require("electron") as typeof import("electron");
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error("page PNG could not be decoded");
  return image.resize({ width: 16, height: 16, quality: "good" }).toBitmap();
}

function differentPixels(before: Buffer, after: Buffer) {
  if (before.length !== after.length || after.length !== 16 * 16 * 4) return true;
  let changed = 0;
  for (let i = 0; i < after.length; i += 4) {
    const difference = Math.abs(before[i]! - after[i]!) + Math.abs(before[i + 1]! - after[i + 1]!) + Math.abs(before[i + 2]! - after[i + 2]!);
    if (difference / 3 >= 12) changed++;
  }
  return changed / 256 >= 0.15;
}
