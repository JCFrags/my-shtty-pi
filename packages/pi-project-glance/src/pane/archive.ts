import type {
  BodyResult,
  HistoryView,
  ItemPreview,
  PageResult,
} from "../history/contracts.js";

export const MAX_CACHED_ARCHIVE_PAGES = 5;
export const MAX_RENDERED_HISTORY_PAGES = 3;
export const MAX_CACHED_BODY_CHUNKS = 4;
const INITIAL_PAGE = "@initial";

export interface ProjectGlanceArchiveSummary {
  inboxCount: number;
  historyCount: number;
  commitSeq: number;
  state: "ready" | "importing" | "error";
  errorCode?: string;
}

export interface ProjectGlancePaneDataAdapter {
  requestPage(branchId: string, view: HistoryView, cursor?: string): Promise<PageResult>;
  requestBody(branchId: string, itemId: string, offset?: number): Promise<BodyResult>;
}

interface ViewState {
  activeKey: string;
  pages: Map<string, PageResult>;
  loading: Set<string>;
  historyWindow: string[];
  error?: string;
}

interface BodyState {
  offset: number;
  chunks: Map<number, BodyResult>;
  loading: Set<number>;
  error?: string;
}

function pageKey(cursor?: string): string {
  return cursor ?? INITIAL_PAGE;
}

