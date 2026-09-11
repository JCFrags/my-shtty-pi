import {
  CURSOR_MARKER,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  VStack,
  HStack,
  truncateToWidth,
  visibleWidth,
  matchesKey,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  PROJECT_GLANCE_DESCRIPTOR_ENV,
  PROJECT_GLANCE_TITLE,
} from "../protocol/model.js";
import { ProjectGlanceClient } from "../protocol/client.js";
import type { HistoryView } from "../history/contracts.js";
import type { ProjectGlanceQuestionAction } from "../questions/model.js";
import type { ProjectGlancePaneDataAdapter } from "./archive.js";
import { ProjectGlanceQuestionsRegion } from "./questions.js";
import {
  ProjectGlancePaneModel,
  type ProjectGlancePaneState,
} from "./model.js";
import {
  renderProjectGlanceFeed,
  renderProjectGlancePinned,
} from "./renderer.js";

function stripOsc8Links(line: string): string {
  return line.replace(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "");
}

export class ProjectGlancePinnedRegion implements Component {
  readonly #model: ProjectGlancePaneModel;

  constructor(model: ProjectGlancePaneModel) {
    this.#model = model;
  }

  invalidate(): void {
    // The region is derived directly from the model on every render.
  }

  render(width: number): string[] {
    return renderProjectGlancePinned(
      this.#model.snapshot,
      this.#model.state,
      width,
    );
  }
}

export class ProjectGlanceFeedRegion implements Component {
  readonly #model: ProjectGlancePaneModel;
  readonly #activateUrl: ((url: string) => void) | undefined;
  #hitTargets = new Map<number, { start: number; end: number; url: string }[]>();
  #cache: { key: string; lines: string[] } | undefined;
  #selectedRow: number | undefined;
  #firstHistoryRow: number | undefined;
  #lastHistoryRow: number | undefined;
  #renderedWidth: number | undefined;
  #actionError = "";
  onBeforeWidthChange: (() => void) | undefined;
  #itemRows = new Map<string, number>();

  constructor(
    model: ProjectGlancePaneModel,
    activateUrl?: (url: string) => void,
  ) {
    this.#model = model;
    this.#activateUrl = activateUrl;
  }

