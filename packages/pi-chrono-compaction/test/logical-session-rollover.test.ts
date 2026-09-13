import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isLogicalSessionManifest } from "../src/logical-session-contract.js";
import { persistNewShardBootstrap } from "../src/logical-session-persistence.js";
import { composeStoredSelection } from "../src/context-composer.js";
import type { EpisodeStateSelection } from "../src/episode-state-contract.js";
import { buildManualContinuationCandidate, consumeProvisionalLogicalReplacement, logicalAdoptionBinding, markProvisionalLogicalReplacement, recordedLogicalAdoptionBinding, replacementContainsOnlyBootstrap } from "../src/logical-session-integration.js";
import { resolveAdoptedLogicalActivation, resolveExactLogicalRoute, resolveLogicalActivation, resolveLogicalShardRoutes, searchLogicalAncestors } from "../src/logical-session-routing.js";
import { evaluateLogicalRolloverThresholds, logicalSessionStatus } from "../src/logical-session-status.js";
import {
  ManualLogicalRollover,
  buildLogicalContinuation,
  adoptExistingSessionAsShardZero,
  createInitialLogicalManifest,
  type ContinuationCandidate,
  type ReplacementContextPort,
  type SessionCommandPort,
  type SessionSetupPort,
} from "../src/logical-session-rollover.js";
import { LogicalSessionStore } from "../src/logical-session-store.js";

class FakeSession implements SessionSetupPort {
  readonly entries: { type: string; content: string; details: unknown }[] = [];
  constructor(readonly id: string, readonly path: string, readonly parentSession?: string) {}
  getSessionId(): string { return this.id; }
  getSessionFile(): string { return this.path; }
  getHeader(): { parentSession?: string } { return this.parentSession ? { parentSession: this.parentSession } : {}; }
  appendCustomMessageEntry(type: string, content: string, _display: boolean, details?: unknown): string {
    this.entries.push({ type, content, details }); return "continuation-entry";
  }
  async persistNewShardBootstrap(expectedParentSession: string, continuationEntryId: string): Promise<void> {
    assert.equal(expectedParentSession, this.parentSession);
    assert.equal(continuationEntryId, "continuation-entry");
  }
}
class FakeCommands implements SessionCommandPort {
  replacement?: FakeSession;
  readonly events: string[] = [];
  private sequence = 0;
  beforeReload?: () => Promise<void>;
  constructor(public sessionManager: FakeSession) {}
  private context(sessionManager: FakeSession): ReplacementContextPort {
    return { sessionManager, reload: async () => {
      this.events.push("reload");
      await this.beforeReload?.();
    } };
  }
  async newSession(options: { parentSession: string; setup: (manager: SessionSetupPort) => Promise<void>; withSession: (ctx: ReplacementContextPort) => Promise<void> }): Promise<{ cancelled: boolean }> {
    this.replacement = new FakeSession(`pi-new-${++this.sequence}`, join(tmpdir(), `${randomUUID()}.jsonl`), options.parentSession);
    this.sessionManager = this.replacement;
    // Pi 0.85.1 can start the replacement extension before setup.
    this.events.push("session_start", "setup");
    await options.setup(this.replacement);
    this.events.push("withSession");
    await options.withSession(this.context(this.replacement));
    return { cancelled: false };
  }
  async switchSession(path: string, options: { withSession: (ctx: ReplacementContextPort) => Promise<void> }): Promise<{ cancelled: boolean }> {
    this.sessionManager = new FakeSession(path.includes("old.jsonl") ? "pi-old" : `pi-switched-${++this.sequence}`, path);
    this.events.push("session_start");
    await options.withSession(this.context(this.sessionManager));
    return { cancelled: false };
  }
}

const cut = (entryId: string) => ({ catalogStoreKey: "11111111-1111-4111-8111-111111111111", catalogGeneration: 1,
  sessionKey: "catalog-session", branchKey: "pi-session", eventCut: 7, entryId });

