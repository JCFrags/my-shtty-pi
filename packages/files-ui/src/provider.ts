import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INSERT_PER_FILE_MAX_BYTES, INSERT_TOTAL_MAX_BYTES } from "./constants.ts";
import { RepositoryTree } from "./filesystem.ts";
import { approximateTokensFromCharacters, formatLengthDelimitedFiles, formatSelectedPaths, InsertBudgetModel, prepareInsertBudget } from "./insertion.ts";
import { PreviewService } from "./preview.ts";
import { deterministicNameCompare, normalizeRelativePath } from "./path-utils.ts";
import type { InsertBudget, PreviewResult, TreeNode, VisibleTreeRow } from "./types.ts";

export const FILES_PROVIDER_REQUEST_EVENT = "pi-files-ui:provider-request-v1" as const;
export const FILES_PROVIDER_RESPONSE_EVENT = "pi-files-ui:provider-response-v1" as const;
export const FILES_PROVIDER_SUMMARY_EVENT = "pi-files-ui:provider-summary-v1" as const;
export const FILES_PROVIDER_VIEW_EVENT = "pi-files-ui:provider-view-change-v1" as const;

export type FilesProviderAction = "snapshot" | "list" | "navigate" | "expand" | "preview" | "filter" | "toggle-selection" | "clear-selection" | "toggle-hidden" | "insert-paths" | "prepare-contents" | "insert-contents";
export interface FilesProviderRequest { version: 1; requestId: string; action: FilesProviderAction; path?: string; query?: string; expanded?: boolean; selected?: boolean; includedPaths?: string[]; }
export interface FilesProviderLimits { directoryEntryLimit: number; filterMaxEntries: number; filterMaxResults: number; previewMaxBytes: number; previewMaxLines: number; insertPerFileMaxBytes: number; insertTotalMaxBytes: number; maxRowsPerEvent: number; maxErrorCharacters: number; }
export interface FilesProviderSummary { version: 1; cwd: string; currentPath: string; selectedPaths: string[]; selectedCount: number; showHidden?: boolean; selectedKnownBytes?: number; selectedApproximateTokens?: number; limits: FilesProviderLimits; }
export interface FilesProviderRow { path: string; name: string; kind: TreeNode["kind"]; depth: number; selected: boolean; partiallySelected: boolean; expanded: boolean; loaded: boolean; truncated: boolean; hidden: boolean; ignored: boolean; supplemental: boolean; /** Additive row discriminator for non-node informational rows. */ rowType?: VisibleTreeRow["kind"]; /** Bounded display text for a section or warning row. */ message?: string; error?: string; }
export interface FilesProviderPreview { metadata: PreviewResult["metadata"]; lines: string[]; error?: string; }
export interface FilesProviderView { version: 1; cwd: string; currentPath: string; rows: FilesProviderRow[]; filter: string; searchTruncated: boolean; showHidden?: boolean; previewPath?: string; preview?: FilesProviderPreview; }
export interface FilesProviderResponse { version: 1; requestId: string; ok: boolean; summary?: FilesProviderSummary; view?: FilesProviderView; budget?: InsertBudget; error?: string; }

const MAX_ROWS = 256;
const MAX_ERROR = 240;
const MAX_REQUEST_ID = 128;
const bounded = (value: string, limit: number): string => value.slice(0, limit);
const requestId = (value: unknown): string => typeof value === "string" ? bounded(value.trim(), MAX_REQUEST_ID) : "";
const safeError = (error: unknown): string => bounded(error instanceof Error ? error.message : String(error), MAX_ERROR);

function rowFromVisible(row: VisibleTreeRow): FilesProviderRow {
  const node = row.node;
  const message = row.label ? bounded(row.label, MAX_ERROR) : undefined;
  return { path: node?.relativePath ?? "", name: node?.name ?? "", kind: node?.kind ?? "other", depth: row.depth, selected: row.selected, partiallySelected: row.partiallySelected, expanded: node?.expanded ?? false, loaded: node?.loaded ?? false, truncated: node?.truncated ?? false, hidden: node?.hidden ?? false, ignored: node?.ignored ?? false, supplemental: row.supplemental, ...(row.kind !== "node" ? { rowType: row.kind } : {}), ...(message ? { message } : {}), ...(node?.error ? { error: bounded(node.error, MAX_ERROR) } : {}) };
}

function boundedPreview(result: PreviewResult): FilesProviderPreview {
  return { metadata: result.metadata, lines: result.lines.slice(0, 256).map((line) => bounded(line, 4096)), ...(result.error ? { error: safeError(result.error) } : {}) };
}

