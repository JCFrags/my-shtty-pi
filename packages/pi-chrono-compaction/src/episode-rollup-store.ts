import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as F, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson } from "./capsule-segment.js";
import { executeCatalogStoreRequest } from "./catalog-store.js";
import { CatalogSqlite, type SqlRow, type SqlValue } from "./catalog-sqlite.js";
import {
  EPISODE_STATE_LIMITS,
  type EpisodeRollupAfter,
  type EpisodeRollupHandle,
  type EpisodeStateRequest,
  type EpisodeStateResponse,
} from "./episode-state-contract.js";
import {
  readEpisodeRollupInputPage,
  type EpisodeRollupInputCursor,
  type EpisodeRollupInputPage,
  type EpisodeStateExecutionOptions,
} from "./episode-state-store.js";
import { withRuntimeMutex } from "./worker-runtime-mutex.js";

export const EPISODE_ROLLUP_SCHEMA_VERSION = 1 as const;
export const EPISODE_ROLLUP_RULESET_VERSION = "episode-rollup-exact-v3" as const;
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const num = (row: SqlRow, key: string): number => Number(row[key]);
const str = (row: SqlRow, key: string): string => String(row[key]);
const lineage = (request: EpisodeStateRequest): string => sha(canonicalJson({ branchKey: request.view.branchKey,
  segments: request.view.segments.map(item => item.segment) }));
const schema = [
  "CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, identity TEXT NOT NULL, searchRoute TEXT NOT NULL, capsuleRoute TEXT NOT NULL, catalogRoute TEXT NOT NULL, ruleset TEXT NOT NULL, generation INTEGER NOT NULL)",
  "CREATE TABLE heads (lineage TEXT PRIMARY KEY, view TEXT NOT NULL, stateGeneration INTEGER NOT NULL, cursor TEXT, complete INTEGER NOT NULL, rootNodeId TEXT, generation INTEGER NOT NULL)",
  "CREATE TABLE frontier (lineage TEXT NOT NULL, level INTEGER NOT NULL, nodeIds TEXT NOT NULL, PRIMARY KEY(lineage,level)) WITHOUT ROWID",
  "CREATE TABLE nodes (nodeId TEXT PRIMARY KEY, contentHash TEXT NOT NULL, nodeType TEXT NOT NULL, level INTEGER NOT NULL, orderedChildren TEXT NOT NULL, sourceCoverageHash TEXT NOT NULL, startEventSeq INTEGER NOT NULL, startDescriptor INTEGER NOT NULL, endEventSeq INTEGER NOT NULL, endDescriptor INTEGER NOT NULL, episodeKey TEXT, fragmentIndex INTEGER, body TEXT NOT NULL, createdGeneration INTEGER NOT NULL) WITHOUT ROWID",
  "CREATE TABLE publications (generation INTEGER PRIMARY KEY, lineage TEXT NOT NULL, branchKey TEXT NOT NULL, eventCut INTEGER NOT NULL, stateGeneration INTEGER NOT NULL, rootNodeId TEXT NOT NULL, complete INTEGER NOT NULL) WITHOUT ROWID",
  "CREATE INDEX publications_lineage ON publications(lineage,generation)",
];
const repairedPublicationIndex = "CREATE INDEX publications_cut ON publications(lineage,eventCut DESC,generation DESC)";
const REPAIR_ROOT = "rollup-repair-v1";

interface RepairActive { readonly v: 1; readonly storeId: string }
interface RepairStage extends RepairActive { readonly repairId: string; readonly expectedActiveStoreId: string | null; readonly viewHash: string; readonly identityHash: string;
  readonly stateGeneration: number; readonly processedCut: number; readonly processedMemoryCut: number }
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const storeIdValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const activeValid = (value: any): value is RepairActive => value?.v === 1 && storeIdValid(value.storeId);
const stageValid = (value: any): value is RepairStage => value?.v === 1 && storeIdValid(value.storeId) && typeof value.repairId === "string"
  && /^[A-Za-z0-9_.:-]{1,64}$/u.test(value.repairId) && (value.expectedActiveStoreId === null || storeIdValid(value.expectedActiveStoreId))
  && storeIdValid(value.viewHash) && storeIdValid(value.identityHash) && Number.isSafeInteger(value.stateGeneration) && value.stateGeneration > 0
  && Number.isSafeInteger(value.processedCut) && value.processedCut >= 0 && Number.isSafeInteger(value.processedMemoryCut) && value.processedMemoryCut >= value.processedCut;
function privateDir(path: string, create = false): Stats {
  if (resolve(path) !== path || path === "/") fail("search-v3-rollup-storage-unsafe");
  try { if (create) mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700)
    fail("search-v3-rollup-storage-unsafe");
  return stat;
}
function syncDir(path: string): void { const fd = openSync(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function safeRecord<T>(path: string, valid: (value: any) => value is T): T | undefined {
  privateDir(dirname(path)); let stat: Stats;
  try { stat = lstatSync(path); } catch (error) { if (missing(error)) return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600
    || stat.nlink !== 1 || stat.size < 2 || stat.size > 4096) fail("search-v3-rollup-pointer-unsafe");
  const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd); if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail("search-v3-rollup-pointer-changed");
    const bytes = Buffer.allocUnsafe(stat.size + 1), count = readSync(fd, bytes, 0, bytes.length, 0), final = fstatSync(fd);
    if (count !== stat.size || final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size)
      fail("search-v3-rollup-pointer-changed");
    const value = JSON.parse(bytes.subarray(0, count).toString("utf8"));
    if (!valid(value)) fail("search-v3-rollup-pointer-invalid");
    return value;
  } catch (error) { if (error instanceof SyntaxError) fail("search-v3-rollup-pointer-invalid"); throw error; }
  finally { closeSync(fd); }
}
function atomicRecord(path: string, value: unknown): void {
  const parent = privateDir(dirname(path)), bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 4096) fail("search-v3-rollup-pointer-limit");
  const temporary = join(dirname(path), `.pending-${randomUUID()}`); let fd: number | undefined;
  try {
    fd = openSync(temporary, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
    let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd); const made = fstatSync(fd);
    if (!made.isFile() || made.uid !== process.getuid?.() || (made.mode & 0o7777) !== 0o600 || made.nlink !== 1) fail("search-v3-rollup-pointer-unsafe");
    const now = privateDir(dirname(path)); if (now.dev !== parent.dev || now.ino !== parent.ino) fail("search-v3-rollup-pointer-changed");
    renameSync(temporary, path); syncDir(dirname(path));
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; } }
}
function repairPaths(searchDirectory: string): { root: string; stores: string; stages: string; active: string } {
  const root = join(searchDirectory, REPAIR_ROOT); return { root, stores: join(root, "stores"), stages: join(root, "stages"), active: join(root, "active.json") };
}
function prepareRepairPaths(searchDirectory: string): ReturnType<typeof repairPaths> {
  const paths = repairPaths(searchDirectory); privateDir(searchDirectory); privateDir(paths.root, true); privateDir(paths.stores, true); privateDir(paths.stages, true); return paths;
}
function repairStorePath(searchDirectory: string, storeId: string): string {
  if (!storeIdValid(storeId)) fail("search-v3-rollup-store-mismatch"); return join(repairPaths(searchDirectory).stores, `rollup-${storeId}.sqlite`);
}
function safeStoreFile(path: string): void {
  const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) fail("search-v3-rollup-storage-unsafe");
}