  invalidate(): void { this.#cache = undefined; }

  get selectedRow(): number | undefined {
    return this.#selectedRow;
  }

  rowForItem(id: string): number | undefined { return this.#itemRows.get(id); }
  get firstHistoryRow(): number | undefined { return this.#firstHistoryRow; }
  get lastHistoryRow(): number | undefined { return this.#lastHistoryRow; }

  setActionError(message: string): void {
    if (message === this.#actionError) return;
    this.#actionError = message;
    this.invalidate();
  }

  anchorAt(row: number): { id: string; offset: number } | undefined {
    let anchor: { id: string; offset: number } | undefined;
    for (const [id, start] of this.#itemRows) {
      if (start > row) break;
      anchor = { id, offset: row - start };
    }
    return anchor;
  }

  render(width: number): string[] {
    if (this.#renderedWidth !== undefined && this.#renderedWidth !== width) this.onBeforeWidthChange?.();
    this.#renderedWidth = width;
    const expandedIds = new Set(this.#model.selectableIds.filter((id) => this.#model.isExpanded(id)));
    const selectedId = this.#model.selectedId;
    const snapshot = this.#model.snapshot;
    // snapshot getters return copies. Key actual renderer inputs, not object
    // identity or revision alone (relay/branch changes can reuse revisions).
    const key = JSON.stringify([width, snapshot !== undefined, snapshot?.feed, snapshot?.uiState, selectedId, [...expandedIds], this.#model.archive.summary, this.#model.archive.historyExpanded, this.#actionError]);
    if (this.#cache?.key === key) return this.#cache.lines;
    this.#itemRows.clear();
    const linkedLines = renderProjectGlanceFeed(snapshot, width, {
      ...(selectedId ? { selectedId } : {}),
      expandedIds,
      archive: this.#model.archive,
    });
    if (this.#actionError) linkedLines.push(truncateToWidth(this.#actionError, width));
    const hitTargets = new Map<number, { start: number; end: number; url: string }[]>();
    let selectedRow: number | undefined;
    let firstHistoryRow: number | undefined;
    let lastHistoryRow: number | undefined;
    const historyIds = new Set(this.#model.archive.activeItems("history").map((item) => item.itemId));
    const selectedSuffix = selectedId ? `/${encodeURIComponent(selectedId)}` : undefined;
    for (let y = 0; y < linkedLines.length; y += 1) {
      const line = linkedLines[y] ?? "";
      // The renderer emits non-nested OSC8 spans. Measure each span once,
      // rather than reparsing the full ANSI line and URL for every cell.
      let column = 0;
      let offset = 0;
      let url = "";
      const targets: { start: number; end: number; url: string }[] = [];
      for (const match of line.matchAll(/\u001b\]8;;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/gu)) {
        const end = Math.min(width, column + visibleWidth(line.slice(offset, match.index)));
        if (url && end > column) {
          targets.push({ start: column, end, url });
          const target = new URL(url);
          if (target.hostname === "toggle" || target.hostname === "dismiss") {
            const id = decodeURIComponent(target.pathname.slice(1));
            if (!this.#itemRows.has(id)) this.#itemRows.set(id, y);
            if (historyIds.has(id)) {
              firstHistoryRow ??= y;
              lastHistoryRow = y;
            }
            if (selectedSuffix && url.endsWith(selectedSuffix)) selectedRow ??= y;
          }
        }
        column = end;
        offset = match.index + match[0].length;
        url = match[1] ?? "";
      }
      if (targets.length) hitTargets.set(y, targets);
    }
    this.#hitTargets = hitTargets;
    this.#selectedRow = selectedRow;
    this.#firstHistoryRow = firstHistoryRow;
    this.#lastHistoryRow = lastHistoryRow;
    const lines = linkedLines.map(stripOsc8Links);
    this.#cache = { key, lines };
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (
      event.type !== "click" ||
      event.button !== "left" ||
      !this.#activateUrl
    ) {
      return undefined;
    }
    // Selection/expansion may change without invalidate(), including mouse
    // actions. The render-input key keeps both pixels and hit spans current.
    this.render(event.width);
    const url = this.#hitTargets.get(event.y)?.find((target) => event.x >= target.start && event.x < target.end)?.url;
    if (!url) return undefined;
    this.#activateUrl(url);
    return { handled: true, render: true };
  }
}

/** CURRENT stays outside both independent scrolling regions. */
class PositionedScrollView extends ScrollView {
  afterLayout: (() => void) | undefined;
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    this.afterLayout?.();
  }
}

/** Consume wheels here even at the boundary: pi-tui's fallback can otherwise
 * scroll the primary feed after an exhausted secondary ScrollView.
 */
class QuestionScrollView extends PositionedScrollView {
  override handleMouse(event: TuiMouseEvent): ReturnType<ScrollView["handleMouse"]> {
    if (event.type !== "wheel") return undefined;
    this.scrollBy(event.wheelDelta ?? 0);
    return {
      handled: true, render: true,
      target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height },
    };
  }
}

export interface ProjectGlancePaneQuestionOptions {
  onQuestionAction?: (action: ProjectGlanceQuestionAction) => Promise<void> | void;
  onQuestionEditing?: (questionId: string, revision: number, active: boolean) => void;
  requestRender?: () => void;
  onQuestionFocusExit?: () => void;
  onQuestionFocusEnter?: () => void;
  dataAdapter?: ProjectGlancePaneDataAdapter;
  onDismiss?: (itemId: string) => Promise<void>;
}

/** Fixed edges surround the question viewport, not its scrolling document.
 * These are real layout children, so clipping and pointer origins stay with
 * pi-tui's normal stack/scroll layout on every resize.
 */
class QuestionFrame extends VStack {
  constructor(private readonly scroll: ScrollView) {
    const style = (text: string) => `\u001b[36m${text}\u001b[0m`;
    const edge = (top: boolean): Component => ({
      invalidate() {},
      render(width) {
        const inner = Math.max(0, width - 2);
        const label = top ? truncateToWidth(" QUESTIONS ", inner, "") : "";
        return [style(`${top ? "┌" : "└"}${label}${"─".repeat(Math.max(0, inner - visibleWidth(label)))}${top ? "┐" : "┘"}`)];
      },
    });
    const rail = (): Component => ({ invalidate() {}, render: () => Array.from({ length: 12 }, () => style("│")) });
    super([
      { component: edge(true), basis: 1, shrink: 0 },
      { component: new HStack([
        { component: rail(), basis: 1, shrink: 0 },
        { component: scroll, basis: 0, grow: 1, minSize: 0 },
        { component: rail(), basis: 1, shrink: 0 },
      ]), basis: 0, grow: 1, minSize: 0 },
      { component: edge(false), basis: 1, shrink: 0 },
    ]);
  }

  override handleMouse(event: TuiMouseEvent): ReturnType<VStack["handleMouse"]> {
    if (event.type !== "wheel") return undefined;
    this.scroll.scrollBy(event.wheelDelta ?? 0);
    return {
      handled: true, render: true,
      target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height },
    };
  }
}

/** Public stack metadata keeps CURRENT pinned and reserves at least half the
 * remaining viewport for the feed. With no questions, the original two-child
 * layout is unchanged. The visibility callback also runs on terminal resize.
 */
class QuestionsPaneStack extends VStack {
  constructor(pinned: Component, questions: Component, feed: ScrollView, sync: (width: number, height: number) => boolean) {
    super([
      { component: pinned, shrink: 0 },
      { component: questions, basis: 14, maxSize: 14, shrink: 0, minSize: 0 },
      { component: feed, grow: 1, shrink: 1, minSize: 0 },
    ]);
    // Keep Container.children's existing no-question contract as well as the
    // rendered layout. The hidden metadata entry remains available for arrivals.
    if (!sync(80, 14)) this.children.splice(1, 1);
    const entry = this.entries[1]!;
    entry.visible = ({ width, height }) => {
      const remaining = Math.max(0, height - pinned.render(width).length);
      entry.basis = Math.min(14, Math.floor(remaining / 2));
      // Hide the whole frame when it cannot hold two edges and one content
      // row. Never leave invisible question controls owning keyboard input.
      const shown = sync(width - 2, width >= 3 && entry.basis >= 3 ? entry.basis - 2 : 0) && width >= 3 && entry.basis >= 3;
      const index = this.children.indexOf(questions);
      if (shown && index < 0) this.children.splice(1, 0, questions);
      else if (!shown && index >= 0) this.children.splice(index, 1);
      return shown;
    };
  }
}

export class ProjectGlancePaneView implements Component {
  readonly pinned: ProjectGlancePinnedRegion;
  readonly feed: ProjectGlanceFeedRegion;
  readonly scrollView: PositionedScrollView;
  readonly questions: ProjectGlanceQuestionsRegion;
  readonly questionScrollView: PositionedScrollView;
  #questionWidth = 0;
  #questionViewportAvailable = true;
  #revealQuestionFocus = false;
  #questionIdentity = "";
  #model: ProjectGlancePaneModel;
  #questionOptions: ProjectGlancePaneQuestionOptions;
  #position: { id: string; offset: number; fallbackIds: string[] } | "selected" | undefined;
  #lastRequestedCommit = new Map<HistoryView, number>();
  #archiveBranch: string | undefined;
  #dismissPending = new Set<string>();
  readonly root: VStack;

  constructor(model: ProjectGlancePaneModel, activateUrl?: (url: string) => void, questionOptions: ProjectGlancePaneQuestionOptions = {}) {
    this.#model = model;
    this.#questionOptions = questionOptions;
    this.pinned = new ProjectGlancePinnedRegion(model);
    this.questions = new ProjectGlanceQuestionsRegion(
      (action) => {
        if (model.state !== "connected" || !questionOptions.onQuestionAction) throw new Error("QUESTION_UNAVAILABLE");
        return questionOptions.onQuestionAction(action);
      },
      () => questionOptions.requestRender?.(),
      questionOptions.onQuestionEditing,
    );
    this.questionScrollView = new QuestionScrollView(this.questions, {
      follow: "none", primary: false, overscroll: "contain", scrollbar: "auto",
    });
    this.questionScrollView.afterLayout = () => {
      if (!this.#revealQuestionFocus) return;
      this.#revealQuestionFocus = false;
      const lines = this.questions.render(this.questionScrollView.getContentWidth(this.#questionWidth));
      const row = lines.findIndex((line) => line.includes(CURSOR_MARKER) || line.startsWith(">["));
      if (row < 0) return;
      const scroll = this.questionScrollView;
      if (row < scroll.scrollTop) scroll.scrollTo(row);
      else if (row >= scroll.scrollTop + scroll.viewportHeight) scroll.scrollTo(row - scroll.viewportHeight + 1);
    };
    this.feed = new ProjectGlanceFeedRegion(model, (url) => {
      this.releaseQuestionFocus();
      if (this.handleArchiveUrl(url)) return;
      try {
        const target = new URL(url);
        if (target.hostname === "toggle") this.preserveReadingPosition();
        activateUrl?.(url);
        const itemId = decodeURIComponent(target.pathname.slice(1));
        if (target.hostname === "toggle" && model.isExpanded(itemId)) this.ensureBody(itemId, model.archive.bodyOffset(itemId));
      } catch {
        // Ignore malformed terminal links.
      }
    });
    this.scrollView = new PositionedScrollView(this.feed, {
      follow: "none",
      primary: true,
      overscroll: "contain",
      scrollbar: "auto",
    });
    this.feed.onBeforeWidthChange = () => this.preserveReadingPosition();
    this.scrollView.afterLayout = () => {
      const position = this.#position;
      this.#position = undefined;
      if (position) {
        let anchoredRow: number | undefined;
        if (position !== "selected") {
          for (const id of [position.id, ...position.fallbackIds]) {
            anchoredRow = this.feed.rowForItem(id);
            if (anchoredRow !== undefined) break;
          }
        }
        const row = anchoredRow ?? this.feed.selectedRow;
        if (row !== undefined) this.scrollView.scrollTo(row + (anchoredRow === undefined || position === "selected" ? 0 : position.offset), { disableFollow: true });
      }
      this.maybePrefetchHistory();
    };
    this.root = new QuestionsPaneStack(this.pinned, new QuestionFrame(this.questionScrollView), this.scrollView, (width, height) => {
      this.#questionWidth = width;
      this.#questionViewportAvailable = height > 0;
      const shown = this.syncQuestions();
      if (!this.#questionViewportAvailable && this.questions.focused) this.releaseQuestionFocus();
      return shown;
    });
  }

  /** Identity intentionally excludes the changing snapshot revision. */
  syncQuestions(): boolean {
    const snapshot = this.#model.snapshot;
    const connected = this.#model.state === "connected";
    const identity = JSON.stringify([
      snapshot?.sessionKey ?? this.#model.expectedSessionKey,
      this.#model.expectedGeneration,
      snapshot?.branchId,
      connected,
    ]);
    const questions = connected ? snapshot?.questions ?? [] : [];
    const attention = connected ? snapshot?.questionAttention ?? [] : [];
    this.questions.update(questions, identity, attention);
    if (identity !== this.#questionIdentity) {
      this.#questionIdentity = identity;
      this.questionScrollView.scrollToStart();
    }
    if (!questions.length && !attention.length && this.questions.focused) this.releaseQuestionFocus();
    return questions.length > 0 || attention.length > 0;
  }

  releaseQuestionFocus(): void {
    this.questions.focused = false;
    this.#questionOptions.onQuestionFocusExit?.();
    this.#questionOptions.requestRender?.();
  }

  /** Called BEFORE quit and feed shortcuts. Escape leaves text, then the region. */
  handleQuestionInput(data: string): boolean {
    const available = this.syncQuestions();
    if (!this.#questionViewportAvailable) return false;
    if (!this.questions.ownsKeyboard) {
      if (!available || !matchesKey(data, "tab")) return false;
      this.questions.focused = true;
      this.#questionOptions.onQuestionFocusEnter?.();
      this.#revealQuestionFocus = true;
      this.#questionOptions.requestRender?.();
      return true;
    }
    if (matchesKey(data, "escape") && !this.questions.isEditing) this.releaseQuestionFocus();
    else {
      this.questions.handleInput(data);
      this.#revealQuestionFocus = true;
      this.#questionOptions.requestRender?.();
    }
    return true;
  }

  private syncArchive(): void {
    const adapter = this.#questionOptions.dataAdapter;
    const archive = this.#model.archive;
    const summary = archive.summary;
    if (archive.branchId !== this.#archiveBranch) {
      this.#archiveBranch = archive.branchId;
      this.#lastRequestedCommit.clear();
      this.#dismissPending.clear();
      this.feed.setActionError("");
    }
    if (!adapter || this.#model.state !== "connected" || !archive.branchId || !summary || summary.state !== "ready") return;
    if (this.#lastRequestedCommit.get("inbox") !== summary.commitSeq) {
      if (this.ensurePage("inbox", undefined, archive.activeIsInitial("inbox"), true)) {
        this.#lastRequestedCommit.set("inbox", summary.commitSeq);
      }
    }
    if (archive.historyExpanded && this.#lastRequestedCommit.get("history") !== summary.commitSeq) {
      if (this.ensurePage("history", undefined, archive.activeIsInitial("history"), true)) {
        this.#lastRequestedCommit.set("history", summary.commitSeq);
      }
    }
  }

  private ensurePage(view: HistoryView, cursor: string | undefined, activate: boolean, force = false): boolean {
    const adapter = this.#questionOptions.dataAdapter;
    const branchId = this.#model.archive.branchId;
    if (!adapter || !branchId || this.#model.archive.summary?.state !== "ready") return false;
    if (!force && cursor !== undefined && this.#model.archive.hasCachedPage(view, cursor)) {
      const included = activate
        ? this.#model.archive.activateCachedPage(view, cursor)
        : view === "history" && this.#model.archive.includeCachedHistoryPage(cursor);
      if (included) {
        this.#model.reconcileSelection();
        if (activate) this.requestSelectedPosition();
        this.root.invalidate();
        this.#questionOptions.requestRender?.();
      }
      return included;
    }
    if (!this.#model.archive.beginPage(view, cursor)) return false;
    this.root.invalidate();
    this.#questionOptions.requestRender?.();
    void adapter.requestPage(branchId, view, cursor).then((page) => {
      if (this.#model.archive.branchId !== branchId) return;
      this.preserveReadingPosition();
      const currentCommit = this.#model.archive.summary?.commitSeq;
      const staleInitial = cursor === undefined && currentCommit !== undefined && page.snapshotSeq < currentCommit;
      if (staleInitial) {
        // The initial page key is also the active key. Storing an old response,
        // even without explicit activation, would make stale cards visible.
        this.#model.archive.failPage(view, cursor);
      } else if (this.#model.archive.receivePage(view, cursor, page, activate)) {
        this.#model.reconcileSelection();
        if (activate) this.requestSelectedPosition();
      }
      // A newer snapshot can arrive while the initial page request is in
      // flight. The suppressed request must start as soon as this one clears.
      this.syncArchive();
      this.root.invalidate();
      this.#questionOptions.requestRender?.();
    }, () => {
      if (this.#model.archive.branchId !== branchId) return;
      this.#model.archive.failPage(view, cursor);
      this.syncArchive();
      this.root.invalidate();
      this.#questionOptions.requestRender?.();
    });
    return true;
  }

  toggleHistory(): void {
    this.preserveReadingPosition();
    const expanded = this.#model.archive.toggleHistory();
    this.#model.reconcileSelection();
    if (expanded) this.ensurePage("history", undefined, true);
    this.root.invalidate();
    this.#questionOptions.requestRender?.();
  }

  toggleSelected(): void {
    const itemId = this.#model.selectedId;
    if (!itemId) return;
    this.preserveReadingPosition();
    this.#model.toggleExpanded(itemId);
    if (this.#model.isExpanded(itemId)) this.ensureBody(itemId, this.#model.archive.bodyOffset(itemId));
  }

  dismissSelected(): void {
    const itemId = this.#model.selectedId;
    if (itemId) this.dismissItem(itemId);
  }

  dismissItem(itemId: string): void {
    const snapshot = this.#model.snapshot;
    const isInboxItem = this.#model.archive.activeItems("inbox").some((item) => item.itemId === itemId);
    if (!snapshot?.branchId || !isInboxItem || !this.#questionOptions.onDismiss || this.#dismissPending.has(itemId)) return;
    const branchId = snapshot.branchId;
    this.preserveReadingPosition();
    this.feed.setActionError("");
    this.#dismissPending.add(itemId);
    this.root.invalidate();
    this.#questionOptions.requestRender?.();
    const send = async () => { await this.#questionOptions.onDismiss?.(itemId); };
    void send().then(() => {
      if (this.#model.snapshot?.branchId !== branchId) return;
      this.preserveReadingPosition();
      this.feed.setActionError("");
    }, () => {
      if (this.#model.snapshot?.branchId !== branchId) return;
      this.preserveReadingPosition();
      this.feed.setActionError("Dismiss failed. The Inbox item remains. Review the current Inbox and retry.");
    }).finally(() => {
      this.#dismissPending.delete(itemId);
      this.root.invalidate();
      this.#questionOptions.requestRender?.();
    });
  }

  navigatePage(direction: "previous" | "next", view?: HistoryView): void {
    const selected = this.#model.selectedId;
    const activeView = view ?? (selected && this.#model.archive.activeItems("history").some((item) => item.itemId === selected) ? "history" : "inbox");
    const cursor = this.#model.archive.pageCursor(activeView, direction);
    if (!cursor) return;
    this.ensurePage(activeView, cursor, activeView === "inbox");
  }

  private ensureBody(itemId: string, offset: number): void {
    const adapter = this.#questionOptions.dataAdapter;
    const branchId = this.#model.archive.branchId;
    if (!adapter || !branchId || this.#model.archive.summary?.state !== "ready") return;
    if (this.#model.archive.setBodyOffset(itemId, offset)) {
      this.root.invalidate();
      this.#questionOptions.requestRender?.();
      return;
    }
    if (!this.#model.archive.beginBody(itemId, offset)) return;
    this.root.invalidate();
    this.#questionOptions.requestRender?.();
    void adapter.requestBody(branchId, itemId, offset).then((body) => {
      if (this.#model.archive.branchId !== branchId) return;
      this.preserveReadingPosition();
      this.#model.archive.receiveBody(itemId, offset, body);
      this.root.invalidate();
      this.#questionOptions.requestRender?.();
    }, () => {
      if (this.#model.archive.branchId !== branchId) return;
      this.#model.archive.failBody(itemId, offset);
      this.root.invalidate();
      this.#questionOptions.requestRender?.();
    });
  }

  private handleArchiveUrl(url: string): boolean {
    try {
      const target = new URL(url);
      if (target.hostname === "history") {
        this.toggleHistory();
        return true;
      }
      if (target.hostname === "dismiss") {
        this.dismissItem(decodeURIComponent(target.pathname.slice(1)));
        return true;
      }
      const match = /^page-(inbox|history)-(previous|next)$/u.exec(target.hostname);
      if (match) {
        this.navigatePage(match[2] as "previous" | "next", match[1] as HistoryView);
        return true;
      }
      const first = /^page-(inbox|history)-first$/u.exec(target.hostname);
      if (first) {
        this.ensurePage(first[1] as HistoryView, undefined, true);
        return true;
      }
      if (target.hostname === "body-next" || target.hostname === "body-previous") {
        this.preserveReadingPosition();
        const itemId = decodeURIComponent(target.pathname.slice(1));
        const offset = this.#model.archive.moveBody(itemId, target.hostname === "body-next" ? "next" : "previous");
        if (offset !== undefined) this.ensureBody(itemId, offset);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private maybePrefetchHistory(): void {
    if (!this.#model.archive.historyExpanded) return;
    const first = this.feed.firstHistoryRow;
    const last = this.feed.lastHistoryRow;
    if (first === undefined || last === undefined) return;
    const margin = Math.max(3, this.scrollView.viewportHeight);
    const visibleTop = this.scrollView.scrollTop;
    const visibleBottom = visibleTop + this.scrollView.viewportHeight;
    const previous = this.#model.archive.pageCursor("history", "previous");
    const next = this.#model.archive.pageCursor("history", "next");
    if (previous && visibleTop <= first + margin) this.ensurePage("history", previous, false);
    if (next && visibleBottom >= last - margin) this.ensurePage("history", next, false);
  }

  invalidate(): void {
    this.syncQuestions();
    this.syncArchive();
    this.root.invalidate();
  }

  render(width: number): string[] {
    this.#questionWidth = width;
    return this.root.render(width);
  }

  preserveReadingPosition(): void {
    if (this.#position) return;
    const anchor = this.feed.anchorAt(this.scrollView.scrollTop);
    if (!anchor) return;
    const ids = this.#model.selectableIds;
    const index = ids.indexOf(anchor.id);
    this.#position = { ...anchor, fallbackIds: index < 0 ? [] : [...ids.slice(index + 1), ...ids.slice(0, index).reverse()] };
  }

  requestSelectedPosition(): void { this.#position = "selected"; }

  scrollToSelected(width: number): void {
    this.feed.render(this.scrollView.getContentWidth(width));
    const selectedRow = this.feed.selectedRow;
    if (selectedRow !== undefined) {
      this.scrollView.scrollTo(selectedRow, { disableFollow: true });
    }
  }
}

function isQuitInput(data: string): boolean {
  return data === "q" || data === "Q" || data === "\u001b";
}

function conciseStartError(): void {
  process.stderr.write("Project Glance pane could not start.\n");
  process.exitCode = 1;
}

export async function main(): Promise<void> {
  if (process.platform !== "linux") {
    process.stderr.write("Project Glance supports Linux only.\n");
    process.exitCode = 1;
    return;
  }
  const descriptorPath = process.env[PROJECT_GLANCE_DESCRIPTOR_ENV];
  if (!descriptorPath) {
    process.stderr.write("Project Glance connection is unavailable.\n");
    process.exitCode = 2;
    return;
  }

  const model = new ProjectGlancePaneModel();
  const terminal = new ProcessTerminal();
  let client: ProjectGlanceClient;
  let tui: TuiAltScreen;
  const activate = (url: string): void => {
    try {
      const target = new URL(url);
      if (target.protocol !== "project-glance:") return;
      const action = target.hostname;
      const itemId = decodeURIComponent(target.pathname.slice(1));
      if (!model.selectableIds.includes(itemId)) return;
      if (action === "toggle") model.toggleExpanded(itemId);
      tui.requestRender();
    } catch {
      // Ignore malformed terminal links.
    }
  };
  const view = new ProjectGlancePaneView(model, activate, {
    onQuestionAction: (action) => {
      const snapshot = model.snapshot;
      if (model.state !== "connected" || !snapshot?.branchId || !client) return Promise.reject(new Error("QUESTION_UNAVAILABLE"));
      return client.sendQuestionAction(snapshot.branchId, snapshot.revision, action);
    },
    onQuestionEditing: (questionId, revision, active) => {
      const branchId = model.snapshot?.branchId;
      if (model.state === "connected" && branchId && client) client.setQuestionEditing(branchId, questionId, revision, active);
    },
    onDismiss: (itemId) => {
      const snapshot = model.snapshot;
      if (model.state !== "connected" || !snapshot?.branchId || !client) return Promise.reject(new Error("INBOX_UNAVAILABLE"));
      return client.sendFeedAction(snapshot.branchId, snapshot.revision, { type: "dismiss", itemId });
    },
    dataAdapter: {
      requestPage: (branchId, historyView, cursor) => client.requestPage(branchId, historyView, cursor),
      requestBody: (branchId, itemId, offset) => client.requestBody(branchId, itemId, offset),
    },
    requestRender: () => tui?.requestRender(),
    onQuestionFocusExit: () => tui?.setFocus(null),
    onQuestionFocusEnter: () => tui?.setFocus(view.questions),
  });
  tui = new TuiAltScreen(terminal, false, undefined, {
    mouse: true,
    wheelScrollLines: 3,
  });
  tui.setLayoutRoot(view.root);
  terminal.setTitle(PROJECT_GLANCE_TITLE);

  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onSignal = (): void => finish();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  const removeInput = tui.addInputListener((data) => {
    if (view.handleQuestionInput(data)) return { consume: true };
    if (isQuitInput(data)) {
      finish();
      return { consume: true };
    }
    if (data === "j" || data === "\u001b[B") {
      model.selectRelative(1);
      view.requestSelectedPosition();
    } else if (data === "k" || data === "\u001b[A") {
      model.selectRelative(-1);
      view.requestSelectedPosition();
    } else if (data === "u") {
      model.focusOldestUnread();
      view.requestSelectedPosition();
    } else if (data === "[") view.navigatePage("previous");
    else if (data === "]") view.navigatePage("next");
    else if (data === "h") view.toggleHistory();
    else if ((data === "\r" || data === " ") && model.selectedId) view.toggleSelected();
    else if (data === "d" && model.selectedId) view.dismissSelected();
    else return undefined;
    view.invalidate();
    tui.requestRender();
    return { consume: true };
  });
  const requestRender = (): void => {
    view.invalidate();
    tui.requestRender();
  };
  client = new ProjectGlanceClient({
    descriptorPath,
    onState: (state) => {
      model.setConnectionState(state as ProjectGlancePaneState);
      requestRender();
    },
    onDescriptor: (descriptor) => {
      try {
        model.setExpectedRelay(descriptor);
      } catch {
        model.setConnectionState("disconnected");
      }
      requestRender();
    },
    onSnapshot: (snapshot, identity) => {
      try {
        const previous = model.snapshot;
        view.preserveReadingPosition();
        const applied = model.applySnapshot(snapshot, identity);
        if (applied !== "applied") { requestRender(); return; }
        if (!previous || previous.branchId !== snapshot.branchId) view.requestSelectedPosition();
        if (model.consumeFocusRequest() && snapshot.branchId) {
          if (model.unreadCount > 0) {
            model.focusOldestUnread();
            view.requestSelectedPosition();
          }
          requestRender();
          return;
        }
      } catch {
        model.setConnectionState("reconnecting");
      }
      requestRender();
    },
    onError: () => requestRender(),
  });

  try {
    tui.start();
    client.start();
    await finished;
  } catch {
    conciseStartError();
  } finally {
    client.stop();
    removeInput();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    tui.setLayoutRoot(undefined);
    tui.stop();
  }
}
