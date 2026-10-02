export type ChangeReason = "navigation" | "scroll" | "visual" | "context" | "follow-start" | "updates-stopped";
export interface ChangeIdentity { contextId: number; documentGeneration: number; viewRevision: number }
export type PageChangeData =
  | { kind: "navigation" }
  | { kind: "paint"; dirty?: { x: number; y: number; width: number; height: number }; viewport: { width: number; height: number } }
  | { kind: "scroll"; sourceId: string; x: number; y: number; width: number; height: number; visibleFraction: number }
  | { kind: "structural" };
export type PageChangeHint = ChangeIdentity & PageChangeData;

interface ScrollPosition { x: number; y: number }
interface Candidate { reasons: ChangeReason[]; settled: boolean }

/** Bounded, lossy change hints. This class grants no capture or input permission. */
export class PageChanges {
  private reasons = new Map<ChangeReason, number>();
  private scrolls = new Map<string, { current: ScrollPosition; baseline: ScrollPosition; material: boolean }>();
  private dirty = new Set<number>();
  private navigationAt: number | null = null;
  private painted = false;
  private paintStart = 0;
  private lastPaint = 0;
  private paintSuppressed = false;
  private scrollStart = 0;
  private lastScroll = 0;
  private scrollInterim = false;
  private scrollPaintUntil = 0;

  reset() {
    this.reasons.clear();
    this.scrolls.clear();
    this.dirty.clear();
    this.navigationAt = null;
    this.painted = false;
    this.paintStart = this.lastPaint = this.scrollStart = this.lastScroll = 0;
    this.paintSuppressed = this.scrollInterim = false;
    this.scrollPaintUntil = 0;
  }

  start(reason: "context" | "follow-start", now = Date.now()) { this.reasons.set(reason, now + 200); }

  note(hint: PageChangeData, now = Date.now()) {
    if (hint.kind === "navigation") {
      this.reset();
      this.navigationAt = now;
      this.reasons.set("navigation", now + 200);
      return;
    }
    if (hint.kind === "scroll") {
      if (!validScroll(hint) || hint.visibleFraction < 0.2) return;
      let scroll = this.scrolls.get(hint.sourceId);
      if (!scroll) {
        if (this.scrolls.size >= 64) return;
        scroll = { current: { x: 0, y: 0 }, baseline: { x: 0, y: 0 }, material: false };
        this.scrolls.set(hint.sourceId, scroll);
      }
      if (scroll.current.x !== hint.x || scroll.current.y !== hint.y) {
        // Scroll can dirty the entire paint surface. Do not let paint bypass the net-scroll threshold.
        this.scrollPaintUntil = now + 400;
        this.reasons.delete("visual");
        this.dirty.clear();
      }
      scroll.current = { x: hint.x, y: hint.y };
      scroll.material = Math.abs(hint.x - scroll.baseline.x) >= hint.width * 0.25 || Math.abs(hint.y - scroll.baseline.y) >= hint.height * 0.25;
      if (!scroll.material) {
        if (![...this.scrolls.values()].some(position => position.material)) this.reasons.delete("scroll");
        return;
      }
      if (now - this.lastScroll >= 180) { this.scrollStart = now; this.scrollInterim = false; }
      this.lastScroll = now;
      this.reasons.set("scroll", this.scrollInterim ? now + 180 : Math.min(now + 180, this.scrollStart + 750));
      return;
    }
    if (hint.kind === "paint") {
      this.painted = true;
      if (now < this.scrollPaintUntil) return;
    }
    if (now - this.lastPaint >= 400) {
      this.paintStart = now;
      this.paintSuppressed = false;
      this.dirty.clear();
    }
    this.lastPaint = now;
    if (this.paintSuppressed) return;
    if (hint.kind === "structural") {
      this.reasons.set("visual", Math.min(now + 250, this.paintStart + 1000));
      return;
    }
    const { width, height } = hint.viewport;
    if (!positive(width) || !positive(height)) return;
    const rect = hint.dirty ?? { x: 0, y: 0, width, height };
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return;
    // A tile set avoids counting overlapping dirty rectangles more than once.
    const left = Math.max(0, Math.floor(rect.x * 8 / width));
    const top = Math.max(0, Math.floor(rect.y * 8 / height));
    const right = Math.min(8, Math.ceil((rect.x + rect.width) * 8 / width));
    const bottom = Math.min(8, Math.ceil((rect.y + rect.height) * 8 / height));
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) this.dirty.add(y * 8 + x);
    if (this.dirty.size >= 13) this.reasons.set("visual", Math.min(now + 250, this.paintStart + 1000));
  }

  due(now = Date.now()): number | null {
    if (!this.reasons.size || (this.navigationAt !== null && !this.painted)) return null;
    return Math.max(now, Math.min(...this.reasons.values()));
  }

  take(now = Date.now()): Candidate | null {
    const due = this.due(now);
    if (due === null || due > now) return null;
    const reasons = [...this.reasons.keys()];
    const settled = (!reasons.includes("scroll") || now - this.lastScroll >= 180) &&
      (!reasons.includes("visual") || now - this.lastPaint >= 250);
    this.reasons.clear();
    this.navigationAt = null;
    if (reasons.includes("visual")) this.paintSuppressed = true;
    if (reasons.includes("scroll")) this.scrollInterim = !settled;
    this.dirty.clear();
    return { reasons, settled };
  }

  captured() {
    for (const scroll of this.scrolls.values()) { scroll.baseline = { ...scroll.current }; scroll.material = false; }
  }
}