interface RollupRange { start: { eventSeq: number; descriptor: number }; end: { eventSeq: number; descriptor: number } }
interface RollupNodeBase {
  readonly schemaVersion: 1;
  readonly ruleset: typeof EPISODE_ROLLUP_RULESET_VERSION;
  readonly nodeType: "episode-fragment" | "rollup";
  readonly level: number;
  readonly orderedChildren: readonly string[];
  readonly sourceCoverageHash: string;
  readonly range: RollupRange;
  readonly summary: readonly string[];
  readonly protectedReferences: readonly Record<string, unknown>[];
  readonly omittedProtectedCount: number;
  readonly metadataHints: readonly Record<string, unknown>[];
  readonly omittedMetadataCount: number;
  readonly remainingDetail: "reachable-through-sources" | "reachable-through-children";
  readonly episodeCount: number;
  readonly memberCount: number;
}
interface EpisodeLeafNode extends RollupNodeBase {
  readonly nodeType: "episode-fragment";
  readonly episodeKey: string;
  readonly fragmentIndex: number;
  readonly episodeFragment: boolean;
  readonly closure: "next-episode-boundary";
  readonly objective: string;
  readonly objectiveEvidence: unknown;
  readonly sources: readonly Record<string, unknown>[];
}
interface InternalRollupNode extends RollupNodeBase { readonly nodeType: "rollup" }
type RollupNode = EpisodeLeafNode | InternalRollupNode;
type StoredNode = RollupNode & { readonly nodeId: string; readonly contentHash: string };

class Store {
  statements = 0;
  constructor(readonly db: CatalogSqlite, readonly request: EpisodeStateRequest,
    readonly storeId?: string, readonly indexedCut = false) {}
  get(sql: string, ...values: SqlValue[]): SqlRow | undefined { this.statements++; return this.db.prepare(sql).get(...values); }
  run(sql: string, ...values: SqlValue[]): void { this.statements++; this.db.prepare(sql).run(...values); }
  rows(sql: string, maximum: number, ...values: SqlValue[]): SqlRow[] { this.statements++; return [...this.db.prepare(sql).iterate(maximum, ...values)]; }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn); }
  validate(bootstrap: boolean): void {
    const exists = this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'");
    if (!exists) { if (bootstrap && !this.get("SELECT name FROM sqlite_master LIMIT 1")) return; fail("search-v3-rollup-version-mismatch"); }
    const meta = this.get("SELECT * FROM meta WHERE singleton=1");
    if (!meta || num(meta, "version") !== EPISODE_ROLLUP_SCHEMA_VERSION || str(meta, "identity") !== canonicalJson(this.request.identity)
      || str(meta, "searchRoute") !== this.request.searchDirectory || str(meta, "capsuleRoute") !== this.request.capsuleDirectory
      || str(meta, "catalogRoute") !== this.request.catalogDirectory || str(meta, "ruleset") !== EPISODE_ROLLUP_RULESET_VERSION)
      fail("search-v3-rollup-store-mismatch");
    for (const sql of schema) {
      const parts = sql.split(" "), name = parts[1] === "INDEX" ? parts[2]! : parts[2]!;
      if (this.get("SELECT sql FROM sqlite_master WHERE name=?", name)?.sql !== sql) fail("search-v3-rollup-version-mismatch");
    }
    if (this.indexedCut && this.get("SELECT sql FROM sqlite_master WHERE name='publications_cut'")?.sql !== repairedPublicationIndex)
      fail("search-v3-rollup-version-mismatch");
  }
  initialize(): void {
    this.transaction(() => {
      this.validate(true);
      if (!this.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")) {
        for (const sql of schema) this.run(sql);
        if (this.indexedCut) this.run(repairedPublicationIndex);
        this.run("INSERT INTO meta VALUES(1,?,?,?,?,?,?,0)", EPISODE_ROLLUP_SCHEMA_VERSION, canonicalJson(this.request.identity),
          this.request.searchDirectory, this.request.capsuleDirectory, this.request.catalogDirectory, EPISODE_ROLLUP_RULESET_VERSION);
      }
    });
  }
}

function nodeWithIdentity(node: RollupNode): StoredNode {
  const contentHash = sha(canonicalJson(node));
  return { ...node, nodeId: contentHash, contentHash };
}
function nodeBytes(node: StoredNode): number { return Buffer.byteLength(canonicalJson(node)); }
/** Keep structural recovery routes intact. If optional material does not fit,
 * remove it deterministically and make every protected/metadata gap explicit. */
