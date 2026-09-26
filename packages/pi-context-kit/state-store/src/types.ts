/** Native Pi source access only. This library never rewrites session JSONL. */
export interface SessionEntryView {
  id: string;
  parentId: string | null;
  type: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
  timestamp?: string;
}
export interface StateSessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getEntry(id: string): SessionEntryView | undefined;
  getHeader(): { id?: string; parentSession?: string } | null;
}
export interface StateAnchorHost {
  sessionManager: StateSessionManager;
  appendEntry(customType: string, data: unknown): void;
}
export type StateProviderId = "todo" | "notes" | "workplan";
export interface StateScope { sessionId: string; leafId: string | null }
export type StateDurability = "disk" | "ephemeral" | "deferred";
/** Linux Btrfs statfs identity includes the filesystem and subvolume root ID. */
export interface DurableSourceIdentity {
  scheme: "linux-btrfs-statfs-v1";
  filesystemId: string;
  birthtimeNs: string;
}
export interface DiskSourceIdentity {
  durability: "disk"; sessionId: string; file: string; device: string; inode: string;
  size: number; headerHash: string;
  /** Absent in legacy commits and on platforms without a supported durable identity. */
  identity?: DurableSourceIdentity;
}
export type SourceIdentity = DiskSourceIdentity | { durability: "ephemeral"; sessionId: string }
  | { durability: "deferred"; sessionId: string; file: string };
export interface SourcePrefixProof { bytes: number; sha256: string }
/** Operator-supplied evidence, never generated or inferred by normal resolution. */
export interface LegacySourceRecovery {
  authorization: "independent-prefix-sha256";
  commitRef: ObjectRef;
  scope: StateScope;
  source: DiskSourceIdentity;
  target: DiskSourceIdentity;
  /** Independently established before recovery. Must include the committed anchor. */
  prefix: SourcePrefixProof;
}
export interface ObjectRef {
  version: 1;
  providerId: StateProviderId;
  storeId: string;
  hash: string;
  bytes: number;
}
export interface ObjectStoreOptions {
  providerId: StateProviderId;
  /** Exact private provider directory. Default: XDG_STATE_HOME/pi-context-kit/<provider>. */
  storeRoot?: string;
  objectMaxBytes?: number;
}
export interface ObjectLocation { readonly root: string; readonly providerId: StateProviderId; readonly storeId: string }
export interface ObjectOptions<T> {
  maxBytes?: number;
  validate?: (value: T) => void;
  signal?: AbortSignal;
}
export interface AncestryPage {
  scope: StateScope;
  /** Detached exact native entries, newest first. */
  entries: SessionEntryView[];
  nextEntryId: string | null;
  complete: boolean;
  scanned: number;
  bytes: number;
  digest: string;
}
export interface AncestryPageOptions {
  /** Required. Use the captured leaf for the first page, then nextEntryId. */
  fromEntryId: string | null;
  maxEntries?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}
export interface ImportReceiptInput {
  importer: string;
  source: StateScope;
  coverage: {
    scannedEntries: number;
    providerEntries: number;
    complete: boolean;
    /** Digest of the exact imported source pages or the retained-source manifest. */
    sourceDigest: string;
  };
  /** Optional immutable provider-owned event/source manifest. */
  evidence?: ObjectRef;
}
export interface StateOwnerOptions<Root> extends ObjectStoreOptions {
  validateRoot: (value: Root) => void;
  /** Must identify every legacy native state/checkpoint entry for this provider. */
  isLegacyEntry: (entry: SessionEntryView) => boolean;
  rootMaxBytes?: number;
  ancestryPageEntries?: number;
  bindingCacheEntries?: number;
}
export interface OwnedSnapshot<Root> {
  commitId: string;
  parentCommitId: string | null;
  rootRef: ObjectRef;
  /** Detached, recursively frozen canonical data. */
  root: Readonly<Root>;
  anchorId: string;
  scope: StateScope;
  origin: StateScope;
  durability: StateDurability;
  importReceipt?: ObjectRef;
}
export interface ResolutionCoverage { scanned: number; complete: boolean; legacySeen: boolean }
export type OwnerResolution<Root> =
  | { status: "ready"; snapshot: OwnedSnapshot<Root>; coverage: ResolutionCoverage }
  | { status: "pending"; scope: StateScope; continuation: string; coverage: ResolutionCoverage }
  | { status: "empty" | "legacy"; scope: StateScope; coverage: ResolutionCoverage };
export interface ResolveOptions { signal?: AbortSignal }
export interface CommitOptions {
  /** Null only after a proven empty/legacy resolution. */
  expectedCommitId: string | null;
  importReceipt?: ImportReceiptInput;
  /** Default requires a verified disk anchor. Volatile success is explicit opt-in. */
  durability?: "require-disk" | "allow-volatile";
  signal?: AbortSignal;
}
export interface OwnerStatus {
  providerId: StateProviderId;
  epoch: number;
  state: "unresolved" | "ready" | "pending" | "empty" | "legacy" | "uncertain" | "closed";
  commitId?: string;
  durability?: StateDurability;
  operationId?: string;
}
