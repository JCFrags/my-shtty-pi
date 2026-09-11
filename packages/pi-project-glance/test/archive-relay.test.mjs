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

test("authenticated archive capture, full body, dismissal and restart retain all 61 updates", async () => {
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
    assert.equal(latest.archive.inboxCount, 61);
    let page = await client.requestPage(latest.branchId, "inbox");
    assert.equal(page.items.length, 25);
    const first = page.items[0];
    let offset = 0, text = "";
    do {
      const body = await client.requestBody(latest.branchId, first.itemId, offset);
      assert.ok(Buffer.byteLength(body.text) <= 24 * 1024);
      text += body.text;
      offset = body.nextOffset;
    } while (offset !== undefined);
    assert.equal(text, longBody);
    const ids = page.items.map((item) => item.itemId);
    while (page.nextCursor) {
      page = await client.requestPage(latest.branchId, "inbox", page.nextCursor);
      ids.push(...page.items.map((item) => item.itemId));
    }
    assert.equal(new Set(ids).size, 61);
    const beforeFocus = snapshots;
    assert.equal(client.sendAction(latest.branchId, latest.revision, { type: "focus" }), true);
    await until(() => snapshots > beforeFocus);
    assert.equal(latest.archive.inboxCount, 61);
    await client.sendFeedAction(latest.branchId, latest.revision, { type: "dismiss", itemId: first.itemId });
    await until(() => latest.archive.historyCount === 1);
    assert.equal(latest.archive.inboxCount, 60);
    const archived = await client.requestPage(latest.branchId, "history");
    assert.equal(archived.items[0].itemId, first.itemId);
    const originalBranch = latest.branchId;
    client.stop();
    await runtime.stop();
    runtime = new ProjectGlanceRelayRuntime(environment);
    await runtime.ensureForContext({ sessionManager: SessionManager.open(sm.getSessionFile()) });
    await connect();
    assert.equal(latest.branchId, originalBranch);
    assert.equal(latest.archive.historyCount, 1);
    assert.equal(latest.archive.inboxCount, 60);
    assert.equal((await client.requestPage(latest.branchId, "history")).items[0].itemId, first.itemId);
    const restoredBody = await client.requestBody(latest.branchId, first.itemId, 0);
    assert.equal(restoredBody.text, longBody.slice(0, restoredBody.text.length));
  } finally {
    client?.stop();
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});
