import {
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  VStack,
  getOsc8LinkAtColumn,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  PROJECT_GLANCE_DESCRIPTOR_ENV,
  PROJECT_GLANCE_TITLE,
} from "../protocol/model.js";
import { ProjectGlanceClient } from "../protocol/client.js";
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
  #hitTargets = new Map<string, string>();
  #renderWidth = 0;
  #selectedRow: number | undefined;
  #itemRows = new Map<string, number>();

  constructor(
    model: ProjectGlancePaneModel,
    activateUrl?: (url: string) => void,
  ) {
    this.#model = model;
    this.#activateUrl = activateUrl;
  }

  invalidate(): void {
    // The region is derived directly from the model on every render.
  }

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
    this.#itemRows.clear();
    const expandedIds = new Set(
      this.#model.visibleFeed
        .filter((item) => this.#model.isExpanded(item.id))
        .map((item) => item.id),
    );
    const selectedId = this.#model.selectedId;
    const linkedLines = renderProjectGlanceFeed(this.#model.snapshot, width, {
      ...(selectedId ? { selectedId } : {}),
      expandedIds,
    });
    const hitTargets = new Map<string, string>();
    let selectedRow: number | undefined;
    const selectedSuffix = selectedId ? `/${encodeURIComponent(selectedId)}` : undefined;
    for (let y = 0; y < linkedLines.length; y += 1) {
      const line = linkedLines[y] ?? "";
      for (let x = 0; x < width; x += 1) {
        const url = getOsc8LinkAtColumn(line, x);
        if (url) {
          hitTargets.set(`${y}:${x}`, url);
          const id = decodeURIComponent(new URL(url).pathname.slice(1));
          if (!this.#itemRows.has(id)) this.#itemRows.set(id, y);
          if (selectedSuffix && url.endsWith(selectedSuffix)) selectedRow ??= y;
        }
      }
    }
    this.#hitTargets = hitTargets;
    this.#renderWidth = width;
    this.#selectedRow = selectedRow;
    return linkedLines.map(stripOsc8Links);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (
      event.type !== "click" ||
      event.button !== "left" ||
      !this.#activateUrl
    ) {
      return undefined;
    }
    if (this.#renderWidth !== event.width) this.render(event.width);
    const url = this.#hitTargets.get(`${event.y}:${event.x}`);
    if (!url) return undefined;
    this.#activateUrl(url);
    return { handled: true, render: true };
  }
}

/**
 * The pinned region is outside the ScrollView. Only the feed region is a
 * scrollable layout child, so viewport input cannot move CURRENT or the title.
 */
class PositionedScrollView extends ScrollView {
  afterLayout: (() => void) | undefined;
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    this.afterLayout?.();
  }
}

export class ProjectGlancePaneView implements Component {
  readonly pinned: ProjectGlancePinnedRegion;
  readonly feed: ProjectGlanceFeedRegion;
  readonly scrollView: PositionedScrollView;
  #position: { id: string; offset: number } | "selected" | undefined;
  readonly root: VStack;

  constructor(model: ProjectGlancePaneModel, activateUrl?: (url: string) => void) {
    this.pinned = new ProjectGlancePinnedRegion(model);
    this.feed = new ProjectGlanceFeedRegion(model, activateUrl);
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
    this.root = new VStack([
      { component: this.pinned, shrink: 0 },
      { component: this.scrollView, grow: 1, shrink: 1, minSize: 0 },
    ]);
  }

  invalidate(): void {
    this.root.invalidate();
  }

  render(width: number): string[] {
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
  const view = new ProjectGlancePaneView(model, activate);
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
