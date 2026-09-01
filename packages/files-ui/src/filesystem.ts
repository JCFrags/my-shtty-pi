import * as fs from "node:fs/promises";
import type { Dir, Dirent, Stats } from "node:fs";
import path from "node:path";
import {
  DIRECTORY_ENTRY_LIMIT,
  FILTER_MAX_ENTRIES,
  FILTER_MAX_RESULTS,
} from "./constants.ts";
import { GitIgnoreRules } from "./gitignore.ts";
import {
  absolutePathFromRoot,
  deterministicNameCompare,
  isHiddenPath,
  isPathInside,
  normalizeRelativePath,
  relativePathFromRoot,
  toPosixPath,
} from "./path-utils.ts";
import type { FileIdentity, TreeNode, VisibleTreeRow } from "./types.ts";

export interface FileSystemOps {
  lstat(path: string): Promise<Stats>;
  stat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  opendir(path: string): Promise<Dir>;
}

const NODE_FS: FileSystemOps = {
  lstat: fs.lstat,
  stat: fs.stat,
  realpath: fs.realpath,
  readlink: fs.readlink,
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  opendir: fs.opendir,
};

export interface RepositoryTreeOptions {
  fs?: FileSystemOps;
  directoryEntryLimit?: number;
  filterMaxEntries?: number;
  filterMaxResults?: number;
}

export interface SearchResult {
  rows: VisibleTreeRow[];
  truncated: boolean;
  scannedEntries: number;
}

export interface SafeReadableFile {
  relativePath: string;
  requestedPath: string;
  absolutePath: string;
  stats: Stats;
  symlink: boolean;
}

function identityFromStats(stats: Stats): FileIdentity {
  const identity: FileIdentity = {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode,
  };
  if (typeof stats.ino === "number") identity.ino = stats.ino;
  return identity;
}