function boundedNode(node: RollupNode): StoredNode {
  // Reserve compact navigation cues before optional copied detail. The exact
  // source and child routes remain authoritative when any copy is omitted.
  let summary = [...node.summary];
  const protectedReferences = [...node.protectedReferences], metadataHints = [...node.metadataHints];
  let omittedProtectedCount = node.omittedProtectedCount, omittedMetadataCount = node.omittedMetadataCount;
  while (true) {
    const candidate = nodeWithIdentity({ ...node, summary, protectedReferences, omittedProtectedCount,
      metadataHints, omittedMetadataCount } as RollupNode);
    if (nodeBytes(candidate) <= EPISODE_STATE_LIMITS.rollupNodeUtf8Bytes) return candidate;
    if (summary.some(text => text.length > 240)) { summary = summary.map(text => text.slice(0, 240)); continue; }
    if (metadataHints.length) { metadataHints.pop(); omittedMetadataCount++; continue; }
    if (protectedReferences.length) { protectedReferences.pop(); omittedProtectedCount++; continue; }
    if (summary.length) { summary.pop(); continue; }
    return fail("search-v3-rollup-node-limit");
  }
}
function nodeText(node: StoredNode): string {
  const text = canonicalJson(node);
  if (Buffer.byteLength(text) > EPISODE_STATE_LIMITS.rollupNodeUtf8Bytes) fail("search-v3-rollup-node-limit");
  return text;
}
function writeNode(store: Store, node: StoredNode, generation: number): boolean {
  const text = nodeText(node), old = store.get("SELECT body FROM nodes WHERE nodeId=?", node.nodeId);
  if (old) { if (str(old, "body") !== text) fail("search-v3-rollup-node-corrupt"); return false; }
  store.run("INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", node.nodeId, node.contentHash, node.nodeType, node.level,
    canonicalJson(node.orderedChildren), node.sourceCoverageHash, node.range.start.eventSeq, node.range.start.descriptor,
    node.range.end.eventSeq, node.range.end.descriptor, node.nodeType === "episode-fragment" ? node.episodeKey : null,
    node.nodeType === "episode-fragment" ? node.fragmentIndex : null, text, generation);
  return true;
}
function loadNode(store: Store, nodeId: string): StoredNode {
  const row = store.get("SELECT body,contentHash FROM nodes WHERE nodeId=?", nodeId);
  if (!row) fail("search-v3-rollup-node-missing");
  let node: StoredNode; try { node = JSON.parse(str(row!, "body")) as StoredNode; } catch { return fail("search-v3-rollup-node-corrupt"); }
  const { nodeId: ignoredId, contentHash: ignoredHash, ...base } = node;
  if (ignoredId !== nodeId || ignoredHash !== nodeId || str(row!, "contentHash") !== nodeId || sha(canonicalJson(base)) !== nodeId)
    fail("search-v3-rollup-node-corrupt");
  return node;
}
function boundedUnique(items: readonly Record<string, unknown>[], key: string, maximum: number): { kept: Record<string, unknown>[]; omitted: number } {
  const seen = new Set<string>(), kept: Record<string, unknown>[] = [];
  for (const item of items) {
    const id = String(item[key] ?? canonicalJson(item));
    if (seen.has(id)) continue;
    seen.add(id);
    if (kept.length < maximum) kept.push(item);
  }
  return { kept, omitted: Math.max(0, seen.size - kept.length) };
}
function leafFrom(page: NonNullable<EpisodeRollupInputPage["episode"]>): StoredNode {
  const sources = page.members.map(member => ({ eventSeq: member.eventSeq, descriptor: member.descriptor, sourceKey: member.sourceKey,
    source: member.source, exactBodyHash: member.exactBody === undefined ? undefined : sha(member.exactBody), exactBodyOmitted: member.exactBodyOmitted }));
  const summary = page.members.map(member => `event ${member.eventSeq}:${member.descriptor}: ${member.exactBody ?? member.cue}`)
    .map(text => text.replace(/\s+/gu, " ").trim().slice(0, 2048));
  const base: EpisodeLeafNode = { schemaVersion: 1, ruleset: EPISODE_ROLLUP_RULESET_VERSION, nodeType: "episode-fragment", level: 0,
    orderedChildren: [], sourceCoverageHash: sha(canonicalJson(sources.map(source => ({ sourceKey: source.sourceKey, exactBodyHash: source.exactBodyHash })))),
    range: page.start.eventSeq <= page.end.eventSeq ? { start: page.start, end: page.end } : fail("search-v3-rollup-input-invalid"),
    summary, protectedReferences: page.protected as unknown as Record<string, unknown>[], omittedProtectedCount: page.omittedProtectedCount,
    metadataHints: page.metadata as unknown as Record<string, unknown>[], omittedMetadataCount: page.omittedMetadataCount,
    remainingDetail: "reachable-through-sources", episodeCount: page.fragmentIndex === 0 ? 1 : 0, memberCount: page.members.length,
    episodeKey: page.episodeKey, fragmentIndex: page.fragmentIndex, episodeFragment: page.episodeFragment,
    closure: page.closure, objective: page.objective, objectiveEvidence: page.objectiveEvidence, sources };
  return boundedNode(base);
}
function parentFrom(children: readonly StoredNode[]): StoredNode {
  if (!children.length || children.length > EPISODE_STATE_LIMITS.rollupFanout) fail("search-v3-rollup-frontier-invalid");
  const protectedSelected = boundedUnique(children.flatMap(child => child.protectedReferences), "stableKey", EPISODE_STATE_LIMITS.rollupProtectedPerNode);
  const metadataSelected = boundedUnique(children.flatMap(child => child.metadataHints), "stableKey", EPISODE_STATE_LIMITS.rollupMetadataPerNode);
  const base: InternalRollupNode = { schemaVersion: 1, ruleset: EPISODE_ROLLUP_RULESET_VERSION, nodeType: "rollup",
    level: Math.max(...children.map(child => child.level)) + 1, orderedChildren: children.map(child => child.nodeId),
    sourceCoverageHash: sha(canonicalJson(children.map(child => child.sourceCoverageHash))),
    range: { start: children[0]!.range.start, end: children.at(-1)!.range.end },
    // Keep a cue from each child, rather than spending every slot on the first
    // child's descendants. This is a navigation sample, not a full summary.
    summary: children.map(child => recallSummary(child)[0]!).map(text => text.slice(0, 2048)),
    protectedReferences: protectedSelected.kept,
    omittedProtectedCount: children.reduce((sum, child) => sum + child.omittedProtectedCount, 0) + protectedSelected.omitted,
    metadataHints: metadataSelected.kept,
    omittedMetadataCount: children.reduce((sum, child) => sum + child.omittedMetadataCount, 0) + metadataSelected.omitted,
    remainingDetail: "reachable-through-children", episodeCount: children.reduce((sum, child) => sum + child.episodeCount, 0),
    memberCount: children.reduce((sum, child) => sum + child.memberCount, 0) };
  return boundedNode(base);
}
function frontier(store: Store, line: string): Map<number, string[]> {
  return new Map(store.rows("SELECT level,nodeIds FROM frontier WHERE lineage=? ORDER BY level", EPISODE_STATE_LIMITS.rollupTreeLevels, line)
    .map(row => [num(row, "level"), JSON.parse(str(row, "nodeIds")) as string[]]));
}
function saveFrontier(store: Store, line: string, value: Map<number, string[]>): void {
  store.run("DELETE FROM frontier WHERE lineage=?", line);
  for (const [level, ids] of [...value].sort((a, b) => a[0] - b[0])) store.run("INSERT INTO frontier VALUES(?,?,?)", line, level, canonicalJson(ids));
}
function appendFrontier(store: Store, value: Map<number, string[]>, leaf: StoredNode, generation: number, created: { count: number }): void {
  let level = 0, node = leaf;
  while (true) {
    if (level >= EPISODE_STATE_LIMITS.rollupTreeLevels) fail("search-v3-rollup-tree-limit");
    const ids = [...(value.get(level) ?? []), node.nodeId];
    if (ids.length < EPISODE_STATE_LIMITS.rollupFanout) { value.set(level, ids); return; }
    if (ids.length !== EPISODE_STATE_LIMITS.rollupFanout) fail("search-v3-rollup-frontier-invalid");
    value.delete(level);
    node = parentFrom(ids.map(id => loadNode(store, id)));
    if (writeNode(store, node, generation)) created.count++;
    level++;
  }
}
function buildRoot(store: Store, value: Map<number, string[]>, generation: number, created: { count: number }): StoredNode | undefined {
  let nodes = [...value.values()].flatMap(ids => ids.map(id => loadNode(store, id)))
    .sort((a, b) => a.range.start.eventSeq - b.range.start.eventSeq || a.range.start.descriptor - b.range.start.descriptor
      || a.range.end.eventSeq - b.range.end.eventSeq || a.range.end.descriptor - b.range.end.descriptor || b.level - a.level
      || (a.nodeType === "episode-fragment" ? a.fragmentIndex : 0) - (b.nodeType === "episode-fragment" ? b.fragmentIndex : 0)
      || a.nodeId.localeCompare(b.nodeId));
  if (!nodes.length) return undefined;
  if (nodes.length === 1) {
    const root = parentFrom(nodes);
    if (writeNode(store, root, generation)) created.count++;
    return root;
  }
  while (nodes.length > 1) {
    const next: StoredNode[] = [];
    for (let at = 0; at < nodes.length; at += EPISODE_STATE_LIMITS.rollupFanout) {
      const parent = parentFrom(nodes.slice(at, at + EPISODE_STATE_LIMITS.rollupFanout));
      if (writeNode(store, parent, generation)) created.count++;
      next.push(parent);
    }
    nodes = next;
  }
  return nodes[0];
}
function handle(request: EpisodeStateRequest, row: SqlRow, store?: Store): EpisodeRollupHandle {
  return { schemaVersion: 1, ...(store?.storeId ? { storeId: store.storeId } : {}), ruleset: EPISODE_ROLLUP_RULESET_VERSION, branchKey: request.view.branchKey, eventCut: num(row, "eventCut"),
    stateGeneration: num(row, "stateGeneration"), rollupGeneration: num(row, "generation"), rootNodeId: str(row, "rootNodeId") };
}
function compatibleView(current: EpisodeStateRequest["view"], old: EpisodeStateRequest["view"]): boolean {
  return current.branchKey === old.branchKey && current.eventCut >= old.eventCut && current.segments.length >= old.segments.length
    && old.segments.every((item, index) => current.segments[index]?.segment === item.segment && current.segments[index]!.cut >= item.cut);
}
function withoutSnapshot(cursor: EpisodeRollupInputCursor | undefined): EpisodeRollupInputCursor | undefined {
  if (!cursor) return undefined;
  const { snapshot: ignored, ...position } = cursor;
  return position;
}
type RemainingWork = "state-catch-up" | "eligible-episodes" | "no-eligible-episode" | "none";
function remainingWork(requestedCut: number, processedCut: number, exhausted: boolean, addedLeaves: number): RemainingWork {
  if (!exhausted) return "eligible-episodes";
  if (processedCut < requestedCut) return "state-catch-up";
  return addedLeaves === 0 ? "no-eligible-episode" : "none";
}
async function materialize(request: Extract<EpisodeStateRequest, { op: "materializeRollup" }>, store: Store,
  options: EpisodeStateExecutionOptions, budget: { bytes: number }): Promise<Record<string, unknown>> {
  const line = lineage(request), head = store.get("SELECT * FROM heads WHERE lineage=?", line);
  if (head && !compatibleView(request.view, JSON.parse(str(head, "view")))) fail("search-v3-rollup-view-incompatible");
  let cursor = head?.cursor ? JSON.parse(str(head, "cursor")) as EpisodeRollupInputCursor : undefined;
  // A completed cycle retains its chronological position but deliberately repins state and source view for appended work.
  if (head && num(head, "complete") === 1) cursor = withoutSnapshot(cursor);
  else if (head && cursor && !cursor.snapshot) {
    // Continue pre-correction rollup-v1 progress without rewriting its frontier or immutable nodes.
    const oldView = JSON.parse(str(head, "view")) as EpisodeStateRequest["view"];
    const oldPublication = store.get("SELECT eventCut FROM publications WHERE lineage=? AND generation=?", line, num(head, "generation"));
    const oldProcessedCut = oldPublication ? num(oldPublication, "eventCut") : 0;
    cursor = { ...cursor, snapshot: { stateGeneration: num(head, "stateGeneration"), requestedCut: oldView.eventCut,
      processedCut: oldProcessedCut, processedMemoryCut: oldProcessedCut, sourceView: oldView } };
  }
  const maximum = request.limit ?? EPISODE_STATE_LIMITS.rollupLeavesPerJob, pages: EpisodeRollupInputPage[] = [];
  let exhausted = false, stateGeneration = head ? num(head, "stateGeneration") : 0, requestedCut = request.view.eventCut,
    processedCut = 0, processedMemoryCut = 0;
  for (let count = 0; count < maximum; count++) {
    const page = await readEpisodeRollupInputPage(request, cursor, options, budget);
    stateGeneration = page.stateGeneration; requestedCut = page.requestedCut; processedCut = page.processedCut;
    processedMemoryCut = page.processedMemoryCut;
    if (!page.episode) { cursor = page.next; exhausted = true; break; }
    pages.push(page); cursor = page.next;
    if (!cursor) fail("search-v3-rollup-input-invalid");
  }
  if (!exhausted && pages.length < maximum) exhausted = true;
  const generation = num(store.get("SELECT generation FROM meta WHERE singleton=1")!, "generation") + 1;
  const value = frontier(store, line), created = { count: 0 };
  let root: StoredNode | undefined;
  store.transaction(() => {
    for (const page of pages) {
      const leaf = leafFrom(page.episode!);
      if (writeNode(store, leaf, generation)) created.count++;
      appendFrontier(store, value, leaf, generation, created);
    }
    root = buildRoot(store, value, generation, created);
    if (created.count > EPISODE_STATE_LIMITS.rollupNodesPerJob) fail("search-v3-rollup-job-node-limit");
    saveFrontier(store, line, value);
    store.run("UPDATE meta SET generation=? WHERE singleton=1", generation);
    store.run("INSERT OR REPLACE INTO heads VALUES(?,?,?,?,?,?,?)", line, canonicalJson(request.view), stateGeneration,
      cursor ? canonicalJson(cursor) : null, exhausted ? 1 : 0, root?.nodeId ?? null, generation);
    if (root) store.run("INSERT INTO publications VALUES(?,?,?,?,?,?,?)", generation, line, request.view.branchKey, processedCut,
      stateGeneration, root.nodeId, exhausted ? 1 : 0);
  });
  const publication = root ? store.get("SELECT * FROM publications WHERE generation=?", generation) : undefined;
  const pending = remainingWork(requestedCut, processedCut, exhausted, pages.length);
  const representedClosedRange = root ? root.range : null;
  return { readiness: root ? exhausted ? "ready" : "partial" : "missing", rollupGeneration: generation, stateGeneration,
    branchKey: request.view.branchKey, requestedCut, processedCut, processedMemoryCut, knownThroughCut: processedCut, complete: exhausted,
    closedIntervalsOnly: true, representedClosedRange, closedThroughCut: root?.range.end.eventSeq ?? 0, excludedOpenTail: Boolean(root),
    remainingWork: pending, noEligibleEpisode: pages.length === 0,
    ...(publication ? { handle: handle(request, publication, store), rootReference: { kind: "rollup-node", handle: handle(request, publication, store), nodeId: root!.nodeId, path: [root!.nodeId] } } : {}),
    next: cursor, metrics: { leafPages: pages.length, nodesCreated: created.count, sqliteStatements: store.statements } };
}
function publicationFor(request: Extract<EpisodeStateRequest, { op: "recallRollup" | "composeRollupSelection" }>, store: Store): SqlRow {
  const line = lineage(request), generation = request.handle?.rollupGeneration
    ?? (request.op === "recallRollup" ? request.generation : undefined);
  if (!generation) fail("search-v3-rollup-generation-required");
  const row = store.get("SELECT * FROM publications WHERE lineage=? AND generation=?", line, generation!);
  if (!row || num(row, "eventCut") > request.view.eventCut || str(row, "branchKey") !== request.view.branchKey
    || request.handle && (request.handle.rootNodeId !== str(row, "rootNodeId") || request.handle.stateGeneration !== num(row, "stateGeneration")
    || request.handle.eventCut !== num(row, "eventCut") || request.handle.branchKey !== str(row, "branchKey"))) fail("search-v3-rollup-publication-missing");
  return row!;
}
function matches(node: StoredNode, query: string | undefined): boolean {
  if (!query) return true;
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_./:+-]{2,}/gu) ?? [];
  const text = canonicalJson({ summary: node.summary, protected: node.protectedReferences, metadata: node.metadataHints }).toLowerCase();
  return terms.some(term => text.includes(term));
}
function matchScore(node: StoredNode, query: string): number {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_./:+-]{2,}/gu) ?? [])];
  const text = canonicalJson({ summary: node.summary, protected: node.protectedReferences, metadata: node.metadataHints }).toLowerCase();
  return terms.reduce((score, term) => score + Number(text.includes(term)), 0);
}
function recallSummary(node: RollupNode): string[] {
  const stored = node.summary.filter(text => text.trim().length > 0);
  if (stored.length) return stored;
  // Old immutable nodes can have an evicted summary. Reuse only their own
  // bounded source-linked evidence. This read path never rewrites a node.
  const excerpts: string[] = [];
  if (node.nodeType === "episode-fragment" && node.objective.trim()) excerpts.push(node.objective);
  for (const item of [...node.protectedReferences, ...node.metadataHints]) {
    const evidence = item.evidence as { exactText?: unknown; source?: { eventSeq?: unknown; descriptor?: unknown } } | undefined;
    if (typeof evidence?.exactText !== "string" || !evidence.exactText.trim()) continue;
    const source = evidence.source;
    const at = typeof source?.eventSeq === "number" ? `event ${source.eventSeq}:${source.descriptor ?? 0}: ` : "";
    excerpts.push(`${at}${evidence.exactText}`.replace(/\s+/gu, " ").trim().slice(0, 240));
    if (excerpts.length >= EPISODE_STATE_LIMITS.rollupFanout) break;
  }
  return excerpts.length ? excerpts : [`Historical events ${node.range.start.eventSeq}..${node.range.end.eventSeq}. Topic cue unavailable; expand for source detail.`];
}
function nodeReference(h: EpisodeRollupHandle, node: StoredNode, path: readonly string[]): Record<string, unknown> {
  return { kind: "rollup-node", handle: h, nodeId: node.nodeId, path, nodeType: node.nodeType, level: node.level,
    range: node.range, sourceCoverageHash: node.sourceCoverageHash };
}
function verifiedPath(store: Store, rootId: string, targetId: string, supplied: readonly string[] | undefined): { path: string[]; visited: number } {
  if (targetId === rootId) {
    if (supplied && (supplied.length !== 1 || supplied[0] !== rootId)) fail("search-v3-rollup-path-invalid");
    return { path: [rootId], visited: 0 };
  }
  if (!supplied || supplied.length < 2 || supplied.length > EPISODE_STATE_LIMITS.rollupTreeLevels
    || supplied[0] !== rootId || supplied.at(-1) !== targetId) fail("search-v3-rollup-path-invalid");
  const route = [...supplied!];
  for (let index = 0; index < route.length - 1; index++) {
    const parent = loadNode(store, route[index]!);
    if (!parent.orderedChildren.includes(route[index + 1]!)) fail("search-v3-rollup-path-invalid");
  }
  return { path: route, visited: route.length - 1 };
}
function episodeItem(h: EpisodeRollupHandle, node: EpisodeLeafNode & { readonly nodeId: string }, path: readonly string[]): Record<string, unknown> {
  return { reference: { kind: "episode", handle: h, nodeId: node.nodeId, path, episodeKey: node.episodeKey,
    fragmentIndex: node.fragmentIndex, episodeFragment: node.episodeFragment, closure: node.closure, boundaries: node.range },
    summary: recallSummary(node), cuePartial: true, objective: node.objective, protectedReferences: node.protectedReferences,
    omittedProtectedCount: node.omittedProtectedCount, metadataHints: node.metadataHints, omittedMetadataCount: node.omittedMetadataCount,
    remainingDetail: node.remainingDetail };
}
/** Select relevant historical nodes top-down. Selected nodes stop descent, so
 * query work is bounded by actual node reads rather than history size. */
