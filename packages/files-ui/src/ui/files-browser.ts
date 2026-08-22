import {
  INSERT_PER_FILE_MAX_BYTES,
  INSERT_TOTAL_MAX_BYTES,
  REFRESH_INTERVAL_MS,
  TAB_WIDTH,
} from "../constants.ts";
import type { RepositoryTree } from "../filesystem.ts";
import {
  formatLengthDelimitedFiles,
  formatSelectedPaths,
  InsertBudgetModel,
  prepareInsertBudget,
} from "../insertion.ts";
import { deterministicNameCompare, formatApproximateTokens, formatByteCount } from "../path-utils.ts";
import { expandTabs, type PreviewService } from "../preview.ts";
import type {
  BrowserFocusTarget,
  BrowserLayout,
  BrowserMouseEvent,
  BrowserPane,
  BrowserSessionState,
  InsertCandidate,
  MouseHandlingResult,
  PreviewResult,
  Rect,
  TreeNode,
  VisibleTreeRow,
} from "../types.ts";
import { computeBrowserLayout, pointInRect } from "./layout.ts";
import { decodeBrowserKey, isPrintableInput } from "./key.ts";
import { attachFirstClassMouse, normalizeMouseEvent, parseSgrMouse, type MouseAttachment } from "./mouse.ts";
import { alignRight, cellWidth, padToCells, sanitizeTerminalText, truncateToCells } from "./text.ts";

const REVERSE = "\u001b[7m";
const REVERSE_OFF = "\u001b[27m";
const DIM = "\u001b[2m";
const DIM_OFF = "\u001b[22m";
const BOLD = "\u001b[1m";
const BOLD_OFF = "\u001b[22m";
const WHEEL_LINES = 3;

export interface BrowserTuiLike {
  readonly mode?: string;
  terminal: {
    rows: number;
    columns: number;
  };
  requestRender(force?: boolean): void;
  addMouseListener?: (listener: (event: unknown) => unknown) => unknown;
  registerMouseHandler?: (listener: (event: unknown) => unknown) => unknown;
  onMouse?: (listener: (event: unknown) => unknown) => unknown;
}

