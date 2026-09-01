export type NodeKind = "root" | "directory" | "file" | "symlink" | "other";

export interface FileIdentity {
  size: number;
  mtimeMs: number;
  mode: number;
  ino?: number;
}

export interface TreeNode {
  id: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  parentPath: string | null;
  depth: number;
  kind: NodeKind;
  hidden: boolean;
  ignored: boolean;
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  truncated: boolean;
  error?: string | undefined;
  children: string[];
  identity?: FileIdentity | undefined;
  symlinkTarget?: string | undefined;
  symlinkResolvedPath?: string | undefined;
  symlinkTargetKind?: "file" | "directory" | "other" | "missing" | undefined;
  symlinkWithinRoot?: boolean | undefined;
}

export type VisibleRowKind = "node" | "section" | "warning";

export interface VisibleTreeRow {
  key: string;
  kind: VisibleRowKind;
  node?: TreeNode | undefined;
  label?: string | undefined;
  depth: number;
  selected: boolean;
  partiallySelected: boolean;
  supplemental: boolean;
}

export interface PreviewMetadata {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  mode: number;
  encoding: "utf-8";
  invalidUtf8: boolean;
  changed: boolean;
  binary: boolean;
  binaryKind?: string | undefined;
  truncated: boolean;
  truncatedBy?: "bytes" | "lines" | "bytes-and-lines" | undefined;
  bytesRead: number;
  totalLines?: number | undefined;
  displayedLines: number;
}

export interface PreviewResult {
  metadata: PreviewMetadata;
  lines: string[];
  rawText?: string | undefined;
  error?: string | undefined;
}

export interface InsertCandidate {
  path: string;
  absolutePath: string;
  bytes: number;
  characters: number;
  approximateTokens: number;
  content?: string | undefined;
  binary: boolean;
  binaryKind?: string | undefined;
  invalidUtf8: boolean;
  eligible: boolean;
  included: boolean;
  reason?: "binary" | "outside-root" | "not-file" | "invalid-utf8" | "per-file-limit" | "total-limit" | "missing" | "read-error" | undefined;
  error?: string | undefined;
}

export interface InsertBudget {
  candidates: InsertCandidate[];
  includedBytes: number;
  includedCharacters: number;
  approximateTokens: number;
  perFileMaxBytes: number;
  totalMaxBytes: number;
  overBudget: boolean;
}

export interface BrowserSessionState {
  selectedPaths: Set<string>;
  showHidden: boolean;
  expandedPaths: Set<string>;
}

export type BrowserPane = "tree" | "preview";
export type BrowserFocusTarget = BrowserPane | "insert-paths" | "insert-contents" | "clear" | "close";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserLayout {
  width: number;
  height: number;
  narrow: boolean;
  header: Rect;
  tree?: Rect | undefined;
  preview?: Rect | undefined;
  singlePane?: Rect | undefined;
  tabs?: Rect | undefined;
  actions: Rect;
  contentRows: number;
  actionButtons: Array<{ id: Exclude<BrowserFocusTarget, BrowserPane>; rect: Rect; label: string }>;
}

export type MouseEventKind = "press" | "release" | "move" | "wheel";

export interface BrowserMouseEvent {
  kind: MouseEventKind;
  x: number;
  y: number;
  button?: "left" | "middle" | "right" | undefined;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  wheelDelta?: number | undefined;
  raw?: unknown | undefined;
}

export interface MouseHandlingResult {
  handled: boolean;
  preserveTextSelection?: boolean | undefined;
}