function composeRollupSelection(request: Extract<EpisodeStateRequest, { op: "composeRollupSelection" }>, store: Store): Record<string, unknown> {
  const publication = publicationFor(request, store), h = handle(request, publication, store);
  let nodesRead = 0;
  const readNode = (nodeId: string): StoredNode => {
    if (nodesRead >= EPISODE_STATE_LIMITS.rollupNodesPerRecall) fail("search-v3-rollup-node-limit");
    nodesRead++;
    return loadNode(store, nodeId);
  };
  const root = readNode(h.rootNodeId), limit = request.limit ?? Math.min(4, EPISODE_STATE_LIMITS.page);
  const queue: Array<{ node: StoredNode; path: string[]; score: number }> = [{ node: root, path: [root.nodeId], score: matchScore(root, request.query) }];
  const selected: Array<{ node: StoredNode; path: string[] }> = [];
  let visited = 0, traversalLimited = false;
  while (queue.length && selected.length < limit) {
    const current = queue.shift()!; visited++;
    if (current.node.range.end.eventSeq < request.beforeEventSeq && current.score > 0) {
      selected.push(current);
      continue;
    }
    if (current.node.nodeType === "episode-fragment") continue;
    const children: Array<{ node: StoredNode; path: string[]; score: number }> = [];
    for (const id of current.node.orderedChildren) {
      if (nodesRead >= EPISODE_STATE_LIMITS.rollupNodesPerRecall) { traversalLimited = true; break; }
      const node = readNode(id);
      if (node.range.start.eventSeq >= request.beforeEventSeq) continue;
      children.push({ node, path: [...current.path, id], score: matchScore(node, request.query) });
    }
    children.sort((a, b) => b.score - a.score || b.node.level - a.node.level
      || a.node.range.start.eventSeq - b.node.range.start.eventSeq || a.node.nodeId.localeCompare(b.node.nodeId));
    queue.push(...children);
    if (traversalLimited) break;
  }
  if (queue.length && selected.length >= limit) traversalLimited = true;
  selected.sort((a, b) => a.node.range.start.eventSeq - b.node.range.start.eventSeq
    || a.node.range.end.eventSeq - b.node.range.end.eventSeq || a.node.nodeId.localeCompare(b.node.nodeId));
  const items = selected.map(item => ({ reference: nodeReference(h, item.node, item.path), nodeId: item.node.nodeId,
    nodeType: item.node.nodeType, path: item.path, range: item.node.range, summary: item.node.summary,
    remainingDetail: item.node.remainingDetail }));
  const partialReasons = traversalLimited ? ["bounded-node-traversal"] : [];
  let responseLimited = false;
  const build = (): Record<string, unknown> => ({ handle: h, representedRange: root.range,
    publicationComplete: num(publication, "complete") === 1, selectionPartial: traversalLimited || responseLimited, partialReasons,
    items, noQueryHit: items.length === 0,
    metrics: { nodesRead, nodesVisited: visited, nodeLimit: EPISODE_STATE_LIMITS.rollupNodesPerRecall, selectedNodeLimit: limit,
      sqliteStatements: store.statements } });
  while (items.length > 1 && Buffer.byteLength(JSON.stringify(build())) > EPISODE_STATE_LIMITS.responseBytes - 4096) {
    items.pop(); responseLimited = true;
    if (!partialReasons.includes("response-budget")) partialReasons.push("response-budget");
  }
  return build();
}

