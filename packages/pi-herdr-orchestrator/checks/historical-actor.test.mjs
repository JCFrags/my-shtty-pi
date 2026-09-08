import { historicalEvent } from "./historical-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson } from "../dist/src/shared/canonical-json.js";
import { EventStore } from "../dist/src/state/event-store.js";
import { validateHello } from "../dist/src/shared/protocol/frames.js";


test("historical actor replays without granting new append or hello authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "orch-history-"));
  try {
    const path = join(root, "events.jsonl");
    const event = historicalEvent();
    await writeFile(path, `${canonicalJson(event)}\n`, { mode: 0o600 });
    const store = new EventStore(path);
    await store.open();
    assert.equal(store.readOnly, false);
    assert.equal((await store.verifyDisk()).valid, true);
    await assert.rejects(store.append({ type: "audit.action", actor: event.actor, payload: { action: "not_allowed" } }), /Event chain is invalid/);
    await store.append({ type: "audit.action", payload: { action: "current_fixture" } });
    assert.equal(store.readOnly, false);
    assert.equal((await store.verifyDisk()).lastSeq, 2);
    assert.throws(() => validateHello({
      v: 1, type: "hello", id: "test", sessionKey: "test",
      client: { kind: event.actor.kind, name: "fixture", version: "1", capabilities: [] },
      auth: { kind: "client_secret", secret: "test-only" },
    }), /kind/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