export interface BrowserUiLike {
  pasteToEditor(text: string): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface FilesBrowserOptions {
  tree: RepositoryTree;
  preview: PreviewService;
  tui: BrowserTuiLike;
  ui: BrowserUiLike;
  done: () => void;
  state?: BrowserSessionState;
  refreshIntervalMs?: number;
  onDispose?: (() => void) | undefined;
}

interface PressTarget {
  kind: "action" | "tab" | "hidden" | "budget-action";
  id: string;
  rect: Rect;
  originX: number;
  originY: number;
  cancelled: boolean;
}

interface TreeHitRow {
  rowIndex: number;
  y: number;
  rowRect: Rect;
  checkboxRect?: Rect | undefined;
  caretRect?: Rect | undefined;
}

interface BudgetDialogState {
  loading: boolean;
  error?: string | undefined;
  model?: InsertBudgetModel | undefined;
  focus: "list" | "insert" | "cancel";
  focusIndex: number;
  scroll: number;
  manuallyExcluded: Set<string>;
  rect?: Rect | undefined;
  candidateRows: Array<{ index: number; rect: Rect }>;
  buttons: Array<{ id: "insert" | "cancel"; rect: Rect }>;
}

function styleFocused(value: string, focused: boolean): string {
  return focused ? `${REVERSE}${value}${REVERSE_OFF}` : value;
}

function styleDim(value: string): string {
  return `${DIM}${value}${DIM_OFF}`;
}

function asNodeRow(row: VisibleTreeRow | undefined): row is VisibleTreeRow & { node: TreeNode } {
  return row?.kind === "node" && row.node !== undefined;
}

function selectableFile(node: TreeNode): boolean {
  return node.kind === "file" || (node.kind === "symlink" && node.symlinkTargetKind === "file" && node.symlinkWithinRoot === true);
}

function nodeCanExpand(node: TreeNode): boolean {
  return node.kind === "directory" || node.kind === "root";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function reasonLabel(candidate: InsertCandidate, manuallyExcluded: boolean): string {
  if (manuallyExcluded) return "not selected";
  switch (candidate.reason) {
    case "binary":
      return candidate.binaryKind ? `binary (${candidate.binaryKind})` : "binary";
    case "outside-root":
      return "outside root";
    case "not-file":
      return "not a file";
    case "invalid-utf8":
      return "invalid UTF-8";
    case "per-file-limit":
      return "over per-file limit";
    case "total-limit":
      return "over total limit";
    case "missing":
      return "missing";
    case "read-error":
      return candidate.error ? `read error: ${sanitizeTerminalText(candidate.error)}` : "read error";
    default:
      return candidate.included ? "included" : candidate.eligible ? "available" : "excluded";
  }
}

export class FilesBrowserComponent {
  readonly tree: RepositoryTree;
  readonly previewService: PreviewService;
  readonly tui: BrowserTuiLike;
  readonly ui: BrowserUiLike;
  readonly sessionState: BrowserSessionState;
  focused = true;

  private readonly done: () => void;
  private readonly onDispose: (() => void) | undefined;
  private readonly refreshIntervalMs: number;
  private rows: VisibleTreeRow[] = [];
  private searchNodes: TreeNode[] | undefined;
  private searchTruncated = false;
  private searchLoading = false;
  private searchAbort: AbortController | undefined;
  private searchGeneration = 0;
  private focusedRowIndex = -1;
  private rangeAnchorIndex: number | undefined;
  private rangeBaseSelection: Set<string> | undefined;
  private treeScroll = 0;
  private previewScroll = 0;
  private focusTarget: BrowserFocusTarget = "tree";
  private activeNarrowPane: BrowserPane = "tree";
  private filterMode = false;
  private filterQuery = "";
  private previewPath: string | undefined;
  private previewResult: PreviewResult | undefined;
  private previewLoading = false;
  private layout = computeBrowserLayout(80, 24);
  private treeHitRows: TreeHitRow[] = [];
  private hiddenToggleRect: Rect | undefined;
  private tabRects: Array<{ pane: BrowserPane; rect: Rect }> = [];
  private pressed: PressTarget | undefined;
  private budget: BudgetDialogState | undefined;
  private mouseAttachment: MouseAttachment;
  private refreshTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private closed = false;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(options: FilesBrowserOptions) {
    this.tree = options.tree;
    this.previewService = options.preview;
    this.tui = options.tui;
    this.ui = options.ui;
    this.done = options.done;
    this.onDispose = options.onDispose;
    this.refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
    this.sessionState =
      options.state ??
      ({
        selectedPaths: new Set<string>(),
        showHidden: false,
        expandedPaths: new Set<string>(),
      } satisfies BrowserSessionState);
    this.rebuildRows();
    this.mouseAttachment = attachFirstClassMouse(this.tui, (event) => this.handleMouse(event));
    this.scheduleRefresh();
    this.enqueue(() => this.restoreSessionState());
  }

  get mouseAvailable(): boolean {
    return this.mouseAttachment.available;
  }

  get currentRows(): readonly VisibleTreeRow[] {
    return this.rows;
  }

  get currentFocusedRowIndex(): number {
    return this.focusedRowIndex;
  }

  get currentFocusTarget(): BrowserFocusTarget {
    return this.focusTarget;
  }

  get currentTreeScroll(): number {
    return this.treeScroll;
  }

  get currentPreviewScroll(): number {
    return this.previewScroll;
  }

  get currentFilter(): string {
    return this.filterQuery;
  }

  get currentPreview(): PreviewResult | undefined {
    return this.previewResult;
  }

  get currentLayout(): BrowserLayout {
    return this.layout;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get isBudgetOpen(): boolean {
    return this.budget !== undefined;
  }

  private requestRender(): void {
    if (!this.disposed) this.tui.requestRender();
  }

  private enqueue(operation: () => Promise<void>): void {
    this.operationChain = this.operationChain
      .then(operation)
      .catch((error: unknown) => {
        if (!this.disposed) this.ui.notify(sanitizeTerminalText(error instanceof Error ? error.message : String(error)), "error");
      })
      .finally(() => this.requestRender());
  }

  async settle(): Promise<void> {
    await this.operationChain;
  }

  private async restoreSessionState(): Promise<void> {
    const pathsToLoad = new Set([...this.sessionState.expandedPaths, ...this.sessionState.selectedPaths]);
    const ordered = [...pathsToLoad].sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth !== 0 ? depth : deterministicNameCompare(left, right);
    });
    for (const pathValue of ordered) {
      if (this.disposed) return;
      try {
        await this.tree.ensureNode(pathValue);
      } catch {
        if (this.disposed) return;
        this.sessionState.selectedPaths.delete(pathValue);
        this.sessionState.expandedPaths.delete(pathValue);
      }
    }
    for (const pathValue of [...this.sessionState.expandedPaths].sort(deterministicNameCompare)) {
      const node = this.tree.findNode(pathValue);
      if (node && nodeCanExpand(node)) await this.tree.expand(pathValue);
    }
    const refreshed = await this.tree.refreshSelected(this.sessionState.selectedPaths);
    if (this.disposed) return;
    if (refreshed.removed.length > 0) {
      this.ui.notify(`Removed ${refreshed.removed.length} stale selection${refreshed.removed.length === 1 ? "" : "s"}`, "warning");
    }
    this.rebuildRows();
    this.requestRender();
  }

  private scheduleRefresh(): void {
    if (this.refreshIntervalMs <= 0 || this.disposed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.enqueue(async () => {
        try {
          await this.refreshNow();
        } finally {
          this.scheduleRefresh();
        }
      });
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  async refreshNow(): Promise<void> {
    if (this.disposed) return;
    const result = await this.tree.refreshSelected(this.sessionState.selectedPaths);
    if (this.disposed) return;
    if (result.removed.length > 0) {
      this.ui.notify(
        `Removed deleted selection${result.removed.length === 1 ? "" : "s"}: ${result.removed.map(sanitizeTerminalText).join(", ")}`,
        "warning",
      );
    }
    await this.tree.refreshBounded();
    if (this.disposed) return;
    if (this.previewPath) {
      const refreshedPreview = await this.previewService.load(this.previewPath);
      if (this.disposed) return;
      this.previewResult = refreshedPreview;
      if (refreshedPreview.error && result.removed.includes(this.previewPath)) this.previewPath = undefined;
    }
    this.rebuildRows(this.previewPath);
  }

  private firstNodeIndex(start = 0, direction: 1 | -1 = 1): number {
    for (let index = start; index >= 0 && index < this.rows.length; index += direction) {
      if (asNodeRow(this.rows[index])) return index;
    }
    return -1;
  }

  private focusedNode(): TreeNode | undefined {
    const row = this.rows[this.focusedRowIndex];
    return asNodeRow(row) ? row.node : undefined;
  }

  private rebuildRows(preferredPath?: string): void {
    if (this.disposed) {
      this.rows = [];
      this.focusedRowIndex = -1;
      return;
    }
    const previousPath = preferredPath ?? this.focusedNode()?.relativePath;
    this.rows = this.tree.visibleRows({
      showHidden: this.sessionState.showHidden,
      selectedPaths: this.sessionState.selectedPaths,
      filter: this.filterQuery,
      searchNodes: this.searchNodes,
      searchTruncated: this.searchTruncated,
    });
    let nextIndex = previousPath
      ? this.rows.findIndex((row) => asNodeRow(row) && row.node.relativePath === previousPath)
      : -1;
    if (nextIndex < 0 && this.focusedRowIndex >= 0) {
      nextIndex = this.firstNodeIndex(Math.min(this.focusedRowIndex, this.rows.length - 1), -1);
    }
    if (nextIndex < 0) nextIndex = this.firstNodeIndex();
    this.focusedRowIndex = nextIndex;
    this.clampTreeScroll();
  }

  private visibleTreeBodyHeight(): number {
    const pane = this.layout.narrow ? this.layout.singlePane : this.layout.tree;
    return Math.max(1, (pane?.height ?? 1) - 1);
  }

  private visiblePreviewBodyHeight(): number {
    const pane = this.layout.narrow ? this.layout.singlePane : this.layout.preview;
    return Math.max(1, (pane?.height ?? 1) - 1);
  }

  private clampTreeScroll(): void {
    const bodyHeight = this.visibleTreeBodyHeight();
    const maximum = Math.max(0, this.rows.length - bodyHeight);
    this.treeScroll = clamp(this.treeScroll, 0, maximum);
    if (this.focusedRowIndex >= 0) {
      if (this.focusedRowIndex < this.treeScroll) this.treeScroll = this.focusedRowIndex;
      if (this.focusedRowIndex >= this.treeScroll + bodyHeight) this.treeScroll = this.focusedRowIndex - bodyHeight + 1;
    }
  }

  private previewLineCount(): number {
    if (!this.previewResult || this.previewResult.error || this.previewResult.metadata.binary) return 0;
    return this.previewResult.lines.length;
  }

  private clampPreviewScroll(): void {
    const maximum = Math.max(0, this.previewLineCount() - this.visiblePreviewBodyHeight());
    this.previewScroll = clamp(this.previewScroll, 0, maximum);
  }

  private async focusRow(index: number, preview = true, switchToPreviewPane = false): Promise<void> {
    if (!asNodeRow(this.rows[index])) return;
    this.focusedRowIndex = index;
    this.focusTarget = "tree";
    this.activeNarrowPane = "tree";
    this.clampTreeScroll();
    const node = this.rows[index]?.node;
    if (preview && node && selectableFile(node)) {
      await this.loadPreview(node.relativePath);
      if (!this.disposed && switchToPreviewPane && this.layout.narrow) {
        this.activeNarrowPane = "preview";
        this.focusTarget = "preview";
      }
    }
  }

  private async loadPreview(relativePath: string, force = false): Promise<void> {
    if (this.disposed) return;
    this.previewPath = relativePath;
    this.previewLoading = true;
    this.previewScroll = 0;
    this.requestRender();
    const result = await this.previewService.load(relativePath, force);
    if (this.disposed || this.previewPath !== relativePath) return;
    this.previewResult = result;
    this.previewLoading = false;
    this.clampPreviewScroll();
  }

  private async moveRow(delta: -1 | 1, extendSelection: boolean): Promise<void> {
    if (this.focusedRowIndex < 0) return;
    const nextIndex = this.firstNodeIndex(this.focusedRowIndex + delta, delta);
    if (nextIndex < 0) return;
    if (extendSelection) {
      if (this.rangeAnchorIndex === undefined) {
        this.rangeAnchorIndex = this.focusedRowIndex;
        this.rangeBaseSelection = new Set(this.sessionState.selectedPaths);
      }
      await this.applyRangeSelection(this.rangeAnchorIndex, nextIndex);
    } else {
      this.rangeAnchorIndex = undefined;
      this.rangeBaseSelection = undefined;
    }
    await this.focusRow(nextIndex);
  }

  private async selectionPathsForNode(node: TreeNode): Promise<string[]> {
    if (selectableFile(node)) return [node.relativePath];
    if (!nodeCanExpand(node)) return [];
    const files = await this.tree.collectFiles(node.relativePath);
    if (this.sessionState.showHidden) return files;
    return files.filter((filePath) => this.tree.findNode(filePath)?.hidden !== true);
  }

  private async applyRangeSelection(anchorIndex: number, targetIndex: number): Promise<void> {
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const base = new Set(this.rangeBaseSelection ?? this.sessionState.selectedPaths);
    for (let index = start; index <= end; index += 1) {
      const row = this.rows[index];
      if (!asNodeRow(row)) continue;
      for (const pathValue of await this.selectionPathsForNode(row.node)) base.add(pathValue);
      if (this.disposed) return;
    }
    if (this.disposed) return;
    this.sessionState.selectedPaths.clear();
    for (const pathValue of base) this.sessionState.selectedPaths.add(pathValue);
    await this.tree.refreshSelected(this.sessionState.selectedPaths);
    if (this.disposed) return;
    this.rebuildRows(this.rows[targetIndex]?.node?.relativePath);
  }

  async toggleSelectionAt(index: number, desired?: boolean): Promise<void> {
    const row = this.rows[index];
    if (!asNodeRow(row)) return;
    const paths = await this.selectionPathsForNode(row.node);
    if (this.disposed) return;
    if (paths.length === 0) {
      if (row.node.kind === "symlink" && row.node.symlinkWithinRoot === false) {
        this.ui.notify(`Cannot select outside-root symlink: ${sanitizeTerminalText(row.node.relativePath)}`, "warning");
      }
      return;
    }
    const allSelected = paths.every((pathValue) => this.sessionState.selectedPaths.has(pathValue));
    const include = desired ?? !allSelected;
    for (const pathValue of paths) {
      if (include) this.sessionState.selectedPaths.add(pathValue);
      else this.sessionState.selectedPaths.delete(pathValue);
    }
    this.rangeAnchorIndex = index;
    this.rangeBaseSelection = new Set(this.sessionState.selectedPaths);
    await this.tree.refreshSelected(this.sessionState.selectedPaths);
    if (this.disposed) return;
    this.rebuildRows(row.node.relativePath);
  }

  private async toggleDirectory(node: TreeNode): Promise<void> {
    if (!nodeCanExpand(node)) return;
    if (node.expanded) {
      this.tree.collapse(node.relativePath);
      this.sessionState.expandedPaths.delete(node.relativePath);
    } else {
      await this.tree.expand(node.relativePath);
      if (this.disposed) return;
      this.sessionState.expandedPaths.add(node.relativePath);
    }
    this.rebuildRows(node.relativePath);
  }

  private async goLeft(): Promise<void> {
    const node = this.focusedNode();
    if (!node) return;
    if (nodeCanExpand(node) && node.expanded) {
      await this.toggleDirectory(node);
      return;
    }
    if (node.parentPath === null || node.parentPath === "") return;
    const parentIndex = this.rows.findIndex((row) => asNodeRow(row) && row.node.relativePath === node.parentPath);
    if (parentIndex >= 0) await this.focusRow(parentIndex, false);
  }

  private async goRight(): Promise<void> {
    const node = this.focusedNode();
    if (!node || !nodeCanExpand(node)) return;
    if (!node.expanded) {
      await this.toggleDirectory(node);
      return;
    }
    const childIndex = this.firstNodeIndex(this.focusedRowIndex + 1, 1);
    const child = this.rows[childIndex]?.node;
    if (child && child.parentPath === node.relativePath) await this.focusRow(childIndex);
  }

  private async enterFocused(): Promise<void> {
    const node = this.focusedNode();
    if (!node) return;
    if (nodeCanExpand(node)) await this.toggleDirectory(node);
    else if (selectableFile(node)) {
      await this.loadPreview(node.relativePath, false);
      if (!this.disposed && this.layout.narrow) {
        this.activeNarrowPane = "preview";
        this.focusTarget = "preview";
      }
    }
  }

  private cycleFocus(direction: 1 | -1): void {
    const targets: BrowserFocusTarget[] = ["tree", "preview", "insert-paths", "insert-contents", "clear", "close"];
    const current = targets.indexOf(this.focusTarget);
    const next = (current + direction + targets.length) % targets.length;
    const target = targets[next] ?? "tree";
    this.focusTarget = target;
    if (target === "tree" || target === "preview") this.activeNarrowPane = target;
  }

  private scrollFocusedPage(direction: -1 | 1): void {
    if (this.focusTarget === "preview") {
      this.previewScroll += direction * Math.max(1, this.visiblePreviewBodyHeight() - 1);
      this.clampPreviewScroll();
    } else {
      this.treeScroll += direction * Math.max(1, this.visibleTreeBodyHeight() - 1);
      this.treeScroll = clamp(this.treeScroll, 0, Math.max(0, this.rows.length - this.visibleTreeBodyHeight()));
    }
  }

  private clearSelection(): void {
    this.sessionState.selectedPaths.clear();
    this.rangeAnchorIndex = undefined;
    this.rangeBaseSelection = undefined;
    this.rebuildRows();
    this.ui.notify("File selection cleared", "info");
  }

  private toggleHidden(): void {
    this.sessionState.showHidden = !this.sessionState.showHidden;
    if (this.filterQuery !== "") this.startSearch();
    else this.rebuildRows();
  }

  private startSearch(): void {
    this.searchAbort?.abort();
    this.searchNodes = undefined;
    this.searchTruncated = false;
    const query = this.filterQuery;
    if (query.trim() === "") {
      this.searchLoading = false;
      this.rebuildRows();
      return;
    }
    this.searchLoading = true;
    this.rebuildRows();
    const controller = new AbortController();
    this.searchAbort = controller;
    const generation = ++this.searchGeneration;
    this.enqueue(async () => {
      try {
        const result = await this.tree.search(query, this.sessionState.showHidden, controller.signal);
        if (this.disposed || controller.signal.aborted || generation !== this.searchGeneration || this.filterQuery !== query) return;
        this.searchNodes = result.rows.flatMap((row) => (asNodeRow(row) ? [row.node] : []));
        this.searchTruncated = result.truncated;
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        if (generation === this.searchGeneration) this.searchLoading = false;
        if (!this.disposed) this.rebuildRows();
      }
    });
  }

  private clearFilter(): void {
    this.searchAbort?.abort();
    this.searchAbort = undefined;
    this.searchGeneration += 1;
    this.searchNodes = undefined;
    this.searchTruncated = false;
    this.searchLoading = false;
    this.filterQuery = "";
    this.filterMode = false;
    this.rebuildRows();
  }

  private async validateSelection(): Promise<string[]> {
    const refreshed = await this.tree.refreshSelected(this.sessionState.selectedPaths);
    if (this.disposed) return [];
    if (refreshed.removed.length > 0) {
      this.ui.notify(`Skipped deleted file${refreshed.removed.length === 1 ? "" : "s"}: ${refreshed.removed.map(sanitizeTerminalText).join(", ")}`, "warning");
    }
    return [...this.sessionState.selectedPaths].sort(deterministicNameCompare);
  }

  private async insertPaths(): Promise<void> {
    const paths = await this.validateSelection();
    if (this.disposed) return;
    if (paths.length === 0) {
      this.ui.notify("Select at least one file", "warning");
      return;
    }
    this.ui.pasteToEditor(formatSelectedPaths(paths));
    this.close();
  }

  private async openBudget(): Promise<void> {
    const paths = await this.validateSelection();
    if (this.disposed) return;
    if (paths.length === 0) {
      this.ui.notify("Select at least one file", "warning");
      return;
    }
    this.budget = {
      loading: true,
      focus: "list",
      focusIndex: 0,
      scroll: 0,
      manuallyExcluded: new Set(),
      candidateRows: [],
      buttons: [],
    };
    this.requestRender();
    try {
      const prepared = await prepareInsertBudget(this.tree, paths, {
        perFileMaxBytes: INSERT_PER_FILE_MAX_BYTES,
        totalMaxBytes: INSERT_TOTAL_MAX_BYTES,
      });
      if (!this.budget || this.disposed) return;
      this.budget.loading = false;
      this.budget.model = new InsertBudgetModel(prepared);
      const firstEligible = prepared.candidates.findIndex((candidate) => candidate.eligible);
      this.budget.focusIndex = firstEligible >= 0 ? firstEligible : 0;
    } catch (error) {
      if (!this.budget || this.disposed) return;
      this.budget.loading = false;
      this.budget.error = error instanceof Error ? error.message : String(error);
    }
  }

  private toggleBudgetCandidate(index: number): void {
    const budget = this.budget;
    const candidate = budget?.model?.budget.candidates[index];
    if (!budget || !candidate?.eligible) return;
    const wasIncluded = candidate.included;
    const changed = budget.model?.toggle(candidate.path) ?? false;
    if (!changed && !wasIncluded) {
      this.ui.notify(`Total content limit prevents including ${sanitizeTerminalText(candidate.path)}`, "warning");
      return;
    }
    if (wasIncluded) budget.manuallyExcluded.add(candidate.path);
    else budget.manuallyExcluded.delete(candidate.path);
  }

  private insertBudgetContents(): void {
    const budget = this.budget;
    const candidates = budget?.model?.includedCandidates() ?? [];
    if (candidates.length === 0) {
      this.ui.notify("No insertable files are included", "warning");
      return;
    }
    this.ui.pasteToEditor(formatLengthDelimitedFiles(candidates));
    this.close();
  }

  private handleBudgetInput(data: string): void {
    const budget = this.budget;
    if (!budget) return;
    const key = decodeBrowserKey(data);
    if (key === "escape") {
      this.budget = undefined;
      this.pressed = undefined;
      return;
    }
    if (budget.loading) return;
    const candidates = budget.model?.budget.candidates ?? [];
    if (key === "tab" || key === "shift-tab") {
      const targets: BudgetDialogState["focus"][] = ["list", "insert", "cancel"];
      const direction = key === "tab" ? 1 : -1;
      budget.focus = targets[(targets.indexOf(budget.focus) + direction + targets.length) % targets.length] ?? "list";
      return;
    }
    if (key === "up" || key === "down") {
      if (budget.focus !== "list") {
        budget.focus = "list";
        return;
      }
      const direction = key === "up" ? -1 : 1;
      budget.focusIndex = clamp(budget.focusIndex + direction, 0, Math.max(0, candidates.length - 1));
      this.clampBudgetScroll();
      return;
    }
    if (key === "page-up" || key === "page-down") {
      const direction = key === "page-up" ? -1 : 1;
      budget.focus = "list";
      budget.focusIndex = clamp(budget.focusIndex + direction * Math.max(1, this.budgetListHeight() - 1), 0, Math.max(0, candidates.length - 1));
      this.clampBudgetScroll();
      return;
    }
    if (key === "space" && budget.focus === "list") {
      this.toggleBudgetCandidate(budget.focusIndex);
      return;
    }
    if (key === "enter") {
      if (budget.focus === "list") this.toggleBudgetCandidate(budget.focusIndex);
      else if (budget.focus === "insert") this.insertBudgetContents();
      else this.budget = undefined;
    }
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const mouse = parseSgrMouse(data);
    if (mouse) {
      this.handleMouse(mouse);
      return;
    }
    if (this.budget) {
      this.handleBudgetInput(data);
      this.requestRender();
      return;
    }

    const key = decodeBrowserKey(data);
    if (this.filterMode) {
      if (key === "escape") {
        this.clearFilter();
      } else if (key === "enter") {
        this.filterMode = false;
      } else if (key === "backspace") {
        const characters = [...this.filterQuery];
        characters.pop();
        this.filterQuery = characters.join("");
        this.startSearch();
      } else if (isPrintableInput(data)) {
        this.filterQuery += data;
        this.startSearch();
      }
      this.requestRender();
      return;
    }

    if (key === "escape") {
      if (this.filterQuery !== "") this.clearFilter();
      else this.close();
      return;
    }
    if (key === "slash") {
      this.filterMode = true;
      this.focusTarget = "tree";
      this.activeNarrowPane = "tree";
      this.requestRender();
      return;
    }
    if ((data === "h" || data === "H") && this.focusTarget === "tree") {
      this.toggleHidden();
      this.requestRender();
      return;
    }
    if (key === "tab" || key === "shift-tab") {
      this.cycleFocus(key === "tab" ? 1 : -1);
      this.requestRender();
      return;
    }
    if (key === "page-up" || key === "page-down") {
      this.scrollFocusedPage(key === "page-up" ? -1 : 1);
      this.requestRender();
      return;
    }

    if (this.focusTarget === "tree") {
      if (key === "up" || key === "down" || key === "shift-up" || key === "shift-down") {
        const direction = key === "up" || key === "shift-up" ? -1 : 1;
        const extend = key === "shift-up" || key === "shift-down";
        this.enqueue(() => this.moveRow(direction, extend));
      } else if (key === "left") {
        this.enqueue(() => this.goLeft());
      } else if (key === "right") {
        this.enqueue(() => this.goRight());
      } else if (key === "space") {
        this.enqueue(() => this.toggleSelectionAt(this.focusedRowIndex));
      } else if (key === "enter") {
        this.enqueue(() => this.enterFocused());
      } else if (key === "home") {
        const first = this.firstNodeIndex();
        if (first >= 0) this.enqueue(() => this.focusRow(first));
      } else if (key === "end") {
        const last = this.firstNodeIndex(this.rows.length - 1, -1);
        if (last >= 0) this.enqueue(() => this.focusRow(last));
      }
    } else if (this.focusTarget === "preview") {
      if (key === "up" || key === "down") {
        this.previewScroll += key === "up" ? -1 : 1;
        this.clampPreviewScroll();
      } else if (key === "left") {
        this.focusTarget = "tree";
        this.activeNarrowPane = "tree";
      } else if (key === "enter" && this.previewPath) {
        this.enqueue(() => this.loadPreview(this.previewPath ?? "", true));
      }
    } else if (key === "enter" || key === "space") {
      this.activateAction(this.focusTarget);
    }
    this.requestRender();
  }

  private activateAction(target: BrowserFocusTarget): void {
    if (target === "insert-paths") this.enqueue(() => this.insertPaths());
    else if (target === "insert-contents") this.enqueue(() => this.openBudget());
    else if (target === "clear") this.clearSelection();
    else if (target === "close") this.close();
  }

  private selectionSummary(): { count: number; approximateTokens: number } {
    let bytes = 0;
    for (const selectedPath of this.sessionState.selectedPaths) bytes += this.tree.findNode(selectedPath)?.identity?.size ?? 0;
    return { count: this.sessionState.selectedPaths.size, approximateTokens: Math.ceil(bytes / 4) };
  }

  private renderHeader(width: number): string {
    const summary = this.selectionSummary();
    const right = `${summary.count} selected · ${formatApproximateTokens(summary.approximateTokens)} tokens`;
    return `${BOLD}${alignRight("Files", right, width)}${BOLD_OFF}`;
  }

  private renderTreeStatus(width: number, x: number, y: number): string {
    const hidden = `[Hidden: ${this.sessionState.showHidden ? "on" : "off"}]`;
    this.hiddenToggleRect = { x, y, width: cellWidth(hidden), height: 1 };
    const filter = this.filterMode
      ? ` Filter: ${sanitizeTerminalText(this.filterQuery)}▏`
      : this.filterQuery
        ? ` Filter: ${sanitizeTerminalText(this.filterQuery)}${this.searchLoading ? " …" : ""}`
        : this.mouseAvailable
          ? " / filter · H hidden"
          : " / filter · H hidden · keyboard mode";
    return padToCells(`${hidden}${filter}`, width);
  }

  private renderTreeRow(row: VisibleTreeRow, width: number, rowIndex: number, x: number, y: number): string {
    if (row.kind === "section") return styleDim(padToCells(`— ${sanitizeTerminalText(row.label ?? "")} —`, width));
    if (row.kind === "warning") return styleDim(padToCells(`${"  ".repeat(row.depth)}⚠ ${sanitizeTerminalText(row.label ?? "")}`, width));
    const node = row.node;
    if (!node) return " ".repeat(width);
    const indent = "  ".repeat(row.depth);
    const caret = nodeCanExpand(node) ? (node.loading ? "…" : node.expanded ? "▾" : "▸") : node.kind === "symlink" ? "↗" : " ";
    const checkbox = row.selected ? "☑" : row.partiallySelected ? "◩" : "☐";
    const suffixParts: string[] = [];
    if (node.kind === "symlink") {
      suffixParts.push(`→ ${sanitizeTerminalText(node.symlinkTarget ?? "?")}`);
      if (node.symlinkWithinRoot === false) suffixParts.push("[outside root]");
    }
    if (node.error) suffixParts.push(`! ${sanitizeTerminalText(node.error)}`);
    const suffix = suffixParts.length > 0 ? `  ${suffixParts.join(" ")}` : "";
    const plain = `${indent}${caret} ${checkbox} ${sanitizeTerminalText(node.name)}${suffix}`;
    const focused = this.focusTarget === "tree" && rowIndex === this.focusedRowIndex;
    const rendered = styleFocused(padToCells(plain, width), focused);
    const indentWidth = cellWidth(indent);
    this.treeHitRows.push({
      rowIndex,
      y,
      rowRect: { x, y, width, height: 1 },
      caretRect: nodeCanExpand(node) ? { x: x + indentWidth, y, width: 1, height: 1 } : undefined,
      checkboxRect: { x: x + indentWidth + 2, y, width: 1, height: 1 },
    });
    return rendered;
  }

  private renderTreePane(rect: Rect): string[] {
    const lines: string[] = [this.renderTreeStatus(rect.width, rect.x, rect.y)];
    const bodyHeight = Math.max(0, rect.height - 1);
    for (let offset = 0; offset < bodyHeight; offset += 1) {
      const rowIndex = this.treeScroll + offset;
      const row = this.rows[rowIndex];
      lines.push(row ? this.renderTreeRow(row, rect.width, rowIndex, rect.x, rect.y + 1 + offset) : " ".repeat(rect.width));
    }
    return lines;
  }

  private previewStatus(width: number): string {
    if (!this.previewPath) return padToCells("Preview", width);
    const metadata = this.previewResult?.metadata;
    const flags: string[] = [];
    if (metadata?.changed) flags.push("file changed");
    if (metadata?.binary) flags.push(metadata.binaryKind ? `binary: ${metadata.binaryKind}` : "binary");
    else if (metadata) flags.push(metadata.invalidUtf8 ? "UTF-8 assumed; invalid bytes replaced" : "UTF-8 assumed");
    if (metadata?.truncated) flags.push(`truncated${metadata.truncatedBy ? ` by ${metadata.truncatedBy}` : ""}`);
    return alignRight(sanitizeTerminalText(this.previewPath), flags.join(" · "), width);
  }

  private renderPreviewPane(rect: Rect): string[] {
    const lines = [this.previewStatus(rect.width)];
    const bodyHeight = Math.max(0, rect.height - 1);
    if (this.previewLoading) {
      lines.push(padToCells("Loading preview…", rect.width));
    } else if (!this.previewPath) {
      lines.push(padToCells("Select a text file to preview it.", rect.width));
    } else if (this.previewResult?.error) {
      lines.push(padToCells(`Error: ${sanitizeTerminalText(this.previewResult.error)}`, rect.width));
    } else if (this.previewResult?.metadata.binary) {
      const metadata = this.previewResult.metadata;
      lines.push(padToCells("Binary content is not rendered or executed.", rect.width));
      lines.push(padToCells(`Type: ${metadata.binaryKind ?? "unknown binary"}`, rect.width));
      lines.push(padToCells(`Size: ${formatByteCount(metadata.size)}`, rect.width));
      lines.push(padToCells(`Modified: ${new Date(metadata.mtimeMs).toISOString()}`, rect.width));
    } else if (this.previewResult) {
      const numberWidth = Math.max(1, String(Math.max(1, this.previewResult.metadata.displayedLines)).length);
      for (let offset = 0; offset < bodyHeight; offset += 1) {
        const lineIndex = this.previewScroll + offset;
        const content = this.previewResult.lines[lineIndex];
        if (content === undefined) break;
        const number = String(lineIndex + 1).padStart(numberWidth, " ");
        const expanded = sanitizeTerminalText(expandTabs(content, TAB_WIDTH));
        lines.push(padToCells(`${styleDim(number)} ${expanded}`, rect.width));
      }
    }
    while (lines.length < rect.height) lines.push(" ".repeat(rect.width));
    return lines.slice(0, rect.height).map((line) => padToCells(line, rect.width));
  }

  private renderActions(width: number): string {
    let output = "";
    let cursor = 0;
    for (const button of this.layout.actionButtons) {
      if (button.rect.x > cursor) output += " ".repeat(button.rect.x - cursor);
      const label = `[${button.label}]`;
      const active = this.focusTarget === button.id;
      const pressed = this.pressed?.kind === "action" && this.pressed.id === button.id && !this.pressed.cancelled;
      output += styleFocused(label, active || pressed);
      cursor = button.rect.x + button.rect.width;
    }
    return padToCells(output, width);
  }

  private renderWide(width: number, height: number): string[] {
    const treeRect = this.layout.tree;
    const previewRect = this.layout.preview;
    if (!treeRect || !previewRect) return Array.from({ length: height }, () => " ".repeat(width));
    const treeLines = this.renderTreePane(treeRect);
    const previewLines = this.renderPreviewPane(previewRect);
    const top = `┌${truncateToCells("─ Tree " + "─".repeat(treeRect.width), treeRect.width)}┬${truncateToCells("─ Preview " + "─".repeat(previewRect.width), previewRect.width)}┐`;
    const bottom = `└${"─".repeat(treeRect.width)}┴${"─".repeat(previewRect.width)}┘`;
    const lines = [this.renderHeader(width), padToCells(top, width)];
    for (let row = 0; row < treeRect.height; row += 1) {
      lines.push(`│${treeLines[row] ?? " ".repeat(treeRect.width)}│${previewLines[row] ?? " ".repeat(previewRect.width)}│`);
    }
    lines.push(padToCells(bottom, width));
    lines.push(this.renderActions(width));
    return lines.slice(0, height).map((line) => padToCells(line, width));
  }

  private renderTabs(width: number, y: number): string {
    const entries: Array<{ pane: BrowserPane; label: string }> = [
      { pane: "tree", label: "Tree" },
      { pane: "preview", label: "Preview" },
    ];
    let output = "";
    let x = 0;
    this.tabRects = [];
    for (const entry of entries) {
      const label = `[${entry.label}]`;
      const rect = { x, y, width: cellWidth(label), height: 1 };
      this.tabRects.push({ pane: entry.pane, rect });
      output += styleFocused(label, this.activeNarrowPane === entry.pane);
      output += " ";
      x += rect.width + 1;
    }
    return padToCells(output, width);
  }

  private renderNarrow(width: number, height: number): string[] {
    const pane = this.layout.singlePane;
    if (!pane) return Array.from({ length: height }, () => " ".repeat(width));
    const content = this.activeNarrowPane === "tree" ? this.renderTreePane(pane) : this.renderPreviewPane(pane);
    const title = this.activeNarrowPane === "tree" ? "Tree" : "Preview";
    const top = `┌${truncateToCells(`─ ${title} ${"─".repeat(pane.width)}`, pane.width)}┐`;
    const bottom = `└${"─".repeat(pane.width)}┘`;
    const lines = [this.renderHeader(width), this.renderTabs(width, 1), padToCells(top, width)];
    for (let row = 0; row < pane.height; row += 1) lines.push(`│${content[row] ?? " ".repeat(pane.width)}│`);
    lines.push(padToCells(bottom, width));
    lines.push(this.renderActions(width));
    return lines.slice(0, height).map((line) => padToCells(line, width));
  }

  private budgetListHeight(): number {
    const rect = this.budget?.rect;
    return rect ? Math.max(1, rect.height - 7) : 1;
  }

  private clampBudgetScroll(): void {
    const budget = this.budget;
    const count = budget?.model?.budget.candidates.length ?? 0;
    if (!budget) return;
    const height = this.budgetListHeight();
    budget.scroll = clamp(budget.scroll, 0, Math.max(0, count - height));
    if (budget.focusIndex < budget.scroll) budget.scroll = budget.focusIndex;
    if (budget.focusIndex >= budget.scroll + height) budget.scroll = budget.focusIndex - height + 1;
  }

  private renderBudget(base: string[], width: number, height: number): string[] {
    const budget = this.budget;
    if (!budget) return base;
    const dialogWidth = Math.max(4, Math.min(96, Math.max(4, width - 2)));
    const candidateCount = budget.model?.budget.candidates.length ?? 0;
    const dialogHeight = Math.max(6, Math.min(candidateCount + 8, Math.max(6, height - 2)));
    const x = Math.max(0, Math.floor((width - dialogWidth) / 2));
    const y = Math.max(0, Math.floor((height - dialogHeight) / 2));
    const rect = { x, y, width: dialogWidth, height: dialogHeight };
    budget.rect = rect;
    budget.candidateRows = [];
    budget.buttons = [];
    const inner = dialogWidth - 2;
    const content: string[] = [];
    content.push(`┌${truncateToCells("─ Insert contents budget " + "─".repeat(inner), inner)}┐`);
    if (budget.loading) {
      content.push(`│${padToCells("Reading selected files…", inner)}│`);
      while (content.length < dialogHeight - 1) content.push(`│${" ".repeat(inner)}│`);
      content.push(`└${"─".repeat(inner)}┘`);
    } else if (budget.error) {
      content.push(`│${padToCells(`Error: ${sanitizeTerminalText(budget.error)}`, inner)}│`);
      while (content.length < dialogHeight - 2) content.push(`│${" ".repeat(inner)}│`);
      const cancelLabel = "[Cancel]";
      const buttonY = y + content.length;
      content.push(`│${padToCells(styleFocused(cancelLabel, budget.focus === "cancel"), inner)}│`);
      budget.buttons.push({ id: "cancel", rect: { x: x + 1, y: buttonY, width: cellWidth(cancelLabel), height: 1 } });
      content.push(`└${"─".repeat(inner)}┘`);
    } else if (budget.model) {
      const value = budget.model.budget;
      content.push(
        `│${padToCells(
          `Per file ${formatByteCount(value.perFileMaxBytes)} · total ${formatByteCount(value.includedBytes)}/${formatByteCount(value.totalMaxBytes)} · ${formatApproximateTokens(value.approximateTokens)} approximate tokens`,
          inner,
        )}│`,
      );
      content.push(`│${padToCells("Space toggles an eligible file. Binary and oversized files stay excluded.", inner)}│`);
      const listHeight = Math.max(1, dialogHeight - 7);
      this.clampBudgetScroll();
      for (let offset = 0; offset < listHeight; offset += 1) {
        const index = budget.scroll + offset;
        const candidate = value.candidates[index];
        if (!candidate) {
          content.push(`│${" ".repeat(inner)}│`);
          continue;
        }
        const checkbox = candidate.included ? "☑" : candidate.eligible ? "☐" : "×";
        const sizes = candidate.eligible
          ? `${formatByteCount(candidate.bytes)} · ${formatApproximateTokens(candidate.approximateTokens)}`
          : formatByteCount(candidate.bytes);
        const label = `${checkbox} ${sanitizeTerminalText(candidate.path)}  ${sizes}  ${reasonLabel(candidate, budget.manuallyExcluded.has(candidate.path))}`;
        const focused = budget.focus === "list" && budget.focusIndex === index;
        content.push(`│${styleFocused(padToCells(label, inner), focused)}│`);
        budget.candidateRows.push({ index, rect: { x: x + 1, y: y + content.length - 1, width: inner, height: 1 } });
      }
      const footer = `Included ${value.candidates.filter((candidate) => candidate.included).length}/${value.candidates.length}`;
      content.push(`│${padToCells(footer, inner)}│`);
      const insertLabel = "[Insert]";
      const cancelLabel = "[Cancel]";
      const buttonsLine = `${styleFocused(insertLabel, budget.focus === "insert")} ${styleFocused(cancelLabel, budget.focus === "cancel")}`;
      const buttonY = y + content.length;
      content.push(`│${padToCells(buttonsLine, inner)}│`);
      budget.buttons.push({ id: "insert", rect: { x: x + 1, y: buttonY, width: cellWidth(insertLabel), height: 1 } });
      budget.buttons.push({ id: "cancel", rect: { x: x + 2 + cellWidth(insertLabel), y: buttonY, width: cellWidth(cancelLabel), height: 1 } });
      content.push(`└${"─".repeat(inner)}┘`);
    }
    while (content.length < dialogHeight) content.splice(content.length - 1, 0, `│${" ".repeat(inner)}│`);
    const output = [...base];
    for (let row = 0; row < Math.min(dialogHeight, content.length); row += 1) {
      output[y + row] = padToCells(`${" ".repeat(x)}${content[row] ?? ""}`, width);
    }
    return output;
  }

  render(width: number): string[] {
    const height = Math.max(6, this.tui.terminal.rows || 24);
    this.layout = computeBrowserLayout(width, height);
    this.treeHitRows = [];
    this.hiddenToggleRect = undefined;
    this.tabRects = [];
    this.layout.actionButtons = this.layout.actionButtons.map((button) => ({
      ...button,
      rect: { ...button.rect, y: height - 1 },
    }));
    this.clampTreeScroll();
    this.clampPreviewScroll();
    const base = this.layout.narrow ? this.renderNarrow(width, height) : this.renderWide(width, height);
    return this.renderBudget(base, width, height).map((line) => padToCells(line, width));
  }

  invalidate(): void {
    // Rendering is derived from current state; no retained line cache needs clearing.
  }

  private scrollTree(delta: number): void {
    this.treeScroll += delta;
    this.treeScroll = clamp(this.treeScroll, 0, Math.max(0, this.rows.length - this.visibleTreeBodyHeight()));
  }

  private scrollPreview(delta: number): void {
    this.previewScroll += delta;
    this.clampPreviewScroll();
  }

  private pointWithinPress(event: BrowserMouseEvent, press: PressTarget): boolean {
    return pointInRect(event.x, event.y, press.rect);
  }

  private beginPress(kind: PressTarget["kind"], id: string, rect: Rect, event: BrowserMouseEvent): MouseHandlingResult {
    this.pressed = { kind, id, rect, originX: event.x, originY: event.y, cancelled: false };
    this.requestRender();
    return { handled: true };
  }

  private updatePress(event: BrowserMouseEvent): MouseHandlingResult {
    if (!this.pressed) return { handled: false };
    if (!this.pointWithinPress(event, this.pressed) || event.x !== this.pressed.originX || event.y !== this.pressed.originY) {
      this.pressed.cancelled = true;
    }
    this.requestRender();
    return { handled: true };
  }

  private releasePress(event: BrowserMouseEvent): MouseHandlingResult {
    const press = this.pressed;
    this.pressed = undefined;
    if (!press) return { handled: false };
    const activate = !press.cancelled && this.pointWithinPress(event, press);
    if (activate) {
      if (press.kind === "action") this.activateAction(press.id as BrowserFocusTarget);
      else if (press.kind === "tab") {
        this.activeNarrowPane = press.id as BrowserPane;
        this.focusTarget = this.activeNarrowPane;
      } else if (press.kind === "hidden") this.toggleHidden();
      else if (press.kind === "budget-action") {
        if (press.id === "insert") this.insertBudgetContents();
        else this.budget = undefined;
      }
    }
    this.requestRender();
    return { handled: true };
  }

  private handleBudgetMouse(event: BrowserMouseEvent): MouseHandlingResult {
    const budget = this.budget;
    if (!budget) return { handled: false };
    if (event.button === "right") return { handled: false };
    if (event.kind === "wheel") {
      const rect = budget.rect;
      if (!pointInRect(event.x, event.y, rect)) return { handled: true };
      budget.scroll += (event.wheelDelta ?? 0) * WHEEL_LINES;
      this.clampBudgetScroll();
      this.requestRender();
      return { handled: true };
    }
    if (event.kind === "move" && this.pressed) return this.updatePress(event);
    if (event.kind === "release" && this.pressed) return this.releasePress(event);
    if (event.kind !== "press" || event.button !== "left") return { handled: true };
    for (const button of budget.buttons) {
      if (pointInRect(event.x, event.y, button.rect)) return this.beginPress("budget-action", button.id, button.rect, event);
    }
    const candidate = budget.candidateRows.find((entry) => pointInRect(event.x, event.y, entry.rect));
    if (candidate) {
      budget.focus = "list";
      budget.focusIndex = candidate.index;
      this.toggleBudgetCandidate(candidate.index);
      this.requestRender();
    }
    return { handled: true };
  }

  handleMouse(input: BrowserMouseEvent | unknown): MouseHandlingResult {
    const event = normalizeMouseEvent(input);
    if (!event || this.disposed) return { handled: false };
    if (this.budget) return this.handleBudgetMouse(event);
    if (event.button === "right") return { handled: false };

    const previewRect = this.layout.narrow
      ? this.activeNarrowPane === "preview"
        ? this.layout.singlePane
        : undefined
      : this.layout.preview;
    const treeRect = this.layout.narrow
      ? this.activeNarrowPane === "tree"
        ? this.layout.singlePane
        : undefined
      : this.layout.tree;

    if (event.kind === "wheel") {
      const delta = (event.wheelDelta ?? 0) * WHEEL_LINES;
      if (pointInRect(event.x, event.y, treeRect)) {
        this.scrollTree(delta);
        this.requestRender();
        return { handled: true };
      }
      if (pointInRect(event.x, event.y, previewRect)) {
        this.scrollPreview(delta);
        this.requestRender();
        return { handled: true };
      }
      return { handled: false };
    }

    // Finish an existing button/tab press even if the pointer has moved over the
    // preview; otherwise a drag from a button could leave a stale pressed state.
    if (event.kind === "move" && this.pressed) return this.updatePress(event);
    if (event.kind === "release" && this.pressed) return this.releasePress(event);

    // Preview press/move/release is deliberately untouched so Pi's text-selection
    // machinery can own dragging and clipboard behavior.
    if (pointInRect(event.x, event.y, previewRect)) return { handled: false, preserveTextSelection: true };
    if (event.kind !== "press" || event.button !== "left") return { handled: false };

    for (const button of this.layout.actionButtons) {
      if (pointInRect(event.x, event.y, button.rect)) {
        this.focusTarget = button.id;
        return this.beginPress("action", button.id, button.rect, event);
      }
    }
    for (const tab of this.tabRects) {
      if (pointInRect(event.x, event.y, tab.rect)) return this.beginPress("tab", tab.pane, tab.rect, event);
    }
    if (this.hiddenToggleRect && pointInRect(event.x, event.y, this.hiddenToggleRect)) {
      return this.beginPress("hidden", "hidden", this.hiddenToggleRect, event);
    }

    const hit = this.treeHitRows.find((entry) => entry.y === event.y && pointInRect(event.x, event.y, entry.rowRect));
    if (!hit) return { handled: false };
    const row = this.rows[hit.rowIndex];
    if (!asNodeRow(row)) return { handled: true };
    if (event.shift) {
      const anchor = this.rangeAnchorIndex ?? this.focusedRowIndex;
      if (anchor >= 0) {
        this.rangeAnchorIndex = anchor;
        this.rangeBaseSelection ??= new Set(this.sessionState.selectedPaths);
        this.enqueue(async () => {
          await this.applyRangeSelection(anchor, hit.rowIndex);
          await this.focusRow(hit.rowIndex);
        });
      }
      return { handled: true };
    }
    if (pointInRect(event.x, event.y, hit.checkboxRect)) {
      this.rangeAnchorIndex = hit.rowIndex;
      this.rangeBaseSelection = new Set(this.sessionState.selectedPaths);
      this.enqueue(() => this.toggleSelectionAt(hit.rowIndex));
      return { handled: true };
    }
    if (pointInRect(event.x, event.y, hit.caretRect) || nodeCanExpand(row.node)) {
      this.rangeAnchorIndex = hit.rowIndex;
      this.rangeBaseSelection = new Set(this.sessionState.selectedPaths);
      this.enqueue(async () => {
        await this.focusRow(hit.rowIndex, false);
        await this.toggleDirectory(row.node);
      });
      return { handled: true };
    }
    this.rangeAnchorIndex = hit.rowIndex;
    this.rangeBaseSelection = new Set(this.sessionState.selectedPaths);
    this.enqueue(() => this.focusRow(hit.rowIndex, true, true));
    return { handled: true };
  }

  /** Alias for hosts whose first-class component contract uses this name. */
  handleMouseEvent(event: BrowserMouseEvent | unknown): MouseHandlingResult {
    return this.handleMouse(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispose();
    this.done();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.searchAbort?.abort();
    this.searchAbort = undefined;
    this.mouseAttachment.dispose();
    this.tree.dispose();
    this.onDispose?.();
  }
}
