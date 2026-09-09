import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HistorySearchAdapter } from "../src/history-search-adapter.js";
import { line } from "./capsule-storage-fixture.js";

const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
async function ready(adapter: HistorySearchAdapter): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = adapter.scheduler.status();
    if (status.state === "ready") return;
    assert.notEqual(status.state, "error", JSON.stringify(status));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`lifecycle did not settle: ${JSON.stringify(adapter.scheduler.status())}`);
}

test("real lifecycle search, decoded block and exact raw range survive append with branch isolation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrono-adapter-"));
  const sourcePath = join(directory, "source.jsonl");
  const schedulerDirectory = join(directory, "scheduler");
  mkdirSync(schedulerDirectory, { mode: 0o700 });
  const generatedStatus = JSON.stringify({ type: "message", id: "status", parentId: null, message: { role: "toolResult", toolName: "history_status", content: [{ type: "text", text: "generatedstatusneedle" }] } }) + "\n";
  const first = line("a", "status", "amber compass source one");
  const second = line("b", "a", "amber compass source two");
  writeFileSync(sourcePath, generatedStatus + first + second, { mode: 0o600 });
  const adapter = new HistorySearchAdapter({ schedulerDirectory, slots: 1 });
  const target = { sourcePath, schedulerDirectory, catalogDirectory: join(directory, "catalog"), sessionKey: hash("adapter-session"), shardKey: hash("adapter-shard"), leafId: "b" };
  // The public scheduler target deliberately contains no worker configuration.
  const schedule = (leafId: string) => adapter.schedule({ sourcePath: target.sourcePath, catalogDirectory: target.catalogDirectory, sessionKey: target.sessionKey, shardKey: target.shardKey, leafId });
  try {
    schedule("b"); await ready(adapter);
    assert.equal(adapter.status().enabled, true);
    assert.equal(adapter.status().lag, 0);
    assert.equal(adapter.status().requestedCut, adapter.status().indexedCut);
    const stableStatus = adapter.status();
    assert.deepEqual(adapter.status(), stableStatus); // read-only cached surface
    const excludedStatus = await adapter.search({ query: "generatedstatusneedle" });
    assert.equal(excludedStatus.details.status, "ok");
    for (const hit of excludedStatus.details.hits as { independentEvidence: boolean; provenance: string }[]) {
      assert.equal(hit.independentEvidence, false, "history_status output is not independent source evidence");
      assert.equal(hit.provenance, "generated");
    }
    const budgeted = await adapter.search({ query: "source", limit: 8 });
    assert.equal(budgeted.details.status, "ok");
    assert.equal((budgeted.details.hits as unknown[]).length, 1);
    assert.ok(budgeted.details.nextCursor, "budgeted page must keep continuation");
    const found = await adapter.search({ query: "source two", mode: "exact", limit: 1 });
    assert.equal(found.details.status, "ok", JSON.stringify(found.details));
    const handle = (found.details.hits as { handle: string }[])[0]?.handle;
    assert.ok(handle);
    const recalled = await adapter.recall(handle);
    assert.equal(recalled.details.status, "ok", JSON.stringify(recalled.details));
    assert.match(String(recalled.details.text), /amber compass source two/);
    const block = await adapter.getBlock("b", 0);
    assert.equal(block.details.status, "ok", JSON.stringify(block.details));
    assert.equal(block.details.text, "amber compass source two");
    const raw = await adapter.getRaw("b", {});
    assert.equal(raw.details.status, "ok", JSON.stringify(raw.details));
    assert.equal(raw.details.text, second);
    const range = await adapter.range("a", "b", 1);
    assert.equal(range.details.status, "ok", JSON.stringify(range.details));
    assert.equal(range.details.complete, false);
    const cursor = String(range.details.nextCursor);
    appendFileSync(sourcePath, line("c", "b", "later source"));
    schedule("c");
    const pendingDeadline = Date.now() + 10_000;
    while (adapter.status().catalog !== "ready" && Date.now() < pendingDeadline) await new Promise(r => setTimeout(r, 10));
    const catchingUp = adapter.status();
    assert.equal(catchingUp.servingLastReady, true);
    assert.ok(Number(catchingUp.lag) > 0, JSON.stringify(catchingUp));
    assert.equal((await adapter.recall(handle)).details.status, "ok", "validated old view remains available during append catch-up");
    await ready(adapter);
    assert.equal(adapter.status().lag, 0);
    const continued = await adapter.range("a", "b", 1, cursor);
    assert.equal(continued.details.status, "ok", JSON.stringify(continued.details));
    assert.equal(continued.details.complete, true);
    const entries = continued.details.entries as { data: string }[];
    assert.equal(Buffer.from(entries[0]!.data, "base64").toString("utf8"), second);
    appendFileSync(sourcePath, line("fork", "a", "sibling source"));
    schedule("fork");
    assert.equal(adapter.status().servingLastReady, false, "unvalidated branch cannot expose old view");
    await ready(adapter);
    const refused = await adapter.recall(handle);
    assert.equal(refused.details.status, "unavailable");
    const sibling = await adapter.getRaw("b", {});
    assert.equal(sibling.details.status, "unavailable");
  } finally {
    adapter.dispose(); await adapter.scheduler.drain();
    rmSync(directory, { recursive: true, force: true });
  }
});