function positive(value: number) { return Number.isFinite(value) && value > 0 && value <= 1_000_000; }
function validScroll(hint: Extract<PageChangeData, { kind: "scroll" }>) {
  return typeof hint.sourceId === "string" && /^[A-Za-z0-9:._-]{1,96}$/.test(hint.sourceId) &&
    [hint.x, hint.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1_000_000_000) &&
    positive(hint.width) && positive(hint.height) && Number.isFinite(hint.visibleFraction) && hint.visibleFraction >= 0 && hint.visibleFraction <= 1;
}

/** Parse renderer hints only. Native code supplies context/document/view identity. */
export function parsePageChangeMessage(payload: string): PageChangeData | null {
  if (typeof payload !== "string" || payload.length > 2048) return null;
  try {
    const value = JSON.parse(payload);
    if (!value || typeof value !== "object") return null;
    if (value.kind === "structural") return { kind: "structural" };
    if (value.kind !== "scroll" || !validScroll(value)) return null;
    return { kind: "scroll", sourceId: value.sourceId, x: value.x, y: value.y, width: value.width, height: value.height, visibleFraction: value.visibleFraction };
  } catch { return null; }
}

/** Install in each supported document's isolated world with a private CDP binding.
 * The caller must validate its CDP session/frame and clip child-frame hints.
 * No text, key, field value, selector, observation token, or permission is sent.
 */
export function pageChangeObserverSource(bindingName: string): string {
  if (!/^__[A-Za-z0-9_]{8,96}$/.test(bindingName)) throw new Error("invalid page-change binding name");
  return `(() => {
    const emit = globalThis[${JSON.stringify(bindingName)}];
    if (typeof emit !== 'function') return;
    const ids = new WeakMap(); let next = 1; let pending = false; let structural = false;
    const queued = new Set(); const roots = new WeakSet();
    const send = (value) => { try { emit(JSON.stringify(value)); } catch {} };
    const flush = () => {
      pending = false;
      for (const target of queued) {
        const root = target === document || target === document.scrollingElement;
        const el = root ? document.scrollingElement : target;
        if (!el || !el.isConnected) continue;
        if (!ids.has(el)) { if (next > 64) continue; ids.set(el, next++); }
        const r = root ? {left:0,top:0,right:innerWidth,bottom:innerHeight} : el.getBoundingClientRect();
        const width = Math.max(0, Math.min(innerWidth,r.right)-Math.max(0,r.left));
        const height = Math.max(0, Math.min(innerHeight,r.bottom)-Math.max(0,r.top));
        if (!width || !height) continue;
        send({kind:'scroll',sourceId:root?'root':'s'+ids.get(el),x:el.scrollLeft,y:el.scrollTop,width,height,visibleFraction:Math.min(1,width*height/Math.max(1,innerWidth*innerHeight))});
      }
      queued.clear(); if (structural) { structural = false; send({kind:'structural'}); }
    };
    const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(flush); } };
    const scroll = (event) => { if (queued.size < 64) queued.add(event.target); schedule(); };
    let scanned = 0;
    const attach = (root) => {
      if (roots.has(root)) return; roots.add(root); root.addEventListener('scroll',scroll,true);
      const observer = new MutationObserver(records => {
        let count = 0;
        for (const record of records.slice(0,64)) {
          count += record.addedNodes.length + record.removedNodes.length;
          for (const node of Array.from(record.addedNodes).slice(0,64)) if (node.nodeType === 1) discover(node);
          if (record.target.nodeType === 1) {
            const r = record.target.getBoundingClientRect();
            if (r.width*r.height >= innerWidth*innerHeight*.2) structural = true;
          }
        }
        if (count >= 8) structural = true;
        if (structural) schedule();
      });
      observer.observe(root,{childList:true,subtree:true});
    };
    const discover = (root) => {
      if (scanned >= 2000) return;
      if (root.shadowRoot) attach(root.shadowRoot);
      const walker = document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT);
      let el; while ((el=walker.nextNode()) && scanned++ < 2000) if (el.shadowRoot) { attach(el.shadowRoot); discover(el.shadowRoot); }
    };
    attach(document); discover(document); queued.add(document); schedule();
  })()`;
}