function nodeKindFromStats(stats: Stats): TreeNode["kind"] {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

function formatFsError(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? `${error.code}: ` : "";
    return `${code}${error.message}`;
  }
  return String(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function selectedStateForNode(
  node: TreeNode,
  selectedPaths: ReadonlySet<string>,
  model: RepositoryTree,
  showHidden: boolean,
): { selected: boolean; partial: boolean } {
  if (node.kind === "file" || (node.kind === "symlink" && node.symlinkTargetKind === "file" && node.symlinkWithinRoot)) {
    return { selected: selectedPaths.has(node.relativePath), partial: false };
  }
  if (node.kind !== "directory" && node.kind !== "root") return { selected: false, partial: false };
  let selectedCount = 0;
  let knownFiles = 0;
  for (const descendant of model.loadedDescendantFiles(node.relativePath)) {
    if (!showHidden && descendant.hidden) continue;
    knownFiles += 1;
    if (selectedPaths.has(descendant.relativePath)) selectedCount += 1;
  }
  if (selectedCount === 0) return { selected: false, partial: false };
  return { selected: knownFiles > 0 && selectedCount === knownFiles, partial: knownFiles === 0 || selectedCount < knownFiles };
}

export class RepositoryTree {
  readonly requestedRoot: string;
  readonly nodes = new Map<string, TreeNode>();
  readonly listingCounts = new Map<string, number>();
  readonly rulesByDirectory = new Map<string, GitIgnoreRules>();
  readonly options: Required<Pick<RepositoryTreeOptions, "directoryEntryLimit" | "filterMaxEntries" | "filterMaxResults">>;
  private readonly fs: FileSystemOps;
  private refreshCursor = 0;
  private disposed = false;
  private initialized = false;
  private _root = "";

  constructor(cwd: string, options: RepositoryTreeOptions = {}) {
    this.requestedRoot = path.resolve(cwd);
    this.fs = options.fs ?? NODE_FS;
    this.options = {
      directoryEntryLimit: options.directoryEntryLimit ?? DIRECTORY_ENTRY_LIMIT,
      filterMaxEntries: options.filterMaxEntries ?? FILTER_MAX_ENTRIES,
      filterMaxResults: options.filterMaxResults ?? FILTER_MAX_RESULTS,
    };
  }

  get root(): string {
    if (!this.initialized) throw new Error("RepositoryTree.initialize() has not completed");
    return this._root;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async initialize(): Promise<TreeNode> {
    if (this.disposed) throw new Error("RepositoryTree is disposed");
    if (this.initialized) return this.getNode("");
    this._root = await this.fs.realpath(this.requestedRoot);
    if (this.disposed) throw new Error("RepositoryTree is disposed");
    const stats = await this.fs.lstat(this._root);
    if (this.disposed) throw new Error("RepositoryTree is disposed");
    if (!stats.isDirectory()) throw new Error(`ctx.cwd is not a directory: ${this.requestedRoot}`);
    const rootNode: TreeNode = {
      id: "root",
      name: path.basename(this._root) || this._root,
      relativePath: "",
      absolutePath: this._root,
      parentPath: null,
      depth: 0,
      kind: "root",
      hidden: false,
      ignored: false,
      expanded: true,
      loaded: false,
      loading: false,
      truncated: false,
      children: [],
      identity: identityFromStats(stats),
    };
    this.nodes.set("", rootNode);
    this.rulesByDirectory.set("", new GitIgnoreRules());
    this.initialized = true;
    await this.loadDirectory("");
    return rootNode;
  }

  getNode(relativePath: string): TreeNode {
    const normalized = normalizeRelativePath(relativePath);
    const node = this.nodes.get(normalized);
    if (!node) throw new Error(`Unknown tree node: ${normalized || "."}`);
    return node;
  }

  findNode(relativePath: string): TreeNode | undefined {
    return this.nodes.get(normalizeRelativePath(relativePath));
  }

  /** Load only the ancestor chain needed to materialize one path. */
  async ensureNode(relativePath: string): Promise<TreeNode> {
    if (!this.initialized) await this.initialize();
    const normalized = normalizeRelativePath(relativePath);
    if (normalized === "") return this.getNode("");
    const segments = normalized.split("/");
    let parentPath = "";
    for (const segment of segments) {
      await this.loadDirectory(parentPath);
      const nextPath = parentPath ? `${parentPath}/${segment}` : segment;
      const node = this.nodes.get(nextPath);
      if (!node) throw new Error(`Path is unavailable or ignored: ${normalized}`);
      parentPath = nextPath;
    }
    return this.getNode(normalized);
  }

  private inheritedRulesForDirectory(relativePath: string): GitIgnoreRules {
    const normalized = normalizeRelativePath(relativePath);
    if (normalized === "") return new GitIgnoreRules();
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
    return this.rulesByDirectory.get(parentPath) ?? new GitIgnoreRules();
  }

  private async loadOwnIgnoreFile(relativePath: string, inherited: GitIgnoreRules): Promise<GitIgnoreRules> {
    const ignorePath = path.join(absolutePathFromRoot(this.root, relativePath), ".gitignore");
    try {
      const content = await this.fs.readFile(ignorePath, "utf8");
      return inherited.withFile(relativePath, content);
    } catch (error) {
      if (isNotFound(error)) return inherited;
      const node = this.getNode(relativePath);
      const message = `Could not read .gitignore: ${formatFsError(error)}`;
      node.error = node.error ? `${node.error}; ${message}` : message;
      return inherited;
    }
  }

  async loadDirectory(relativePath: string, force = false): Promise<TreeNode> {
    if (this.disposed) throw new Error("RepositoryTree is disposed");
    if (!this.initialized) await this.initialize();
    const normalized = normalizeRelativePath(relativePath);
    const node = this.getNode(normalized);
    if (node.kind !== "directory" && node.kind !== "root") return node;
    if (node.loading) return node;
    if (node.loaded && !force) return node;

    node.loading = true;
    node.error = undefined;
    node.truncated = false;
    const oldChildren = new Set(node.children);
    try {
      const parentRules = this.inheritedRulesForDirectory(normalized);
      const rules = await this.loadOwnIgnoreFile(normalized, parentRules);
      if (this.disposed) return node;
      this.rulesByDirectory.set(normalized, rules);
      const directory = await this.fs.opendir(node.absolutePath);
      const entries: Dirent[] = [];
      let truncated = false;
      for await (const entry of directory) {
        if (entries.length >= this.options.directoryEntryLimit) {
          truncated = true;
          break;
        }
        entries.push(entry);
      }
      if (this.disposed) return node;
      this.listingCounts.set(normalized, (this.listingCounts.get(normalized) ?? 0) + 1);

      const childNodes: TreeNode[] = [];
      const batchSize = 64;
      for (let start = 0; start < entries.length; start += batchSize) {
        const batch = entries.slice(start, start + batchSize);
        const resolved = await Promise.all(batch.map((entry) => this.createNodeFromEntry(node, entry, rules)));
        for (const child of resolved) if (child) childNodes.push(child);
      }
      if (this.disposed) return node;
      childNodes.sort((left, right) => {
        const leftBucket = left.kind === "directory" ? 0 : 1;
        const rightBucket = right.kind === "directory" ? 0 : 1;
        if (leftBucket !== rightBucket) return leftBucket - rightBucket;
        const nameOrder = deterministicNameCompare(left.name, right.name);
        return nameOrder !== 0 ? nameOrder : deterministicNameCompare(left.relativePath, right.relativePath);
      });

      node.children = childNodes.map((child) => child.relativePath);
      node.truncated = truncated;
      node.loaded = true;
      for (const child of childNodes) {
        oldChildren.delete(child.relativePath);
        const previous = this.nodes.get(child.relativePath);
        if (previous?.kind === "directory" && child.kind !== "directory") {
          for (const descendantPath of previous.children) this.deleteSubtree(descendantPath);
          this.rulesByDirectory.delete(child.relativePath);
        }
        this.nodes.set(child.relativePath, child);
      }
      for (const stalePath of oldChildren) this.deleteSubtree(stalePath);
      try {
        const freshStats = await this.fs.lstat(node.absolutePath);
        node.identity = identityFromStats(freshStats);
      } catch {
        // The listing itself succeeded; retain the prior identity if the follow-up stat races a deletion.
      }
    } catch (error) {
      if (!this.disposed) {
        node.error = formatFsError(error);
        node.loaded = true;
        node.children = [];
        for (const stalePath of oldChildren) this.deleteSubtree(stalePath);
      }
    } finally {
      node.loading = false;
    }
    return node;
  }

  private async createNodeFromEntry(parent: TreeNode, entry: Dirent, rules: GitIgnoreRules): Promise<TreeNode | undefined> {
    const relativePath = normalizeRelativePath(parent.relativePath ? `${parent.relativePath}/${entry.name}` : entry.name);
    const absolutePath = absolutePathFromRoot(this.root, relativePath);
    let stats: Stats;
    try {
      stats = await this.fs.lstat(absolutePath);
    } catch (error) {
      return {
        id: relativePath,
        name: entry.name,
        relativePath,
        absolutePath,
        parentPath: parent.relativePath,
        depth: parent.depth + 1,
        kind: "other",
        hidden: isHiddenPath(relativePath),
        ignored: false,
        expanded: false,
        loaded: true,
        loading: false,
        truncated: false,
        error: formatFsError(error),
        children: [],
      };
    }

    const kind = nodeKindFromStats(stats);
    const isDirectory = kind === "directory";
    const ignored = rules.isIgnored(relativePath, isDirectory);
    if (ignored) return undefined;

    const existing = this.nodes.get(relativePath);
    const reusableDirectory = kind === "directory" && existing?.kind === "directory";
    const child: TreeNode = {
      id: relativePath,
      name: entry.name,
      relativePath,
      absolutePath,
      parentPath: parent.relativePath,
      depth: parent.depth + 1,
      kind,
      hidden: isHiddenPath(relativePath),
      ignored: false,
      expanded: reusableDirectory ? existing.expanded : false,
      loaded: kind === "directory" ? (reusableDirectory ? existing.loaded : false) : true,
      loading: false,
      truncated: reusableDirectory ? existing.truncated : false,
      children: reusableDirectory ? existing.children : [],
      identity: identityFromStats(stats),
    };

    if (kind === "symlink") await this.populateSymlink(child);
    return child;
  }

  private async populateSymlink(node: TreeNode): Promise<void> {
    try {
      const target = await this.fs.readlink(node.absolutePath);
      node.symlinkTarget = toPosixPath(target);
      let resolved: string;
      try {
        resolved = await this.fs.realpath(node.absolutePath);
      } catch (error) {
        node.symlinkTargetKind = "missing";
        node.symlinkWithinRoot = false;
        node.error = formatFsError(error);
        return;
      }
      node.symlinkResolvedPath = resolved;
      node.symlinkWithinRoot = isPathInside(this.root, resolved);
      const targetStats = await this.fs.stat(node.absolutePath);
      node.symlinkTargetKind = targetStats.isDirectory() ? "directory" : targetStats.isFile() ? "file" : "other";
    } catch (error) {
      node.error = formatFsError(error);
      node.symlinkWithinRoot = false;
      node.symlinkTargetKind = "missing";
    }
  }

  private deleteSubtree(relativePath: string): void {
    const normalized = normalizeRelativePath(relativePath);
    const node = this.nodes.get(normalized);
    if (!node) return;
    for (const childPath of node.children) this.deleteSubtree(childPath);
    this.nodes.delete(normalized);
    this.rulesByDirectory.delete(normalized);
  }

  async expand(relativePath: string): Promise<TreeNode> {
    const node = this.getNode(relativePath);
    if (node.kind !== "directory" && node.kind !== "root") return node;
    node.expanded = true;
    return this.loadDirectory(node.relativePath);
  }

  collapse(relativePath: string): TreeNode {
    const node = this.getNode(relativePath);
    if (node.kind === "directory" || node.kind === "root") node.expanded = false;
    return node;
  }

  async toggleExpanded(relativePath: string): Promise<TreeNode> {
    const node = this.getNode(relativePath);
    if (node.kind !== "directory" && node.kind !== "root") return node;
    return node.expanded ? this.collapse(node.relativePath) : this.expand(node.relativePath);
  }

  *loadedDescendantFiles(relativePath: string): IterableIterator<TreeNode> {
    const normalized = normalizeRelativePath(relativePath);
    const prefix = normalized === "" ? "" : `${normalized}/`;
    for (const node of this.nodes.values()) {
      if (node.relativePath === normalized || (prefix !== "" && !node.relativePath.startsWith(prefix))) continue;
      if (
        node.kind === "file" ||
        (node.kind === "symlink" && node.symlinkTargetKind === "file" && node.symlinkWithinRoot === true)
      ) {
        yield node;
      }
    }
  }

  visibleRows(options: {
    showHidden: boolean;
    selectedPaths: ReadonlySet<string>;
    filter?: string | undefined;
    searchNodes?: readonly TreeNode[] | undefined;
    searchTruncated?: boolean | undefined;
  }): VisibleTreeRow[] {
    const rows: VisibleTreeRow[] = [];
    const visiblePaths = new Set<string>();
    const query = options.filter?.trim().toLowerCase() ?? "";
    const root = this.getNode("");
    if (root.error) {
      rows.push({
        key: "warning:root-error",
        kind: "warning",
        label: `Repository root error: ${root.error}`,
        depth: 0,
        selected: false,
        partiallySelected: false,
        supplemental: false,
      });
    }

    const appendNode = (node: TreeNode, supplemental: boolean, depth = node.depth - 1): void => {
      if (!options.showHidden && node.hidden && !options.selectedPaths.has(node.relativePath)) return;
      const state = selectedStateForNode(node, options.selectedPaths, this, options.showHidden);
      rows.push({
        key: supplemental ? `selected:${node.relativePath}` : node.relativePath,
        kind: "node",
        node,
        depth: Math.max(0, depth),
        selected: state.selected,
        partiallySelected: state.partial,
        supplemental,
      });
      visiblePaths.add(node.relativePath);
      if (node.truncated) {
        rows.push({
          key: `warning:${node.relativePath}`,
          kind: "warning",
          label: `Listing truncated at ${this.options.directoryEntryLimit.toLocaleString("en-US")} entries`,
          depth: Math.max(0, depth + 1),
          selected: false,
          partiallySelected: false,
          supplemental,
        });
      }
    };

    if (query !== "" && options.searchNodes) {
      for (const node of options.searchNodes) appendNode(node, false, 0);
      if (options.searchTruncated) {
        rows.push({
          key: "warning:filter-truncated",
          kind: "warning",
          label: `Filter results truncated at ${this.options.filterMaxResults.toLocaleString("en-US")} matches`,
          depth: 0,
          selected: false,
          partiallySelected: false,
          supplemental: false,
        });
      }
    } else if (query !== "") {
      const loadedMatches = [...this.nodes.values()]
        .filter((node) => node.relativePath !== "" && node.relativePath.toLowerCase().includes(query))
        .sort((left, right) => deterministicNameCompare(left.relativePath, right.relativePath));
      for (const node of loadedMatches) appendNode(node, false, 0);
    } else {
      if (root.truncated) {
        rows.push({
          key: "warning:root",
          kind: "warning",
          label: `Listing truncated at ${this.options.directoryEntryLimit.toLocaleString("en-US")} entries`,
          depth: 0,
          selected: false,
          partiallySelected: false,
          supplemental: false,
        });
      }
      const walk = (directory: TreeNode): void => {
        for (const childPath of directory.children) {
          const child = this.nodes.get(childPath);
          if (!child) continue;
          appendNode(child, false);
          if (child.kind === "directory" && child.expanded && child.loaded) walk(child);
        }
      };
      walk(this.getNode(""));
    }

    const supplemental = [...options.selectedPaths]
      .filter((selectedPath) => !visiblePaths.has(selectedPath))
      .map((selectedPath) => this.nodes.get(selectedPath))
      .filter((node): node is TreeNode => node !== undefined)
      .sort((left, right) => deterministicNameCompare(left.relativePath, right.relativePath));
    if (supplemental.length > 0) {
      rows.push({
        key: "section:selected",
        kind: "section",
        label: "Selected (collapsed, hidden, or filtered)",
        depth: 0,
        selected: false,
        partiallySelected: false,
        supplemental: true,
      });
      for (const node of supplemental) appendNode(node, true, 0);
    }
    return rows;
  }

  async search(query: string, showHidden: boolean, signal?: AbortSignal, selectedPaths: ReadonlySet<string> = new Set()): Promise<SearchResult> {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery === "") return { rows: [], truncated: false, scannedEntries: 0 };
    const queue = [""];
    let queueIndex = 0;
    const matches: TreeNode[] = [];
    let scannedEntries = 0;
    let truncated = false;
    while (queueIndex < queue.length) {
      if (signal?.aborted) throw signal.reason ?? new Error("Filter search aborted");
      const directoryPath = queue[queueIndex];
      queueIndex += 1;
      if (directoryPath === undefined) break;
      const directory = await this.loadDirectory(directoryPath);
      if (signal?.aborted) throw signal.reason ?? new Error("Filter search aborted");
      for (const childPath of directory.children) {
        const child = this.nodes.get(childPath);
        if (!child) continue;
        scannedEntries += 1;
        if (scannedEntries > this.options.filterMaxEntries) {
          truncated = true;
          queue.length = queueIndex;
          break;
        }
        const hiddenAllowed = showHidden || !child.hidden;
        if (hiddenAllowed && child.relativePath.toLowerCase().includes(normalizedQuery)) {
          matches.push(child);
          if (matches.length >= this.options.filterMaxResults) {
            truncated = true;
            queue.length = 0;
            break;
          }
        }
        if (child.kind === "directory") queue.push(child.relativePath);
      }
    }
    matches.sort((left, right) => {
      const leftBucket = left.kind === "directory" ? 0 : 1;
      const rightBucket = right.kind === "directory" ? 0 : 1;
      if (leftBucket !== rightBucket) return leftBucket - rightBucket;
      return deterministicNameCompare(left.relativePath, right.relativePath);
    });
    const rows = this.visibleRows({
      showHidden,
      selectedPaths,
      filter: normalizedQuery,
      searchNodes: matches,
      searchTruncated: truncated,
    });
    return { rows, truncated, scannedEntries };
  }

  async collectFiles(relativePath: string, maxFiles = this.options.directoryEntryLimit): Promise<string[]> {
    const normalized = normalizeRelativePath(relativePath);
    const start = this.getNode(normalized);
    if (start.kind === "file" || (start.kind === "symlink" && start.symlinkTargetKind === "file" && start.symlinkWithinRoot)) {
      return [start.relativePath];
    }
    if (start.kind !== "directory" && start.kind !== "root") return [];
    const queue = [normalized];
    let queueIndex = 0;
    const result: string[] = [];
    while (queueIndex < queue.length && result.length < maxFiles) {
      const directoryPath = queue[queueIndex];
      queueIndex += 1;
      if (directoryPath === undefined) break;
      const directory = await this.loadDirectory(directoryPath);
      for (const childPath of directory.children) {
        const child = this.nodes.get(childPath);
        if (!child) continue;
        if (child.kind === "directory") queue.push(child.relativePath);
        else if (child.kind === "file" || (child.kind === "symlink" && child.symlinkTargetKind === "file" && child.symlinkWithinRoot)) {
          result.push(child.relativePath);
          if (result.length >= maxFiles) break;
        }
      }
    }
    return result.sort(deterministicNameCompare);
  }

  async resolveSafeReadableFile(relativePath: string): Promise<SafeReadableFile> {
    if (this.disposed) throw new Error("RepositoryTree is disposed");
    if (!this.initialized) await this.initialize();
    const normalized = normalizeRelativePath(relativePath);
    const requestedPath = absolutePathFromRoot(this.root, normalized);
    let stats: Stats;
    try {
      stats = await this.fs.lstat(requestedPath);
    } catch (error) {
      throw new Error(`Cannot read ${normalized}: ${formatFsError(error)}`, { cause: error });
    }
    const symlink = stats.isSymbolicLink();
    const realPath = await this.fs.realpath(requestedPath).catch((error: unknown) => {
      throw new Error(`Cannot resolve ${normalized}: ${formatFsError(error)}`, { cause: error });
    });
    if (!isPathInside(this.root, realPath)) {
      throw new Error(`Refusing to read outside ctx.cwd through symlink: ${normalized}`);
    }
    const targetStats = symlink ? await this.fs.stat(requestedPath) : stats;
    if (!targetStats.isFile()) throw new Error(`Not a regular file: ${normalized}`);
    return {
      relativePath: relativePathFromRoot(this.root, requestedPath),
      requestedPath,
      absolutePath: realPath,
      stats: targetStats,
      symlink,
    };
  }

  async refreshSelected(selectedPaths: Set<string>): Promise<{ removed: string[]; changed: string[] }> {
    if (this.disposed) return { removed: [], changed: [] };
    const removed: string[] = [];
    const changed: string[] = [];
    for (const selectedPath of [...selectedPaths]) {
      if (this.disposed) break;
      const node = this.nodes.get(selectedPath);
      try {
        const safe = await this.resolveSafeReadableFile(selectedPath);
        const nextIdentity = identityFromStats(safe.stats);
        if (node?.identity && (node.identity.size !== nextIdentity.size || node.identity.mtimeMs !== nextIdentity.mtimeMs)) {
          changed.push(selectedPath);
        }
        if (node) node.identity = nextIdentity;
      } catch {
        selectedPaths.delete(selectedPath);
        removed.push(selectedPath);
        if (node) this.deleteSubtree(selectedPath);
      }
    }
    return { removed, changed };
  }

  async refreshBounded(maxDirectories = 64): Promise<void> {
    if (this.disposed) return;
    const directories = [...this.nodes.values()].filter(
      (node) => (node.kind === "directory" || node.kind === "root") && node.loaded,
    );
    if (directories.length === 0) return;
    const count = Math.min(maxDirectories, directories.length);
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.refreshCursor + offset) % directories.length;
      const node = directories[index];
      if (!node) continue;
      try {
        const stats = await this.fs.lstat(node.absolutePath);
        const changed = !node.identity || node.identity.mtimeMs !== stats.mtimeMs || node.identity.size !== stats.size;
        if (changed) await this.loadDirectory(node.relativePath, true);
      } catch (error) {
        node.error = formatFsError(error);
        node.children = [];
        node.loaded = true;
      }
    }
    this.refreshCursor = (this.refreshCursor + count) % directories.length;
  }

  dispose(): void {
    this.disposed = true;
    this.nodes.clear();
    this.rulesByDirectory.clear();
    this.listingCounts.clear();
  }
}
