import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ProjectGlanceRelayRuntime } from "../dist/pi/lifecycle.js";
import { ProjectGlanceClient } from "../dist/protocol/client.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error("ARCHIVE_RELAY_TIMEOUT"); await pause(5); }
}
function update(text) {
  return { role: "assistant", stopReason: "stop", timestamp: Date.now(), api: "openai-responses", provider: "synthetic", model: "synthetic", content: [
    { type: "text", text, textSignature: JSON.stringify({ v: 1, id: "synthetic", phase: "commentary" }) },
  ] };
}

test("authenticated recent close and clear preserve complete History and survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "glance-archive-relay-"));
  const environment = { ...process.env, XDG_RUNTIME_DIR: root, XDG_STATE_HOME: join(root, "state") };
  const sm = SessionManager.create(root, join(root, "sessions"));
  const longBody = "Synthetic complete body. " + "界🙂".repeat(18000);
  sm.appendMessage(update(longBody));
  for (let i = 1; i < 61; i++) sm.appendMessage(update(`Synthetic update ${i}`));
  let runtime = new ProjectGlanceRelayRuntime(environment);
  let client, latest, snapshots = 0;
  async function connect() {
    latest = undefined;
    client = new ProjectGlanceClient({ descriptorPath: runtime.descriptorPath, onSnapshot: (snapshot) => { latest = snapshot; snapshots++; } });
    client.start();
    await until(() => latest?.archive?.state === "ready");
  }
  try {
    await runtime.ensureForContext({ sessionManager: sm });
    await connect();
    assert.equal(latest.archive.inboxCount, 10);
    assert.equal(latest.archive.historyCount, 61);
    const recent = await client.requestPage(latest.branchId, "inbox");
    assert.equal(recent.items.length, 10);
    assert.equal(recent.items[0].preview, "Synthetic update 51");
    let page = await client.requestPage(latest.branchId, "history");
    assert.equal(page.items.length, 25);
    const ids = page.items.map((item) => item.itemId);
    while (page.nextCursor) {
      page = await client.requestPage(latest.branchId, "history", page.nextCursor);
      ids.push(...page.items.map((item) => item.itemId));
    }
    assert.equal(new Set(ids).size, 61);
    const first = page.items.at(-1);
    let offset = 0, text = "";
    do {
      const body = await client.requestBody(latest.branchId, first.itemId, offset);
      assert.ok(Buffer.byteLength(body.text) <= 24 * 1024);
      text += body.text;
      offset = body.nextOffset;
    } while (offset !== undefined);
    assert.equal(text, longBody);
    const beforeFocus = snapshots;
    assert.equal(client.sendAction(latest.branchId, latest.revision, { type: "focus" }), true);
    await until(() => snapshots > beforeFocus);
    assert.equal(latest.archive.inboxCount, 10);
    await client.sendFeedAction(latest.branchId, latest.revision, { type: "dismiss", itemId: recent.items[0].itemId });
    await until(() => latest.archive.inboxCount === 9);
    assert.equal(latest.archive.historyCount, 61);
    const remaining = await client.requestPage(latest.branchId, "inbox");
    await client.sendFeedAction(latest.branchId, latest.revision, { type: "clear_recent", itemIds: remaining.items.map((item) => item.itemId) });
    await until(() => latest.archive.inboxCount === 0);
    assert.equal(latest.archive.historyCount, 61);
    sm.appendMessage(update("Synthetic new arrival"));
    await runtime.syncFeed({ sessionManager: sm });
    await until(() => latest.archive.inboxCount === 1 && latest.archive.historyCount === 62);
    const originalBranch = latest.branchId;
    client.stop();
    await runtime.stop();
    runtime = new ProjectGlanceRelayRuntime(environment);
    await runtime.ensureForContext({ sessionManager: SessionManager.open(sm.getSessionFile()) });
    await connect();
    assert.equal(latest.branchId, originalBranch);
    assert.equal(latest.archive.historyCount, 62);
    assert.equal(latest.archive.inboxCount, 1);
    assert.equal((await client.requestPage(latest.branchId, "inbox")).items[0].preview, "Synthetic new arrival");
    const restoredBody = await client.requestBody(latest.branchId, first.itemId, 0);
    assert.equal(restoredBody.text, longBody.slice(0, restoredBody.text.length));
  } finally {
    client?.stop();
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