export class FilesProvider {
  private readonly ctx: ExtensionContext;
  private readonly emit: (channel: string, data: unknown) => void;
  private readonly tree: RepositoryTree;
  private readonly preview: PreviewService;
  private readonly selected = new Set<string>();
  private currentPath = "";
  private showHidden = false;
  private filterQuery = "";
  private searchRows: VisibleTreeRow[] | undefined;
  private searchTruncated = false;
  private disposed = false;
  private lastBudget: InsertBudget | undefined;
  private previewPath: string | undefined;
  private previewResult: PreviewResult | undefined;

  constructor(ctx: ExtensionContext, emit: (channel: string, data: unknown) => void) {
    this.ctx = ctx;
    this.emit = emit;
    this.tree = new RepositoryTree(ctx.cwd);
    this.preview = new PreviewService(this.tree);
  }
  async initialize(): Promise<void> { await this.tree.initialize(); }
  dispose(): void { this.disposed = true; this.tree.dispose(); }
  private limits(): FilesProviderLimits { return { directoryEntryLimit: this.tree.options.directoryEntryLimit, filterMaxEntries: this.tree.options.filterMaxEntries, filterMaxResults: this.tree.options.filterMaxResults, previewMaxBytes: this.preview.maxBytes, previewMaxLines: this.preview.maxLines, insertPerFileMaxBytes: INSERT_PER_FILE_MAX_BYTES, insertTotalMaxBytes: INSERT_TOTAL_MAX_BYTES, maxRowsPerEvent: MAX_ROWS, maxErrorCharacters: MAX_ERROR }; }
  private summary(): FilesProviderSummary {
    const selectedPaths = [...this.selected].sort(deterministicNameCompare);
    const selectedKnownBytes = selectedPaths.reduce((total, pathValue) => total + (this.tree.findNode(pathValue)?.identity?.size ?? 0), 0);
    return { version: 1, cwd: this.tree.root, currentPath: this.currentPath, selectedPaths, selectedCount: selectedPaths.length, showHidden: this.showHidden, selectedKnownBytes, selectedApproximateTokens: approximateTokensFromCharacters(selectedKnownBytes), limits: this.limits() };
  }
  private view(): FilesProviderView {
    const rows = this.searchRows ?? this.tree.visibleRows({ showHidden: this.showHidden, selectedPaths: this.selected });
    return { version: 1, cwd: this.tree.root, currentPath: this.currentPath, rows: rows.slice(0, MAX_ROWS).map(rowFromVisible), filter: this.filterQuery, searchTruncated: this.searchTruncated, showHidden: this.showHidden, ...(this.previewPath ? { previewPath: this.previewPath } : {}), ...(this.previewResult ? { preview: boundedPreview(this.previewResult) } : {}) };
  }
  private async refreshPreview(): Promise<void> {
    if (!this.previewPath) return;
    const result = await this.preview.load(this.previewPath);
    if (result.error) {
      this.previewPath = undefined;
      this.previewResult = undefined;
      return;
    }
    this.previewResult = result;
  }
  publishState(): void { this.emit(FILES_PROVIDER_SUMMARY_EVENT, this.summary()); this.emit(FILES_PROVIDER_VIEW_EVENT, this.view()); }
  private async rebuildFilter(): Promise<void> {
    if (this.filterQuery.trim() === "") {
      this.searchRows = undefined;
      this.searchTruncated = false;
      return;
    }
    const search = await this.tree.search(this.filterQuery, this.showHidden, undefined, this.selected);
    this.searchRows = [...search.rows];
    this.searchTruncated = search.truncated;
  }
  private async refreshState(): Promise<void> {
    await this.tree.refreshBounded();
    await this.tree.refreshSelected(this.selected);
    await this.rebuildFilter();
    await this.refreshPreview();
  }
  private async validateSelection(): Promise<string[]> { await this.tree.refreshSelected(this.selected); return [...this.selected].sort(deterministicNameCompare); }
  private async selectPath(pathValue: string, desired?: boolean): Promise<void> { const node = this.tree.getNode(pathValue); const paths = node.kind === "file" || (node.kind === "symlink" && node.symlinkTargetKind === "file" && node.symlinkWithinRoot === true) ? [node.relativePath] : await this.tree.collectFiles(node.relativePath); const include = desired ?? !paths.every((path) => this.selected.has(path)); for (const path of paths) include ? this.selected.add(path) : this.selected.delete(path); await this.tree.refreshSelected(this.selected); }
  private async prepareContents(includedPaths?: string[]): Promise<InsertBudget> { const selected = await this.validateSelection(); const budget = await prepareInsertBudget(this.tree, selected, { perFileMaxBytes: INSERT_PER_FILE_MAX_BYTES, totalMaxBytes: INSERT_TOTAL_MAX_BYTES }); if (includedPaths) { const wanted = new Set(includedPaths.map(normalizeRelativePath)); const model = new InsertBudgetModel(budget); for (const candidate of budget.candidates) model.setIncluded(candidate.path, wanted.has(candidate.path)); } this.lastBudget = budget; return budget; }