test("actual Pi manager keeps an exact durable continuation prefix through its first assistant append", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "chrono-logical-pi-persist-"));
  const sessions = join(temporary, "sessions"), oldPath = join(temporary, "old.jsonl");
  await mkdir(sessions, { mode: 0o700 }); await chmod(sessions, 0o700);
  const oldBytes = "old-source-must-remain-untouched\n";
  await writeFile(oldPath, oldBytes, { mode: 0o600, flag: "wx" });
  const manager = SessionManager.create(temporary, sessions, { parentSession: oldPath });
  manager.appendThinkingLevelChange("off");
  const continuationId = manager.appendCustomMessageEntry("chrono-logical-continuation", "Exact bounded continuation.", true,
    { schemaVersion: 1, operationId: randomUUID() });
  const sourcePath = manager.getSessionFile()!;
  await assert.rejects(stat(sourcePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    "Pi 0.85.1 defers a continuation-only source");
  const expected = [manager.getHeader(), ...manager.getEntries()];
  const expectedBytes = `${expected.map(value => JSON.stringify(value)).join("\n")}\n`;
  await persistNewShardBootstrap(manager, oldPath, continuationId);
  assert.equal(await readFile(sourcePath, "utf8"), expectedBytes, "the public manager objects use Pi's exact JSONL encoding");
  assert.equal(manager.getSessionId(), (expected[0] as { id: string }).id);
  assert.equal(manager.getHeader()?.parentSession, oldPath);
  await persistNewShardBootstrap(manager, oldPath, continuationId);
  const prefix = await readFile(sourcePath, "utf8");
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Later normal assistant record." }],
    api: "fixture", provider: "fixture", model: "fixture", usage, stopReason: "stop", timestamp: Date.now() });
  assert.equal((await readFile(sourcePath, "utf8")).startsWith(prefix), true,
    "Pi appends its first assistant record without rewriting the durable prefix");
  const reopened = SessionManager.open(sourcePath, sessions);
  assert.equal(reopened.getSessionId(), manager.getSessionId());
  assert.equal(reopened.getHeader()?.parentSession, oldPath);

  const occupied = SessionManager.create(temporary, sessions, { parentSession: oldPath });
  const occupiedId = occupied.appendCustomMessageEntry("chrono-logical-continuation", "Other continuation.", true,
    { schemaVersion: 1, operationId: randomUUID() });
  const occupiedPath = occupied.getSessionFile()!;
  await writeFile(occupiedPath, "occupied-source\n", { mode: 0o600, flag: "wx" });
  await assert.rejects(() => persistNewShardBootstrap(occupied, oldPath, occupiedId),
    (error: any) => error.code === "logical-session-source-persistence-invalid");
  assert.equal(await readFile(occupiedPath, "utf8"), "occupied-source\n", "an existing mismatch is never overwritten");
  assert.equal(await readFile(oldPath, "utf8"), oldBytes, "the old source is never opened for writing");
});

test("automatic adoption accepts a safe readable parent but keeps logical stores private", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "chrono-logical-parent-"));
  await chmod(temporary, 0o755);
  const sourcePath = join(temporary, "old.jsonl");
  const sourceBytes = "preserved-existing-source\n";
  await writeFile(sourcePath, sourceBytes, { mode: 0o600, flag: "wx" });
  const store = new LogicalSessionStore(join(temporary, "logical"), randomUUID());
  const identity = { ownerKey: "a".repeat(64), branchId: "main", piSessionId: "pi-old", sourcePath };
  const manifest = await adoptExistingSessionAsShardZero(store, identity);
  assert.deepEqual(await adoptExistingSessionAsShardZero(store, identity), manifest);
  assert.equal((await stat(temporary)).mode & 0o777, 0o755, "adoption does not chmod the shared parent");
  for (const directory of [store.root, store.directory]) assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(store.manifestPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(sourcePath, "utf8"), sourceBytes);
  await chmod(store.root, 0o755);
  await assert.rejects(() => store.read(), (error: any) => error.code === "logical-session-storage-unsafe");
  await chmod(store.root, 0o700);

  await chmod(temporary, 0o777);
  const unsafe = new LogicalSessionStore(join(temporary, "unsafe-logical"), randomUUID());
  await assert.rejects(() => adoptExistingSessionAsShardZero(unsafe, identity),
    (error: any) => error.code === "logical-session-storage-unsafe");
  await assert.rejects(stat(unsafe.root), (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    "an unsafe writable parent is rejected before creating the store");
  await chmod(temporary, 0o700);
});

