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
import type { ProjectGlanceQuestionAction } from "../questions/model.js";
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

  anchorAt(row: number): { id: string; offset: number } | undefined {
    let anchor: { id: string; offset: number } | undefined;
    for (const [id, start] of this.#itemRows) {
      if (start > row) break;
      anchor = { id, offset: row - start };
    }
    return anchor;
  }

  render(width: number): string[] {
    const expandedIds = new Set(
      this.#model.visibleFeed
        .filter((item) => this.#model.isExpanded(item.id))
        .map((item) => item.id),
    );
    const selectedId = this.#model.selectedId;
    const snapshot = this.#model.snapshot;
    // snapshot getters return copies. Key actual renderer inputs, not object
    // identity or revision alone (relay/branch changes can reuse revisions).
    const key = JSON.stringify([width, snapshot !== undefined, snapshot?.feed, snapshot?.uiState, selectedId, [...expandedIds]]);
    if (this.#cache?.key === key) return this.#cache.lines;
    this.#itemRows.clear();
    const linkedLines = renderProjectGlanceFeed(snapshot, width, {
      ...(selectedId ? { selectedId } : {}),
      expandedIds,
    });
    const hitTargets = new Map<number, { start: number; end: number; url: string }[]>();
    let selectedRow: number | undefined;
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
          const id = decodeURIComponent(new URL(url).pathname.slice(1));
          if (!this.#itemRows.has(id)) this.#itemRows.set(id, y);
          if (selectedSuffix && url.endsWith(selectedSuffix)) selectedRow ??= y;
        }
        column = end;
        offset = match.index + match[0].length;
        url = match[1] ?? "";
      }
      if (targets.length) hitTargets.set(y, targets);
    }
    this.#hitTargets = hitTargets;
    this.#selectedRow = selectedRow;
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
  requestRender?: () => void;
  onQuestionFocusExit?: () => void;
  onQuestionFocusEnter?: () => void;
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
  #position: { id: string; offset: number } | "selected" | undefined;
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
    this.feed = new ProjectGlanceFeedRegion(model, activateUrl ? (url) => {
      this.releaseQuestionFocus();
      activateUrl(url);
    } : undefined);
    this.scrollView = new PositionedScrollView(this.feed, {
      follow: "none",
      primary: true,
      overscroll: "contain",
      scrollbar: "auto",
    });
    this.scrollView.afterLayout = () => {
      const position = this.#position;
      this.#position = undefined;
      if (!position) return;
      const anchoredRow = position === "selected" ? undefined : this.feed.rowForItem(position.id);
      const row = anchoredRow ?? this.feed.selectedRow;
      if (row !== undefined) this.scrollView.scrollTo(row + (anchoredRow === undefined || position === "selected" ? 0 : position.offset), { disableFollow: true });
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
    this.questions.update(questions, identity);
    if (identity !== this.#questionIdentity) {
      this.#questionIdentity = identity;
      this.questionScrollView.scrollToStart();
    }
    if (!questions.length && this.questions.focused) this.releaseQuestionFocus();
    return questions.length > 0;
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

  invalidate(): void {
    this.syncQuestions();
    this.root.invalidate();
  }

  render(width: number): string[] {
    this.#questionWidth = width;
    return this.root.render(width);
  }

  preserveReadingPosition(): void {
    this.#position ??= this.feed.anchorAt(this.scrollView.scrollTop);
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
      const snapshot = model.snapshot;
      if (!snapshot?.branchId || !snapshot.feed.some((item) => item.id === itemId)) return;

      if (action === "toggle") {
        model.toggleExpanded(itemId);
      } else if (action === "read" || action === "dismiss") {
        client?.sendAction(snapshot.branchId, snapshot.revision, {
          type: action === "read" ? "mark_read" : "dismiss",
          itemId,
        });
      }
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
    if (data === "j" || data === "\u001b[B") model.selectRelative(1);
    else if (data === "k" || data === "\u001b[A") model.selectRelative(-1);
    else if (data === "u") model.focusOldestUnread();
    else if ((data === "\r" || data === " ") && model.selectedId) {
      model.toggleExpanded(model.selectedId);
    } else if ((data === "r" || data === "d") && model.selectedId) {
      const snapshot = model.snapshot;
      if (snapshot?.branchId) {
        client?.sendAction(snapshot.branchId, snapshot.revision, {
          type: data === "r" ? "mark_read" : "dismiss",
          itemId: model.selectedId,
        });
      }
    } else {
      return undefined;
    }
    view.requestSelectedPosition();
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
          client.sendAction(snapshot.branchId, snapshot.revision, { type: "focus" });
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