  async handle(request: FilesProviderRequest): Promise<Omit<FilesProviderResponse, "requestId">> {
    if (this.disposed) throw new Error("Files provider is disposed");
    switch (request.action) {
      case "snapshot": {
        await this.refreshState();
        const pathValue = normalizeRelativePath(request.path ?? this.currentPath);
        const node = this.tree.getNode(pathValue);
        if (node.kind !== "directory" && node.kind !== "root") throw new Error("Listing requires a directory path");
        await this.tree.expand(pathValue);
        this.currentPath = pathValue;
        await this.rebuildFilter();
        break;
      }
      case "list": { const pathValue = normalizeRelativePath(request.path ?? this.currentPath); const node = this.tree.getNode(pathValue); if (node.kind !== "directory" && node.kind !== "root") throw new Error("Listing requires a directory path"); await this.tree.expand(pathValue); this.currentPath = pathValue; break; }
      case "navigate": { const pathValue = normalizeRelativePath(request.path ?? ""); const node = this.tree.getNode(pathValue); if (node.kind !== "directory" && node.kind !== "root") throw new Error("Navigation requires a directory path"); await this.tree.expand(pathValue); this.currentPath = pathValue; break; }
      case "expand": { const pathValue = normalizeRelativePath(request.path ?? this.currentPath); const node = this.tree.getNode(pathValue); if (request.expanded === false) this.tree.collapse(pathValue); else await this.tree.expand(pathValue); if (node.kind === "directory" || node.kind === "root") this.currentPath = pathValue; break; }
      case "preview": {
        this.previewPath = normalizeRelativePath(request.path ?? "");
        this.previewResult = await this.preview.load(this.previewPath);
        break;
      }
      case "filter": {
        this.filterQuery = bounded(typeof request.query === "string" ? request.query : "", 256);
        await this.rebuildFilter();
        break;
      }
      case "toggle-selection": await this.selectPath(normalizeRelativePath(request.path ?? ""), request.selected); break;
      case "clear-selection": this.selected.clear(); this.lastBudget = undefined; break;
      case "toggle-hidden": {
        this.showHidden = !this.showHidden;
        await this.rebuildFilter();
        break;
      }
      case "insert-paths": { const paths = await this.validateSelection(); if (paths.length === 0) throw new Error("Select at least one file"); this.ctx.ui.pasteToEditor(formatSelectedPaths(paths)); break; }
      case "prepare-contents": this.lastBudget = await this.prepareContents(); break;
      case "insert-contents": { const budget = await this.prepareContents(request.includedPaths); const candidates = new InsertBudgetModel(budget).includedCandidates(); if (candidates.length === 0) throw new Error("No insertable files are included"); this.ctx.ui.pasteToEditor(formatLengthDelimitedFiles(candidates)); break; }
      default: throw new Error(`Unsupported files provider action: ${String(request.action)}`);
    }
    if (request.action !== "preview" && request.action !== "snapshot") await this.refreshPreview();
    this.emit(FILES_PROVIDER_SUMMARY_EVENT, this.summary());
    this.emit(FILES_PROVIDER_VIEW_EVENT, this.view());
    return { version: 1, ok: true, summary: this.summary(), view: this.view(), ...(this.lastBudget && request.action === "prepare-contents" ? { budget: this.lastBudget } : {}) };
  }
}

export function parseFilesProviderRequest(data: unknown): FilesProviderRequest | undefined { if (!data || typeof data !== "object") return undefined; const value = data as Partial<FilesProviderRequest>; const id = requestId(value.requestId); if (value.version !== 1 || !id || typeof value.action !== "string") return undefined; return { ...value, version: 1, requestId: id, action: value.action as FilesProviderAction }; }
export function providerErrorResponse(id: string, error: unknown): FilesProviderResponse { return { version: 1, requestId: id, ok: false, error: safeError(error) }; }