test("fractional-importance producer artifact reaches a manual continuation with the composer hash", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "chrono-logical-fractional-"));
  const logicalSessionId = randomUUID();
  const store = new LogicalSessionStore(join(temporary, "logical"), logicalSessionId);
  const manifest = await store.create(createInitialLogicalManifest({ logicalSessionId, ownerKey: "a".repeat(64), branchId: "main",
    piSessionId: "pi-old", sourcePath: join(temporary, "old.jsonl") }));
  const storeKey = "22222222-2222-4222-8222-222222222222";
  const source = { catalogStoreKey: storeKey, sessionKey: "session", catalogGeneration: 1, shardKey: "shard",
    segment: 1, eventSeq: 7, ordinal: 7, descriptor: 7, field: "message.content.0.text", raw: { start: 0, end: 200 },
    coordinateKind: "decoded-body" as const, decodedUtf16: { start: 0, end: 32 },
    bodyHashAlgorithm: "chrono-utf16le-chain-sha256-v1" as const, bodyHash: "b".repeat(64) };
  const selection: EpisodeStateSelection = {
    sourceView: { storeKey, generation: 1, branchKey: "branch", sessionKey: "session", eventCut: 7,
      segments: [{ segment: 1, cut: 7 }] }, stateGeneration: 1, branchKey: "branch", requestedCut: 7,
    processedCut: 7, processedMemoryCut: 7, complete: true, partial: false,
    coverage: { bodyComplete: true, metadataComplete: true, partialMemory: false, qualifiedReducers: true,
      restrictionsComplete: true, openWorkComplete: true, restrictionsScanComplete: true, openWorkScanComplete: true },
    protected: [], current: [], recent: [{ episodeKey: "episode", eventSeq: 7, descriptor: 7, sourceKey: "source", source,
      cue: "Actual producer cue with fractional importance.", episode: { start: { eventSeq: 7, descriptor: 7 },
        end: { eventSeq: 7, descriptor: 7 }, open: false, objective: "Exercise continuation hashing.", objectiveEvidence: null } }],
    older: [], omissions: { protectedAtLeastOne: false, openWorkAtLeastOne: false, currentAtLeastOne: false,
      recentAtLeastOne: false, responseBudgetAtLeastOne: false, restrictionWorkExhausted: false,
      openWorkExhausted: false, renderedOverflowAtLeastOne: false }, metrics: { sqliteStatements: 1 } };
  const cutInput = { sourceCutEntryId: "leaf-7", sourceCutSeq: 7, firstKeptEntryId: "chrono-logical-new-shard",
    firstKeptSeq: 8, rawTailTokens: 0, toolPairSafe: true };
  const composed = composeStoredSelection({ regularPiSummary: "Bounded regular Pi summary.", combinedCeilingTokens: 2_000,
    cut: cutInput }, selection, value => `recover:${value.eventSeq}`);
  assert.equal(composed.artifact.selectedRows[0]?.row.importance, 0.7,
    "the actual episode-row producer preserves its fractional importance in the artifact");
  const candidate = buildManualContinuationCandidate({ manifest, branchId: "main", sourceLeafEntryId: "leaf-7",
    regularPiSummary: "Bounded regular Pi summary.", selection,
    recover: (_view, value) => `recover:${value.eventSeq}`, combinedCeilingTokens: 2_000, toolPairSafe: true });
  assert.equal(candidate.composition.artifactHash, composed.envelope.artifactHash,
    "continuation reuses the composer contract hash for the validated artifact");
  assert.match(candidate.composition.artifactHash, /^[a-f0-9]{64}$/u);
});