function recall(request: Extract<EpisodeStateRequest, { op: "recallRollup" }>, store: Store): Record<string, unknown> {
  const publication = publicationFor(request, store), h = handle(request, publication, store), rootId = str(publication, "rootNodeId");
  const targetId = request.nodeId ?? rootId, route = verifiedPath(store, rootId, targetId, request.path);
  const target = loadNode(store, targetId), level = request.level ?? "root", limit = request.limit ?? EPISODE_STATE_LIMITS.page;
  const queryHash = sha(canonicalJson({ query: request.query?.trim() ?? "", level, nodeId: targetId, path: route.path,
    view: { branchKey: request.view.branchKey, eventCut: request.view.eventCut } }));
  if (request.after && (request.after.generation !== h.rollupGeneration || request.after.nodeId !== targetId
    || request.after.level !== level || request.after.queryHash !== queryHash)) fail("search-v3-rollup-cursor-invalid");
  const start = request.after?.itemIndex ?? 0, wanted = Math.min(EPISODE_STATE_LIMITS.rollupNodesPerRecall, start + limit + 1);
  let visited = route.visited + 1, traversalLimited = false;
  const candidates: Array<{ node: StoredNode; path: string[] }> = [];
  if (level === "root" || level === "child") {
    if (target.nodeType !== "rollup") fail("search-v3-rollup-level-invalid");
    for (const id of target.orderedChildren) {
      if (visited >= EPISODE_STATE_LIMITS.rollupNodesPerRecall) { traversalLimited = true; break; }
      candidates.push({ node: loadNode(store, id), path: [...route.path, id] }); visited++;
    }
  } else if (!(level === "source" && target.nodeType === "episode-fragment")) {
    const queue: Array<{ node: StoredNode; path: string[] }> = [{ node: target, path: route.path }];
    while (queue.length && candidates.length < wanted) {
      const current = queue.shift()!;
      if (current.node.nodeType === "episode-fragment") { if (matches(current.node, request.query)) candidates.push(current); continue; }
      if (visited + current.node.orderedChildren.length > EPISODE_STATE_LIMITS.rollupNodesPerRecall) { traversalLimited = true; break; }
      const children = current.node.orderedChildren.map(id => ({ node: loadNode(store, id), path: [...current.path, id] }));
      visited += children.length;
      children.sort((a, b) => Number(matches(b.node, request.query)) - Number(matches(a.node, request.query))
        || a.node.range.start.eventSeq - b.node.range.start.eventSeq || a.node.nodeId.localeCompare(b.node.nodeId));
      queue.push(...children);
    }
  }
  let allItems: Record<string, unknown>[];
  if (level === "root" || level === "child") allItems = candidates.map(item => ({ reference: nodeReference(h, item.node, item.path),
    summary: recallSummary(item.node), cuePartial: true, episodeCount: item.node.episodeCount, memberCount: item.node.memberCount,
    protectedCount: item.node.protectedReferences.length, omittedProtectedCount: item.node.omittedProtectedCount,
    metadataHintCount: item.node.metadataHints.length, omittedMetadataCount: item.node.omittedMetadataCount,
    remainingDetail: item.node.remainingDetail }));
  else if (level === "episode") allItems = candidates.filter((item): item is { node: EpisodeLeafNode & StoredNode; path: string[] } => item.node.nodeType === "episode-fragment")
    .map(item => episodeItem(h, item.node, item.path));
  else if (target.nodeType === "episode-fragment") allItems = target.sources.map(source => ({ reference: { kind: "exact-source",
    parentReference: episodeItem(h, target, route.path).reference, sourceKey: source.sourceKey }, source: source.source,
    cue: target.summary.find(text => text.startsWith(`event ${source.eventSeq}:${source.descriptor}: `)) ?? "Exact source; use recovery for text.",
    cuePartial: true, exactBodyHash: source.exactBodyHash, exactBodyOmitted: source.exactBodyOmitted }));
  else allItems = candidates.filter((item): item is { node: EpisodeLeafNode & StoredNode; path: string[] } => item.node.nodeType === "episode-fragment")
    .flatMap(item => item.node.sources.map(source => ({ reference: { kind: "exact-source", parentReference: episodeItem(h, item.node, item.path).reference,
      sourceKey: source.sourceKey }, source: source.source,
      cue: item.node.summary.find(text => text.startsWith(`event ${source.eventSeq}:${source.descriptor}: `)) ?? "Exact source; use recovery for text.",
      cuePartial: true, exactBodyHash: source.exactBodyHash, exactBodyOmitted: source.exactBodyOmitted })))
    .slice(0, EPISODE_STATE_LIMITS.rollupNodesPerRecall);
  const selected = allItems.slice(start, start + limit);
  const build = (): Record<string, unknown> => {
  const more = start + selected.length < allItems.length;
  const partialReasons = [...(more ? ["pagination"] : []), ...(traversalLimited ? ["bounded-node-traversal"] : [])];
  return { handle: h, parentReference: { ...nodeReference(h, target, route.path), requestedLevel: level, query: request.query },
    level, node: { summary: recallSummary(target), cuePartial: true, episodeCount: target.episodeCount, memberCount: target.memberCount,
      protectedCount: target.protectedReferences.length, omittedProtectedCount: target.omittedProtectedCount,
      metadataHintCount: target.metadataHints.length, omittedMetadataCount: target.omittedMetadataCount, remainingDetail: target.remainingDetail },
    items: selected, ...(more ? { next: { nodeId: target.nodeId, itemIndex: start + selected.length, generation: h.rollupGeneration,
      level, queryHash } satisfies EpisodeRollupAfter } : {}), partial: partialReasons.length > 0, partialReasons,
    metrics: { nodesVisited: visited, nodeLimit: EPISODE_STATE_LIMITS.rollupNodesPerRecall, sqliteStatements: store.statements } };
  };
  // A legal count can still exceed the byte envelope. Preserve exact pagination
  // instead of refusing a page containing several individually valid large nodes.
  while (selected.length > 1 && Buffer.byteLength(JSON.stringify(build())) > EPISODE_STATE_LIMITS.responseBytes - 4096) selected.pop();
  return build();
}
function status(request: Extract<EpisodeStateRequest, { op: "rollupStatus" }>, store: Store): Record<string, unknown> {
  const head = store.get("SELECT * FROM heads WHERE lineage=?", lineage(request));
  if (!head) return { readiness: "missing", rollupGeneration: num(store.get("SELECT generation FROM meta WHERE singleton=1")!, "generation"),
    branchKey: request.view.branchKey, requestedCut: request.view.eventCut, processedCut: 0, processedMemoryCut: 0, knownThroughCut: 0,
    complete: false, closedIntervalsOnly: true, representedClosedRange: null, remainingWork: "state-catch-up", noEligibleEpisode: true,
    metrics: { sqliteStatements: store.statements } };
  const cursor = head.cursor ? JSON.parse(str(head, "cursor")) as EpisodeRollupInputCursor : undefined;
  const snapshot = cursor?.snapshot;
  if (!head.rootNodeId) {
    const processedCut = snapshot?.processedCut ?? 0, processedMemoryCut = snapshot?.processedMemoryCut ?? processedCut;
    const complete = num(head, "complete") === 1;
    return { readiness: "missing", rollupGeneration: num(head, "generation"), stateGeneration: num(head, "stateGeneration"),
      branchKey: request.view.branchKey, requestedCut: request.view.eventCut, processedCut, processedMemoryCut, knownThroughCut: processedCut,
      complete, closedIntervalsOnly: true, representedClosedRange: null,
      remainingWork: remainingWork(request.view.eventCut, processedCut, complete, 0), noEligibleEpisode: true, cursor,
      metrics: { sqliteStatements: store.statements } };
  }
  const publication = store.indexedCut
    ? store.get("SELECT * FROM publications WHERE lineage=? AND eventCut<=? ORDER BY eventCut DESC,generation DESC LIMIT 1", lineage(request), request.view.eventCut)
    : store.get("SELECT * FROM publications WHERE generation=?", num(head, "generation"));
  const publicationRow = publication ?? fail("search-v3-rollup-publication-missing");
  if (str(publicationRow, "branchKey") !== request.view.branchKey || num(publicationRow, "eventCut") > request.view.eventCut)
    return { readiness: "incompatible", rollupGeneration: num(publicationRow, "generation"), branchKey: request.view.branchKey,
      requestedCut: request.view.eventCut, processedCut: 0, processedMemoryCut: 0, knownThroughCut: 0, complete: false,
      closedIntervalsOnly: true, representedClosedRange: null, remainingWork: "state-catch-up", noEligibleEpisode: true,
      metrics: { sqliteStatements: store.statements } };
  const h = handle(request, publicationRow, store), root = loadNode(store, h.rootNodeId), complete = num(publicationRow, "complete") === 1;
  const selectedIsHead = num(publicationRow, "generation") === num(head, "generation");
  const rootRow = store.get("SELECT createdGeneration FROM nodes WHERE nodeId=?", h.rootNodeId);
  const noEligibleEpisode = complete && Boolean(rootRow) && num(rootRow!, "createdGeneration") < h.rollupGeneration;
  return { readiness: complete ? "ready" : "partial", rollupGeneration: h.rollupGeneration,
    stateGeneration: h.stateGeneration, branchKey: h.branchKey, requestedCut: request.view.eventCut, processedCut: h.eventCut,
    processedMemoryCut: selectedIsHead ? snapshot?.processedMemoryCut ?? h.eventCut : h.eventCut, knownThroughCut: h.eventCut, complete,
    closedIntervalsOnly: true, representedClosedRange: root.range, closedThroughCut: root.range.end.eventSeq,
    excludedOpenTail: true, remainingWork: remainingWork(request.view.eventCut, h.eventCut, complete, noEligibleEpisode ? 0 : 1), noEligibleEpisode,
    handle: h, rootReference: { kind: "rollup-node", handle: h, nodeId: h.rootNodeId, path: [h.rootNodeId] },
    ...(selectedIsHead ? { cursor } : {}), metrics: { sqliteStatements: store.statements } };
}