/** Pane-local bounded cache. Transport validation and persistence stay outside the UI. */
export class ProjectGlanceArchiveModel {
  #branchId: string | undefined;
  #summary: ProjectGlanceArchiveSummary | undefined;
  #historyExpanded = false;
  #views: Record<HistoryView, ViewState> = {
    inbox: { activeKey: INITIAL_PAGE, pages: new Map(), loading: new Set(), historyWindow: [] },
    history: { activeKey: INITIAL_PAGE, pages: new Map(), loading: new Set(), historyWindow: [] },
  };
  #pageLru: string[] = [];
  #bodies = new Map<string, BodyState>();
  #bodyLru: string[] = [];

  get branchId(): string | undefined { return this.#branchId; }
  get summary(): ProjectGlanceArchiveSummary | undefined { return this.#summary; }
  get historyExpanded(): boolean { return this.#historyExpanded; }

  sync(branchId: string | undefined, summary?: ProjectGlanceArchiveSummary): boolean {
    const changed = branchId !== this.#branchId;
    if (changed) {
      this.#branchId = branchId;
      this.#historyExpanded = false;
      this.#views = {
        inbox: { activeKey: INITIAL_PAGE, pages: new Map(), loading: new Set(), historyWindow: [] },
        history: { activeKey: INITIAL_PAGE, pages: new Map(), loading: new Set(), historyWindow: [] },
      };
      this.#pageLru = [];
      this.#bodies.clear();
      this.#bodyLru = [];
    }
    this.#summary = summary;
    return changed;
  }

  toggleHistory(): boolean {
    this.#historyExpanded = !this.#historyExpanded;
    return this.#historyExpanded;
  }

  activePage(view: HistoryView): PageResult | undefined {
    const state = this.#views[view];
    const page = state.pages.get(state.activeKey);
    if (page) this.#touchPage(view, state.activeKey);
    return page;
  }

  hasActivePage(view: HistoryView): boolean {
    return this.#views[view].pages.has(this.#views[view].activeKey);
  }

  activeIsInitial(view: HistoryView): boolean { return this.#views[view].activeKey === INITIAL_PAGE; }

  activeItems(view: HistoryView): readonly ItemPreview[] {
    if (view !== "history") return this.activePage(view)?.items ?? [];
    const state = this.#views.history;
    const seen = new Set<string>();
    const items: ItemPreview[] = [];
    for (const key of state.historyWindow) {
      const page = state.pages.get(key);
      if (!page) continue;
      this.#touchPage("history", key);
      for (const item of page.items) {
        if (seen.has(item.itemId)) continue;
        seen.add(item.itemId);
        items.push(item);
      }
    }
    return items;
  }

  pageLoading(view: HistoryView): boolean {
    return this.#views[view].loading.has(this.#views[view].activeKey);
  }

  pageError(view: HistoryView): string | undefined { return this.#views[view].error; }

  beginPage(view: HistoryView, cursor?: string): boolean {
    if (!this.#branchId) return false;
    const state = this.#views[view];
    const key = pageKey(cursor);
    if (state.loading.has(key)) return false;
    state.loading.add(key);
    delete state.error;
    return true;
  }

  receivePage(view: HistoryView, cursor: string | undefined, page: PageResult, activate: boolean): boolean {
    const state = this.#views[view];
    const key = pageKey(cursor);
    state.loading.delete(key);
    if (!this.#branchId || page.branchId !== this.#branchId || page.view !== view) return false;
    state.pages.set(key, page);
    if (view === "history") this.#includeHistoryPage(key, activate);
    else if (activate) state.activeKey = key;
    delete state.error;
    this.#touchPage(view, key);
    this.#evictPages();
    return true;
  }

  failPage(view: HistoryView, cursor?: string): void {
    const state = this.#views[view];
    state.loading.delete(pageKey(cursor));
    state.error = "Page request failed. Retry when the connection is available.";
  }

  pageCursor(view: HistoryView, direction: "previous" | "next"): string | undefined {
    if (view !== "history") return this.activePage(view)?.[direction === "previous" ? "previousCursor" : "nextCursor"];
    const state = this.#views.history;
    const key = direction === "previous" ? state.historyWindow[0] : state.historyWindow.at(-1);
    return key ? state.pages.get(key)?.[direction === "previous" ? "previousCursor" : "nextCursor"] : undefined;
  }

  hasCachedPage(view: HistoryView, cursor: string): boolean {
    return this.#views[view].pages.has(pageKey(cursor));
  }

  activateCachedPage(view: HistoryView, cursor: string): boolean {
    const state = this.#views[view];
    const key = pageKey(cursor);
    if (!state.pages.has(key)) return false;
    if (view === "history") this.#includeHistoryPage(key, true);
    else state.activeKey = key;
    delete state.error;
    this.#touchPage(view, key);
    return true;
  }

  includeCachedHistoryPage(cursor: string): boolean {
    const key = pageKey(cursor);
    if (!this.#views.history.pages.has(key)) return false;
    this.#includeHistoryPage(key, false);
    delete this.#views.history.error;
    this.#touchPage("history", key);
    return true;
  }

  beginBody(itemId: string, offset = 0): boolean {
    if (!this.#branchId) return false;
    const state: BodyState = this.#bodies.get(itemId) ?? { offset, chunks: new Map(), loading: new Set<number>() };
    this.#bodies.set(itemId, state);
    state.offset = offset;
    if (state.loading.has(offset)) return false;
    state.loading.add(offset);
    delete state.error;
    return true;
  }

  receiveBody(itemId: string, requestedOffset: number, body: BodyResult): boolean {
    const state = this.#bodies.get(itemId);
    if (!state) return false;
    state.loading.delete(requestedOffset);
    if (body.itemId !== itemId || body.offset !== requestedOffset) return false;
    state.offset = body.offset;
    state.chunks.set(body.offset, body);
    delete state.error;
    this.#touchBody(itemId, body.offset);
    this.#evictBodies();
    return true;
  }

  failBody(itemId: string, offset: number): void {
    const state = this.#bodies.get(itemId);
    state?.loading.delete(offset);
    if (state) state.error = "Body request failed. The preview remains available.";
  }

  body(itemId: string): BodyResult | undefined {
    const state = this.#bodies.get(itemId);
    const body = state?.chunks.get(state.offset);
    if (body) this.#touchBody(itemId, body.offset);
    return body;
  }

  bodyOffset(itemId: string): number { return this.#bodies.get(itemId)?.offset ?? 0; }

  moveBody(itemId: string, direction: "previous" | "next"): number | undefined {
    const state = this.#bodies.get(itemId);
    if (!state) return undefined;
    const body = state.chunks.get(state.offset);
    const offset = direction === "previous" ? body?.previousOffset : body?.nextOffset;
    if (offset === undefined) return undefined;
    state.offset = offset;
    return offset;
  }

  canMoveBodyPrevious(itemId: string): boolean { return this.body(itemId)?.previousOffset !== undefined; }

  bodyLoading(itemId: string): boolean {
    const state = this.#bodies.get(itemId);
    return state?.loading.has(state.offset) ?? false;
  }
  bodyError(itemId: string): string | undefined { return this.#bodies.get(itemId)?.error; }

  setBodyOffset(itemId: string, offset: number): boolean {
    const state = this.#bodies.get(itemId);
    if (!state) return false;
    state.offset = Math.max(0, Math.floor(offset));
    delete state.error;
    const cached = state.chunks.has(state.offset);
    if (cached) this.#touchBody(itemId, state.offset);
    return cached;
  }

  cachedPageCount(): number { return this.#pageLru.length; }
  renderedHistoryPageCount(): number { return this.#views.history.historyWindow.length; }
  cachedBodyChunkCount(): number { return this.#bodyLru.length; }

  #includeHistoryPage(key: string, activate: boolean): void {
    const state = this.#views.history;
    if (activate || state.historyWindow.length === 0) {
      state.historyWindow = [key];
    } else if (!state.historyWindow.includes(key)) {
      const first = state.historyWindow[0];
      const last = state.historyWindow.at(-1);
      if (first && state.pages.get(first)?.previousCursor === key) state.historyWindow.unshift(key);
      else if (last && state.pages.get(last)?.nextCursor === key) state.historyWindow.push(key);
      else return;
    }
    while (state.historyWindow.length > MAX_RENDERED_HISTORY_PAGES) {
      const addedAtStart = state.historyWindow[0] === key;
      if (addedAtStart) state.historyWindow.pop();
      else state.historyWindow.shift();
    }
    state.activeKey = state.historyWindow[0] ?? INITIAL_PAGE;
  }

  #touchPage(view: HistoryView, key: string): void {
    const value = `${view}\u0000${key}`;
    this.#pageLru = this.#pageLru.filter((entry) => entry !== value);
    this.#pageLru.push(value);
  }

  #evictPages(): void {
    while (this.#pageLru.length > MAX_CACHED_ARCHIVE_PAGES) {
      const protectedKeys = new Set<unknown>([
        `inbox\u0000${this.#views.inbox.activeKey}`,
        ...this.#views.history.historyWindow.map((key) => `history\u0000${key}`),
      ]);
      const index = this.#pageLru.findIndex((entry) => !protectedKeys.has(entry));
      if (index < 0) return;
      const entry = this.#pageLru.splice(index, 1)[0];
      if (entry === undefined) return;
      const split = entry.indexOf("\u0000");
      const view = entry.slice(0, split) as HistoryView;
      this.#views[view].pages.delete(entry.slice(split + 1));
    }
  }

  #touchBody(itemId: string, offset: number): void {
    const value = `${itemId}\u0000${offset}`;
    this.#bodyLru = this.#bodyLru.filter((entry) => entry !== value);
    this.#bodyLru.push(value);
  }

  #evictBodies(): void {
    while (this.#bodyLru.length > MAX_CACHED_BODY_CHUNKS) {
      const entry = this.#bodyLru.shift();
      if (!entry) return;
      const split = entry.lastIndexOf("\u0000");
      const itemId = entry.slice(0, split);
      const offset = Number(entry.slice(split + 1));
      this.#bodies.get(itemId)?.chunks.delete(offset);
    }
  }
}