test("manual logical rollover is owner-only, source-gated, selective, recoverable, and ancestor-routed", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "chrono-logical-test-"));
  const root = join(temporary, "logical");
  const logicalSessionId = randomUUID(), oldPath = join(temporary, "old.jsonl");
  const clearProvisional = markProvisionalLogicalReplacement(oldPath);
  assert.equal(consumeProvisionalLogicalReplacement(oldPath), true);
  assert.equal(consumeProvisionalLogicalReplacement(oldPath), false, "provisional replacement markers are one-shot");
  clearProvisional();
  const store = new LogicalSessionStore(root, logicalSessionId);
  let manifest = await adoptExistingSessionAsShardZero(store, { ownerKey: "a".repeat(64), branchId: "main",
    piSessionId: "pi-old", sourcePath: oldPath, createdAt: "2026-09-10T00:00:00.000Z" });
  assert.deepEqual(await adoptExistingSessionAsShardZero(store, { ownerKey: "a".repeat(64), branchId: "main",
    piSessionId: "pi-old", sourcePath: oldPath }), manifest, "startup adoption is idempotent for the exact source identity");
  await assert.rejects(() => adoptExistingSessionAsShardZero(store, { ownerKey: "a".repeat(64), branchId: "main",
    piSessionId: "other", sourcePath: oldPath }), (error: any) => error.code === "logical-session-adoption-conflict");
  assert.ok(isLogicalSessionManifest(manifest));
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(store.manifestPath)).mode & 0o777, 0o600);
  const adoptionData = logicalAdoptionBinding(manifest, "main");
  const adoption = recordedLogicalAdoptionBinding([{ type: "custom", customType: "chrono-logical-adoption", data: adoptionData }]);
  assert.ok(adoption);
  assert.equal(resolveAdoptedLogicalActivation(manifest, { piSessionId: "pi-old", sourcePath: oldPath }, adoption).activeShardId,
    manifest.shards[0]!.shardId, "an explicitly bound existing session activates as shard zero");
  const oldShardId = manifest.shards[0]!.shardId;
  const candidate: ContinuationCandidate = { logicalSessionId, branchId: "main", fromShardId: oldShardId, source: cut("leaf-7"),
    coveredShards: [{ shardId: oldShardId, ...cut("leaf-7") }], summary: "Derived continuation with exact recovery references.",
    composition: { schemaVersion: 1, payloadHash: "b".repeat(64), artifactHash: "c".repeat(64), combinedTokens: 80,
      combinedCeilingTokens: 100, validation: { safeTail: true, withinCombinedCeiling: true,
        protectedCoverageComplete: true, openWorkCoverageComplete: true } },
    mandatory: { protectedEligible: 2, protectedCovered: 2, openWorkEligible: 1, openWorkCovered: 1, omittedMandatory: [] } };
  const eligibility = { persisted: true, idle: true, streaming: false, activeToolCalls: 0, unmatchedToolPairs: 0,
    pendingMessages: false, compactionActive: false, sessionSwitchActive: false, catalogCaughtUp: true,
    incompleteSourceTail: false, sourceLeafEntryId: "leaf-7", trigger: "manual" as const };
  const rollover = new ManualLogicalRollover(store);
  const selective = buildLogicalContinuation(manifest, { ...candidate,
    composition: { ...candidate.composition, combinedCeilingTokens: 60_000 },
    mandatory: { ...candidate.mandatory, protectedCovered: 1 } });
  assert.equal(selective.composition.mandatoryCoverageComplete, false,
    "selective history does not require a global verbatim inventory or claim full coverage");
  assert.equal(selective.composition.combinedCeilingTokens, 60_000);
  await assert.rejects(() => rollover.prepare({ ...candidate, composition: { ...candidate.composition,
    validation: { ...candidate.composition.validation, safeTail: false } } }, eligibility),
    (error: any) => error.code === "logical-session-continuation-incomplete");

  const commands = new FakeCommands(new FakeSession("pi-old", oldPath));
  commands.beforeReload = async () => {
    assert.equal((await store.read())!.pendingRollover, undefined, "reload follows manifest activation");
  };
  assert.deepEqual(await rollover.rollover(candidate, eligibility, commands), { cancelled: false });
  assert.deepEqual(commands.events, ["session_start", "setup", "withSession", "reload"]);
  manifest = (await store.read())!;
  assert.equal(manifest.pendingRollover, undefined);
  assert.equal(manifest.shards.length, 2);
  assert.equal(manifest.shards[0]!.state, "closed");
  assert.equal(manifest.shards[1]!.state, "active");
  assert.equal(commands.replacement!.entries.length, 1);
  const details = commands.replacement!.entries[0]!.details as { continuationHash: string; toShardId: string };
  const grant = resolveLogicalActivation(manifest, { piSessionId: "pi-new-1", sourcePath: commands.replacement!.path }, {
    schemaVersion: 1, logicalSessionId, branchId: "main", shardId: details.toShardId, continuationHash: details.continuationHash });
  assert.equal(grant.composerCanaryInherited, false);
  assert.equal(grant.searchRoutes.length, 2);
  assert.throws(() => resolveLogicalActivation(manifest, { piSessionId: "pi-new-1", sourcePath: commands.replacement!.path }, {
    schemaVersion: 1, logicalSessionId, branchId: "main", shardId: details.toShardId, continuationHash: "d".repeat(64) }),
    (error: any) => error.code === "logical-session-activation-invalid");
  assert.deepEqual(resolveLogicalShardRoutes(manifest, "main").map(route => route.shardId), manifest.branches[0]!.shardIds);
  const searched = await searchLogicalAncestors(manifest, "main", async route => ({ items: [route.shardId] }), 2);
  assert.deepEqual(searched.items, [...manifest.branches[0]!.shardIds].reverse());

  assert.deepEqual(await rollover.rollbackLast(commands, true), { cancelled: false });
  assert.deepEqual(commands.events.slice(-2), ["session_start", "reload"],
    "rollback reloads only after the resumed runtime starts and the manifest commit completes");
  manifest = (await store.read())!;
  assert.equal(manifest.branches.find(branch => branch.branchId === "main")!.activeShardId, oldShardId);
  assert.equal(manifest.shards.find(shard => shard.shardId === oldShardId)!.state, "active");
  assert.equal(resolveLogicalShardRoutes(manifest, "main").length, 1, "rolled-back replacement is preserved on an isolated branch");

  for (let ordinal = 2; ordinal <= 10; ordinal += 1) {
    const active = manifest.shards.find(shard => shard.shardId === manifest.branches[0]!.activeShardId)!;
    const nextCut = { ...cut(`leaf-${ordinal}`), eventCut: ordinal + 6 };
    const nextCandidate: ContinuationCandidate = { ...candidate, fromShardId: active.shardId, source: nextCut,
      coveredShards: resolveLogicalShardRoutes(manifest, "main").map(route => route.shardId === active.shardId
        ? { shardId: route.shardId, ...nextCut } : { shardId: route.shardId, ...route.catalog! }) };
    await rollover.rollover(nextCandidate, { ...eligibility, sourceLeafEntryId: nextCut.entryId }, commands);
    manifest = (await store.read())!;
  }
  assert.equal(manifest.branches[0]!.shardIds.length, 10, "one logical branch continues through ten physical shards");
  const routes = resolveLogicalShardRoutes(manifest, "main");
  assert.equal(routes.length, 10);
  for (const route of routes.slice(0, -1)) assert.equal(resolveExactLogicalRoute(manifest, "main", route.shardId).catalog?.entryId, route.catalog?.entryId);
  const all = await searchLogicalAncestors(manifest, "main", async route => ({ items: [route.shardId] }), 10);
  assert.deepEqual(all.items, routes.map(route => route.shardId).reverse());

  const parentActive = manifest.shards.find(shard => shard.shardId === manifest.branches[0]!.activeShardId)!;
  const forkCut = { ...cut("fork-leaf"), eventCut: 20 };
  const forkCandidate: ContinuationCandidate = { ...candidate, fromShardId: parentActive.shardId, source: forkCut,
    coveredShards: routes.map(route => route.shardId === parentActive.shardId
      ? { shardId: route.shardId, ...forkCut } : { shardId: route.shardId, ...route.catalog! }) };
  await rollover.fork({ sourceBranchId: "main", targetBranchId: "experiment" }, forkCandidate,
    { ...eligibility, sourceLeafEntryId: forkCut.entryId }, commands);
  manifest = (await store.read())!;
  const forkRoutes = resolveLogicalShardRoutes(manifest, "experiment");
  assert.equal(forkRoutes.length, 11);
  assert.equal(forkRoutes.at(-2)?.catalog?.entryId, "fork-leaf", "fork ancestry stops at its immutable parent cut");
  assert.equal(forkRoutes.at(-1)?.shardId, manifest.branches.find(branch => branch.branchId === "experiment")!.activeShardId);
  assert.deepEqual(resolveLogicalShardRoutes(manifest, "main").map(route => route.shardId), routes.map(route => route.shardId),
    "creating a child branch does not mutate its parent route");

  const status = logicalSessionStatus(manifest, "main", { sourceBytes: 255, records: 50, compactions: 4, estimatedTokens: 1000 },
    { sourceBytes: 256, records: 50 });
  assert.deepEqual((status.thresholds as { reached: string[] }).reached, ["records"]);
  assert.deepEqual(evaluateLogicalRolloverThresholds({ sourceBytes: 256, records: 1, compactions: 0 }, { sourceBytes: 256 }),
    { eligible: true, reached: ["sourceBytes"], remaining: {} });
});