function activeStoreId(searchDirectory: string): string | null {
  const paths = repairPaths(searchDirectory);
  try { lstatSync(paths.root); } catch (error) { if (missing(error)) return null; throw error; }
  privateDir(paths.root); privateDir(paths.stores); privateDir(paths.stages);
  return safeRecord(paths.active, activeValid)?.storeId ?? null;
}
function repairStage(request: Extract<EpisodeStateRequest, { op: "repairRollup" }>, create: boolean,
  snapshot?: Pick<EpisodeRollupInputPage, "stateGeneration" | "processedCut" | "processedMemoryCut">): { paths: ReturnType<typeof repairPaths>; stage: RepairStage } {
  const paths = create ? prepareRepairPaths(request.searchDirectory) : repairPaths(request.searchDirectory);
  if (!create) { privateDir(paths.root); privateDir(paths.stores); privateDir(paths.stages); }
  const path = join(paths.stages, `${sha(request.repairId)}.json`);
  const identityHash = sha(canonicalJson(request.identity)), viewHash = sha(canonicalJson(request.view));
  let stage = safeRecord(path, stageValid);
  if (!stage && create) {
    if (!snapshot) fail("search-v3-rollup-state-not-ready");
    const selectedSnapshot = snapshot as Pick<EpisodeRollupInputPage, "stateGeneration" | "processedCut" | "processedMemoryCut">;
    const expectedActiveStoreId = safeRecord(paths.active, activeValid)?.storeId ?? null;
    stage = { v: 1, repairId: request.repairId,
      storeId: sha(canonicalJson({ repairId: request.repairId, identityHash, viewHash, stateGeneration: selectedSnapshot.stateGeneration,
        processedCut: selectedSnapshot.processedCut, processedMemoryCut: selectedSnapshot.processedMemoryCut, ruleset: EPISODE_ROLLUP_RULESET_VERSION })),
      expectedActiveStoreId, viewHash, identityHash, stateGeneration: selectedSnapshot.stateGeneration,
      processedCut: selectedSnapshot.processedCut, processedMemoryCut: selectedSnapshot.processedMemoryCut };
    atomicRecord(path, stage);
  }
  if (!stage) fail("search-v3-rollup-repair-missing");
  const selected = stage as RepairStage;
  if (selected.repairId !== request.repairId || selected.identityHash !== identityHash || selected.viewHash !== viewHash)
    fail("search-v3-rollup-repair-mismatch");
  return { paths, stage: selected };
}
async function repair(request: Extract<EpisodeStateRequest, { op: "repairRollup" }>, options: EpisodeStateExecutionOptions,
  budget: { bytes: number }): Promise<Record<string, unknown>> {
  const snapshot = request.action === "start" ? await readEpisodeRollupInputPage(request, undefined, options, budget) : undefined;
  const { paths, stage } = repairStage(request, request.action === "start", snapshot), path = repairStorePath(request.searchDirectory, stage.storeId);
  const openStore = (create: boolean): { db: CatalogSqlite; store: Store } => {
    if (!create) safeStoreFile(path);
    const validate = (candidate: CatalogSqlite): void => new Store(candidate, request, stage.storeId, true).validate(create);
    const db = create ? CatalogSqlite.create(path, validate) : CatalogSqlite.open(path, validate);
    const store = new Store(db, request, stage.storeId, true); if (create) {
      store.initialize();
      if (!store.get("SELECT lineage FROM heads WHERE lineage=?", lineage(request))) {
        const cursor: EpisodeRollupInputCursor = { episodeStartEventSeq: 0, episodeStartDescriptor: 0, episodeKey: "", memberEventSeq: 0,
          memberDescriptor: 0, memberSourceKey: "", episodeComplete: true, fragmentIndex: 0,
          snapshot: { stateGeneration: stage.stateGeneration, requestedCut: request.view.eventCut, processedCut: stage.processedCut,
            processedMemoryCut: stage.processedMemoryCut, sourceView: request.view } };
        store.run("INSERT INTO heads VALUES(?,?,?,?,?,?,?)", lineage(request), canonicalJson(request.view), stage.stateGeneration,
          canonicalJson(cursor), 0, null, 0);
      }
    } else store.validate(false);
    safeStoreFile(path); return { db, store };
  };
  if (request.action === "start") {
    const { db, store } = openStore(true);
    try { db.checkpoint(); return { action: "start", repairId: request.repairId, targetStoreId: stage.storeId,
      expectedActiveStoreId: stage.expectedActiveStoreId, stateGeneration: stage.stateGeneration,
      processedCut: stage.processedCut, resumable: true, metrics: { sqliteStatements: store.statements } }; }
    finally { db.close(); }
  }
  const { db, store } = openStore(false);
  try {
    if (request.action === "step") {
      const value = await materialize({ ...request, op: "materializeRollup", limit: request.limit }, store, options, budget);
      try { db.checkpoint(); } catch { /* committed WAL remains authoritative */ }
      return { action: "step", repairId: request.repairId, targetStoreId: stage.storeId, resumable: value.complete !== true, ...value };
    }
    const value = status({ ...request, op: "rollupStatus" }, store);
    if (request.action === "status") return { action: "status", repairId: request.repairId, targetStoreId: stage.storeId,
      expectedActiveStoreId: stage.expectedActiveStoreId, ...value };
    if (request.expectedActiveStoreId !== stage.expectedActiveStoreId) fail("search-v3-rollup-publication-conflict");
    const h = value.handle as EpisodeRollupHandle | undefined;
    if (value.complete !== true || !h || h.storeId !== stage.storeId || h.eventCut !== request.view.eventCut
      || h.stateGeneration !== stage.stateGeneration || h.branchKey !== request.view.branchKey
      || h.ruleset !== EPISODE_ROLLUP_RULESET_VERSION) fail("search-v3-rollup-repair-incomplete");
    const validHandle = h as EpisodeRollupHandle;
    loadNode(store, validHandle.rootNodeId); db.checkpoint(); safeStoreFile(path);
    const current = safeRecord(paths.active, activeValid)?.storeId ?? null;
    if (current !== stage.expectedActiveStoreId && current !== stage.storeId) fail("search-v3-rollup-publication-conflict");
    if (current !== stage.storeId) atomicRecord(paths.active, { v: 1, storeId: stage.storeId } satisfies RepairActive);
    return { action: "publish", repairId: request.repairId, targetStoreId: stage.storeId, published: true, handle: validHandle };
  } finally { db.close(); }
}

