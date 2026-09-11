import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { isLogicalSessionManifest } from "../src/logical-session-contract.js";
import { consumeProvisionalLogicalReplacement, markProvisionalLogicalReplacement } from "../src/logical-session-integration.js";
import { resolveLogicalActivation, resolveLogicalShardRoutes, searchLogicalAncestors } from "../src/logical-session-routing.js";
import {
  ManualLogicalRollover,
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
}
class FakeCommands implements SessionCommandPort {
  replacement?: FakeSession;
  readonly events: string[] = [];
  beforeReload?: () => Promise<void>;
  constructor(public sessionManager: FakeSession) {}
  private context(sessionManager: FakeSession): ReplacementContextPort {
    return { sessionManager, reload: async () => {
      this.events.push("reload");
      await this.beforeReload?.();
    } };
  }
  async newSession(options: { parentSession: string; setup: (manager: SessionSetupPort) => Promise<void>; withSession: (ctx: ReplacementContextPort) => Promise<void> }): Promise<{ cancelled: boolean }> {
    this.replacement = new FakeSession("pi-new", join(tmpdir(), `${randomUUID()}.jsonl`), options.parentSession);
    this.sessionManager = this.replacement;
    // Pi 0.85.1 can start the replacement extension before setup.
    this.events.push("session_start", "setup");
    await options.setup(this.replacement);
    this.events.push("withSession");
    await options.withSession(this.context(this.replacement));
    return { cancelled: false };
  }
  async switchSession(path: string, options: { withSession: (ctx: ReplacementContextPort) => Promise<void> }): Promise<{ cancelled: boolean }> {
    this.sessionManager = new FakeSession("pi-old", path);
    await options.withSession(this.context(this.sessionManager));
    return { cancelled: false };
  }
}

const cut = (entryId: string) => ({ catalogStoreKey: "11111111-1111-4111-8111-111111111111", catalogGeneration: 1,
  sessionKey: "catalog-session", branchKey: "pi-session", eventCut: 7, entryId });

test("manual logical rollover is owner-only, coverage-gated, recoverable, and ancestor-routed", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "chrono-logical-test-"));
  const root = join(temporary, "logical");
  const logicalSessionId = randomUUID(), oldPath = join(temporary, "old.jsonl");
  const clearProvisional = markProvisionalLogicalReplacement(oldPath);
  assert.equal(consumeProvisionalLogicalReplacement(oldPath), true);
  assert.equal(consumeProvisionalLogicalReplacement(oldPath), false, "provisional replacement markers are one-shot");
  clearProvisional();
  const store = new LogicalSessionStore(root, logicalSessionId);
  let manifest = await store.create(createInitialLogicalManifest({ logicalSessionId, ownerKey: "a".repeat(64), branchId: "main",
    piSessionId: "pi-old", sourcePath: oldPath, createdAt: "2026-09-10T00:00:00.000Z" }));
  assert.ok(isLogicalSessionManifest(manifest));
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(store.manifestPath)).mode & 0o777, 0o600);
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
  await assert.rejects(() => rollover.prepare({ ...candidate, mandatory: { ...candidate.mandatory, protectedCovered: 1 } }, eligibility),
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
  const grant = resolveLogicalActivation(manifest, { piSessionId: "pi-new", sourcePath: commands.replacement!.path }, {
    schemaVersion: 1, logicalSessionId, branchId: "main", shardId: details.toShardId, continuationHash: details.continuationHash });
  assert.equal(grant.composerCanaryInherited, false);
  assert.equal(grant.searchRoutes.length, 2);
  assert.throws(() => resolveLogicalActivation(manifest, { piSessionId: "pi-new", sourcePath: commands.replacement!.path }, {
    schemaVersion: 1, logicalSessionId, branchId: "main", shardId: details.toShardId, continuationHash: "d".repeat(64) }),
    (error: any) => error.code === "logical-session-activation-invalid");
  assert.deepEqual(resolveLogicalShardRoutes(manifest, "main").map(route => route.shardId), manifest.branches[0]!.shardIds);
  const searched = await searchLogicalAncestors(manifest, "main", async route => ({ items: [route.shardId] }), 2);
  assert.deepEqual(searched.items, [...manifest.branches[0]!.shardIds].reverse());

  assert.deepEqual(await rollover.rollbackLast(commands, true), { cancelled: false });
  manifest = (await store.read())!;
  assert.equal(manifest.branches[0]!.activeShardId, oldShardId);
  assert.equal(manifest.shards[0]!.state, "active");
  assert.equal(manifest.shards[1]!.state, "closed");
  assert.equal(manifest.shards.length, 2, "rollback preserves the replacement shard");
});