test("prepared rollover can reopen from an empty replacement after a pre-setup crash", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "chrono-logical-recover-"));
  const oldPath = join(temporary, "old.jsonl"), logicalSessionId = randomUUID();
  const store = new LogicalSessionStore(join(temporary, "logical"), logicalSessionId);
  let manifest = await store.create(createInitialLogicalManifest({ logicalSessionId, ownerKey: "a".repeat(64), branchId: "main",
    piSessionId: "pi-old", sourcePath: oldPath }));
  const shardId = manifest.shards[0]!.shardId;
  const candidate: ContinuationCandidate = { logicalSessionId, branchId: "main", fromShardId: shardId, source: cut("leaf-7"),
    coveredShards: [{ shardId, ...cut("leaf-7") }], summary: "Bounded continuation.",
    composition: { schemaVersion: 1, payloadHash: "b".repeat(64), artifactHash: "c".repeat(64), combinedTokens: 10,
      combinedCeilingTokens: 100, validation: { safeTail: true, withinCombinedCeiling: true, protectedCoverageComplete: true, openWorkCoverageComplete: true } },
    mandatory: { protectedEligible: 0, protectedCovered: 0, openWorkEligible: 0, openWorkCovered: 0, omittedMandatory: [] } };
  const rollover = new ManualLogicalRollover(store);
  manifest = await rollover.prepare(candidate, { persisted: true, idle: true, streaming: false, activeToolCalls: 0,
    unmatchedToolPairs: 0, pendingMessages: false, compactionActive: false, sessionSwitchActive: false, catalogCaughtUp: true,
    incompleteSourceTail: false, sourceLeafEntryId: "leaf-7", trigger: "manual" });
  const empty = new FakeSession("pi-empty", join(temporary, "empty.jsonl"), oldPath);
  const commands = new FakeCommands(empty);
  assert.equal(replacementContainsOnlyBootstrap([{ type: "thinking_level_change" }]), true);
  assert.deepEqual(await rollover.reopenPreparedFromEmptyReplacement(commands, true), { cancelled: false });
  assert.deepEqual(commands.events, ["session_start", "reload"],
    "prepared recovery reloads after aborting the committed manifest intent");
  manifest = (await store.read())!;
  assert.equal(manifest.pendingRollover, undefined);
  assert.equal(manifest.shards[0]!.state, "active");
});