export async function executeEpisodeRollupRequest(request: Extract<EpisodeStateRequest, { op: "materializeRollup" | "rollupStatus" | "repairRollup" | "composeRollupSelection" | "recallRollup" }>,
  options: EpisodeStateExecutionOptions = {}): Promise<EpisodeStateResponse> {
  const budget = { bytes: 0 }; let db: CatalogSqlite | undefined;
  try {
    const catalog = await (options.catalogExecutor ?? executeCatalogStoreRequest)({ v: 1, catalogDirectory: request.catalogDirectory,
      sessionKey: request.identity.capsule.sessionKey, op: "page", view: request.view, after: request.view.eventCut, limit: 1 });
    budget.bytes += catalog.sourceBytes;
    if (!catalog.ok) fail(catalog.code === "catalog-source-changed" ? "search-v3-rollup-source-changed" : "search-v3-rollup-catalog-unavailable");
    const action = async (): Promise<EpisodeStateResponse> => {
      let result: Record<string, unknown>;
      if (request.op === "repairRollup") result = await repair(request, options, budget);
      else {
        const explicitHandle = request.op === "recallRollup" || request.op === "composeRollupSelection" ? request.handle : undefined;
        // A handle without storeId always means the legacy file, even after route publication.
        const storeId = explicitHandle ? explicitHandle.storeId ?? null : activeStoreId(request.searchDirectory);
        const path = storeId ? repairStorePath(request.searchDirectory, storeId) : join(request.searchDirectory, "rollup-v3.sqlite");
        const indexedCut = storeId !== null, createStore = request.op === "materializeRollup" && !storeId;
        if (!createStore) { try { safeStoreFile(path); } catch (error) { if (missing(error)) fail("search-v3-rollup-store-missing"); throw error; } }
        const validate = (candidate: CatalogSqlite): void => new Store(candidate, request, storeId ?? undefined, indexedCut).validate(createStore);
        db = createStore ? CatalogSqlite.create(path, validate) : CatalogSqlite.open(path, validate);
        const store = new Store(db, request, storeId ?? undefined, indexedCut); if (createStore) store.initialize(); else store.validate(false);
        result = request.op === "materializeRollup" ? await materialize(request, store, options, budget)
          : request.op === "recallRollup" ? recall(request, store)
          : request.op === "composeRollupSelection" ? composeRollupSelection(request, store) : status(request, store);
        if (createStore) try { db.checkpoint(); } catch { /* committed WAL remains authoritative */ }
      }
      const response: EpisodeStateResponse = { v: 1, ok: true, result: { ...result,
        coverageScope: "Closed episode intervals and exact M07 source references. Interval closure is not task completion. Protected omissions stay explicit and detail remains reachable through children or exact sources." },
        sourceBytes: budget.bytes, sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes };
      if (Buffer.byteLength(JSON.stringify(response)) > EPISODE_STATE_LIMITS.responseBytes) fail("search-v3-rollup-response-limit");
      return response;
    };
    const writes = request.op === "materializeRollup" || request.op === "repairRollup";
    return writes ? await withRuntimeMutex(join(request.searchDirectory, "rollup-publication.lock"), action) : await action();
  } catch (error) {
    const candidate = (error as { code?: string }).code;
    const mapped: Record<string, string> = { "catalog-storage-unsafe": "search-v3-rollup-storage-unsafe", "catalog-sqlite-busy": "search-v3-rollup-store-busy",
      "catalog-sqlite-corrupt": "search-v3-rollup-store-corrupt", "catalog-sqlite-capability": "search-v3-rollup-store-capability",
      "catalog-sqlite-limit": "search-v3-rollup-store-limit", "catalog-sqlite-failed": "search-v3-rollup-store-failed",
      "catalog-sqlite-unavailable": "search-v3-rollup-store-capability" };
    const code = candidate?.startsWith("search-v3-rollup-") ? candidate : candidate && mapped[candidate] ? mapped[candidate]! :
      candidate === "ENOSPC" ? "search-v3-rollup-storage-full" : "search-v3-rollup-storage-io";
    return { v: 1, ok: false, code, sourceBytes: budget.bytes, sqliteNativeLimitBytes: EPISODE_STATE_LIMITS.nativeSqliteBytes,
      resumable: !["search-v3-rollup-store-mismatch", "search-v3-rollup-version-mismatch", "search-v3-rollup-storage-unsafe"].includes(code) };
  } finally { try { db?.close(); } catch { /* preserve bounded response */ } }
}
