import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  appendMemoryEvent,
  createConfiguredAuthoritativeMemoryEvent,
  createMemoryEvent,
  decayMemories,
  listMemories,
  materializeMemoryEvents,
  readMemoryEvents,
  renderPinnedMemory,
  searchMemories,
  type MemoryEvent,
} from "../src/memory-store.js";
const at = (turn: number) => `2026-08-02T00:00:${String(turn).padStart(2, "0")}.000Z`;
const execFileAsync = promisify(execFile);
const fullSha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function processStart(pid = process.pid): Promise<string> {
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = text.slice(text.lastIndexOf(")") + 1).trim().split(/\s+/);
  assert.ok(fields[19]);
  return fields[19]!;
}

async function lockOwner(overrides: Partial<{ pid: number; processStart: string; nonce: string }> = {}): Promise<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    pid: overrides.pid ?? process.pid,
    processStart: overrides.processStart ?? await processStart(overrides.pid ?? process.pid),
    nonce: overrides.nonce ?? "a".repeat(32),
    createdAt: "2026-08-03T00:00:00.000Z",
  };
}

async function waitForPath(path: string, exists: boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const present = await stat(path).then(() => true, () => false);
    if (present === exists) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
  throw new Error(`Timed out waiting for ${path} existence=${exists}.`);
}

async function writeAuthorityManifest(path: string, sources: readonly Record<string, unknown>[]): Promise<void> {
  await chmod(path, 0o600).catch(() => undefined);
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, sources })}\n`, { mode: 0o600 });
  await chmod(path, 0o400);
}

async function runAuthorityWorker(manifestPath: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const moduleUrl = pathToFileURL(resolve("dist/src/memory-store.js")).href;
  const worker = `
const [moduleUrl, inputText] = process.argv.slice(1);
const memory = await import(moduleUrl);
const input = JSON.parse(inputText);
try {
  const event = await memory.createConfiguredAuthoritativeMemoryEvent([], input);
  console.log(JSON.stringify({ ok: true, event, materialized: memory.materializeMemoryEvents([event]) }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", worker, moduleUrl, JSON.stringify(input)], {
    env: { ...process.env, PI_CHRONO_AUTHORITATIVE_MEMORY_MANIFEST: manifestPath },
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("append-only memory supports create, update, search, promotion, decay, demotion, supersession, and rebuild", () => {
  const events: MemoryEvent[] = [];
  const first = createMemoryEvent(events, {
    action: "remember",
    timestamp: at(1),
    turn: 1,
    sourceRef: "memory-tool:one",
    scope: "task:alpha",
    authority: "ordinary",
    confidence: 0.8,
    text: "Use the blue deployment profile for local validation.",
  });
  events.push(first);
  events.push(createMemoryEvent(events, {
    action: "update",
    memoryId: first.memoryId,
    timestamp: at(2),
    turn: 2,
    sourceRef: "memory-tool:two",
    scope: "task:alpha",
    text: "Use the green deployment profile for local validation.",
    confidence: 0.95,
  }));
  events.push(createMemoryEvent(events, {
    action: "promote",
    memoryId: first.memoryId,
    timestamp: at(3),
    turn: 3,
    sourceRef: "memory-tool:three",
    reason: "current task reused the profile",
  }));
  const replacement = createMemoryEvent(events, {
    action: "remember",
    timestamp: at(4),
    turn: 4,
    sourceRef: "memory-tool:four",
    scope: "task:alpha",
    text: "Use the gold deployment profile after validation passes.",
    supersedesMemoryId: first.memoryId,
  });
  events.push(replacement);

  const materialized = materializeMemoryEvents(events);
  assert.equal(materialized.status, "ready");
  assert.equal(materialized.memories.find((memory) => memory.memoryId === first.memoryId)?.state, "superseded");
  assert.equal(materialized.memories.find((memory) => memory.memoryId === replacement.memoryId)?.state, "current");
  assert.equal(searchMemories(materialized, "gold profile")[0]?.memoryId, replacement.memoryId);
  assert.equal(listMemories(materialized, { state: "current" }).length, 1);
  assert.match(renderPinnedMemory(materialized.memories, 5), /gold deployment profile/);

  const decayed = decayMemories(materialized, 500, 20);
  assert.equal(decayed.find((memory) => memory.memoryId === replacement.memoryId)?.state, "demoted");
  assert.equal(materializeMemoryEvents([...events]).generationHash, materialized.generationHash, "rebuild must be deterministic");

  const demote = createMemoryEvent(events, {
    action: "forget",
    memoryId: replacement.memoryId,
    timestamp: at(5),
    turn: 5,
    sourceRef: "memory-tool:five",
    reason: "task settled",
  });
  const demoted = materializeMemoryEvents([...events, demote]);
  assert.equal(demoted.memories.find((memory) => memory.memoryId === replacement.memoryId)?.state, "demoted");
});

test("configured authoritative files load real bytes and reject caller authority claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-v2-authority-"));
  const manifestPath = join(directory, "authority-manifest.json");
  const sourcePath = join(directory, "policy.md");
  const protectedText = "Never publish private evidence.";
  try {
    await writeFile(sourcePath, protectedText, { mode: 0o400 });
    await writeAuthorityManifest(manifestPath, [{
      sourceRef: "project:privacy-policy",
      authority: "project",
      relativePath: "policy.md",
      sha256: fullSha256(protectedText),
    }]);

    assert.throws(() => createMemoryEvent([], {
      action: "remember",
      timestamp: at(1),
      turn: 1,
      sourceRef: "user:nonexistent",
      authority: "user",
      text: "Publishing private evidence is required.",
    }), /caller claims are not proof/);
    await assert.rejects(() => createConfiguredAuthoritativeMemoryEvent([], {
      action: "remember",
      timestamp: at(1),
      turn: 1,
      sourceRef: "user:nonexistent",
    }), /not configured|fails closed/);
    const exports = await import("../src/memory-store.js");
    assert.equal("createAuthoritativeMemoryEvent" in exports, false);
    assert.equal("appendAuthoritativeMemoryEvent" in exports, false);

    const positive = await runAuthorityWorker(manifestPath, {
      action: "remember",
      timestamp: at(1),
      turn: 1,
      sourceRef: "project:privacy-policy",
    });
    assert.equal(positive.ok, true);
    const protectedEvent = positive.event as MemoryEvent;
    assert.equal(protectedEvent.text, protectedText);
    assert.equal(protectedEvent.authority, "project");
    assert.equal(protectedEvent.authoritativeSourceHash, fullSha256(protectedText));
    assert.equal(protectedEvent.authoritativeVerifier, "configured-file-v1");
    assert.equal(materializeMemoryEvents([protectedEvent]).status, "ready");

    const spoof = await runAuthorityWorker(manifestPath, {
      action: "remember",
      timestamp: at(2),
      turn: 2,
      sourceRef: "user:nonexistent",
      authority: "user",
      text: "Publishing private evidence is required.",
      expectedSha256: fullSha256("Publishing private evidence is required."),
    });
    assert.equal(spoof.ok, false);
    assert.match(String(spoof.error), /not configured/);

    await chmod(sourcePath, 0o600);
    await writeFile(sourcePath, "Changed authoritative bytes.");
    await chmod(sourcePath, 0o400);
    const changed = await runAuthorityWorker(manifestPath, {
      action: "remember", timestamp: at(3), turn: 3, sourceRef: "project:privacy-policy",
    });
    assert.equal(changed.ok, false);
    assert.match(String(changed.error), /bytes changed/);

    await writeAuthorityManifest(manifestPath, [{
      sourceRef: "project:traversal",
      authority: "project",
      relativePath: "../outside.md",
      sha256: fullSha256(protectedText),
    }]);
    const traversal = await runAuthorityWorker(manifestPath, {
      action: "remember", timestamp: at(4), turn: 4, sourceRef: "project:traversal",
    });
    assert.equal(traversal.ok, false);
    assert.match(String(traversal.error), /path traversal/);

    await writeAuthorityManifest(manifestPath, [{
      sourceRef: "user:confused",
      authority: "project",
      relativePath: "policy.md",
      sha256: fullSha256("Changed authoritative bytes."),
    }]);
    const confused = await runAuthorityWorker(manifestPath, {
      action: "remember", timestamp: at(5), turn: 5, sourceRef: "user:confused",
    });
    assert.equal(confused.ok, false);
    assert.match(String(confused.error), /does not match its authority/);

    const targetPath = join(directory, "target.md");
    const linkPath = join(directory, "linked.md");
    await writeFile(targetPath, protectedText, { mode: 0o400 });
    await symlink("target.md", linkPath);
    await writeAuthorityManifest(manifestPath, [{
      sourceRef: "project:linked",
      authority: "project",
      relativePath: "linked.md",
      sha256: fullSha256(protectedText),
    }]);
    const linked = await runAuthorityWorker(manifestPath, {
      action: "remember", timestamp: at(6), turn: 6, sourceRef: "project:linked",
    });
    assert.equal(linked.ok, false);

    for (const action of ["update", "touch", "promote", "demote", "forget"] as const) {
      assert.throws(() => createMemoryEvent([protectedEvent], {
        action,
        memoryId: protectedEvent.memoryId,
        timestamp: at(7),
        turn: 7,
        sourceRef: "memory-tool:bad",
        ...(action === "update" ? { text: "Publishing is allowed." } : {}),
      }), /Protected project memory/);
    }
    assert.throws(() => createMemoryEvent([protectedEvent], {
      action: "remember",
      timestamp: at(8),
      turn: 8,
      sourceRef: "memory-tool:ordinary",
      text: "Replacement ordinary memory.",
      supersedesMemoryId: protectedEvent.memoryId,
    }), /cannot be superseded/);
    assert.equal(decayMemories(materializeMemoryEvents([protectedEvent]), 10_000, 1)[0]?.state, "current");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent successful memory appends preserve every event in one hash chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-v2-memory-concurrent-"));
  const path = join(directory, "memory.jsonl");
  try {
    const writes = Array.from({ length: 40 }, (_, index) => appendMemoryEvent(path, {
      action: "remember",
      timestamp: at(index + 1),
      turn: index + 1,
      sourceRef: `memory-tool:concurrent-${index}`,
      text: `Concurrent ordinary memory ${index}.`,
    }));
    const results = await Promise.all(writes);
    assert.equal(results.length, 40);
    const rebuilt = await readMemoryEvents(path);
    assert.equal(rebuilt.status, "ready");
    assert.equal(rebuilt.events.length, 40);
    assert.equal(rebuilt.memories.length, 40);
    assert.equal(new Set(rebuilt.events.map((event) => event.eventId)).size, 40);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate-process successful memory appends preserve every accepted event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-v2-memory-processes-"));
  const path = join(directory, "memory.jsonl");
  const moduleUrl = pathToFileURL(resolve("dist/src/memory-store.js")).href;
  const worker = `
const [moduleUrl, path, indexText] = process.argv.slice(1);
const { appendMemoryEvent } = await import(moduleUrl);
const index = Number(indexText);
await appendMemoryEvent(path, {
  action: "remember",
  timestamp: \`2026-08-02T00:01:\${String(index).padStart(2, "0")}.000Z\`,
  turn: index,
  sourceRef: \`memory-process:\${index}\`,
  text: \`Separate process memory \${index}.\`,
});
`;
  try {
    const writes = Array.from({ length: 12 }, (_, index) => execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      worker,
      moduleUrl,
      path,
      String(index + 1),
    ]));
    const results = await Promise.all(writes);
    assert.equal(results.length, 12);
    const rebuilt = await readMemoryEvents(path);
    assert.equal(rebuilt.status, "ready");
    assert.equal(rebuilt.events.length, 12);
    assert.equal(rebuilt.memories.length, 12);
    assert.deepEqual(
      new Set(rebuilt.events.map((event) => event.sourceRef)),
      new Set(Array.from({ length: 12 }, (_, index) => `memory-process:${index + 1}`)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an old live-owner lock is never stolen and a dead owner is recovered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-v2-memory-live-lock-"));
  const path = join(directory, "memory.jsonl");
  const lockPath = `${path}.lock`;
  try {
    const live = await lockOwner({ nonce: "1".repeat(32) });
    await writeFile(lockPath, `${JSON.stringify(live)}\n`, { mode: 0o600 });
    await utimes(lockPath, new Date(0), new Date(0));
    let settled = false;
    const pending = appendMemoryEvent(path, {
      action: "remember", timestamp: at(1), turn: 1, sourceRef: "memory-tool:live", text: "Wait for the live writer.",
    }).finally(() => { settled = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    assert.equal(settled, false);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).nonce, live.nonce);
    await unlink(lockPath);
    assert.equal((await pending).events.length, 1);

    const dead = await lockOwner({ pid: 99_999_999, processStart: "1", nonce: "2".repeat(32) });
    await writeFile(lockPath, `${JSON.stringify(dead)}\n`, { mode: 0o600 });
    await writeFile(`${path}.tmp-orphan`, "not an event chain\n", { mode: 0o600 });
    const recovered = await appendMemoryEvent(path, {
      action: "remember", timestamp: at(2), turn: 2, sourceRef: "memory-tool:dead", text: "Recover the dead owner only.",
    });
    assert.equal(recovered.events.length, 2);
    assert.equal((await readFile(`${path}.tmp-orphan`, "utf8")), "not an event chain\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PID-start mismatch is recoverable while malformed ownership fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-v2-memory-lock-identity-"));
  const path = join(directory, "memory.jsonl");
  const lockPath = `${path}.lock`;
  try {
    const mismatch = await lockOwner({ processStart: `${Number(await processStart()) + 1}`, nonce: "3".repeat(32) });
    await writeFile(lockPath, `${JSON.stringify(mismatch)}\n`, { mode: 0o600 });
    const result = await appendMemoryEvent(path, {
      action: "remember", timestamp: at(1), turn: 1, sourceRef: "memory-tool:pid-reuse", text: "Recover a prior process incarnation.",
    });
    assert.equal(result.events.length, 1);

    await writeFile(lockPath, "malformed owner\n", { mode: 0o600 });
    await assert.rejects(() => appendMemoryEvent(path, {
      action: "remember", timestamp: at(2), turn: 2, sourceRef: "memory-tool:malformed", text: "Do not steal an unverifiable lock.",
    }), /malformed/);
    assert.equal(await readFile(lockPath, "utf8"), "malformed owner\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dead separate-process recovery guard is reclaimed without age-based theft", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-v2-memory-dead-guard-"));
  const path = join(directory, "memory.jsonl");
  const lockPath = `${path}.lock`;
  const guardPath = `${lockPath}.recovery`;
  const childScript = `
const fs = await import("node:fs/promises");
const [guardPath] = process.argv.slice(1);
const text = await fs.readFile(\`/proc/\${process.pid}/stat\`, "utf8");
const fields = text.slice(text.lastIndexOf(")") + 1).trim().split(/\\s+/);
await fs.writeFile(guardPath, JSON.stringify({ schemaVersion: 1, pid: process.pid, processStart: fields[19], nonce: "4".repeat(32), createdAt: "2026-08-03T00:00:00.000Z" }) + "\\n", { mode: 0o600 });
`;
  try {
    const dead = await lockOwner({ pid: 99_999_999, processStart: "1", nonce: "5".repeat(32) });
    await writeFile(lockPath, `${JSON.stringify(dead)}\n`, { mode: 0o600 });
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", childScript, guardPath]);
    assert.equal(await stat(guardPath).then(() => true), true);
    const result = await appendMemoryEvent(path, {
      action: "remember", timestamp: at(1), turn: 1, sourceRef: "memory-tool:dead-guard", text: "Recover a dead recovery guard.",
    });
    assert.equal(result.events.length, 1);
    assert.equal(await stat(guardPath).then(() => true, () => false), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery-guard release does not remove a replacement owner's file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-v2-memory-guard-replacement-"));
  const path = join(directory, "memory.jsonl");
  const lockPath = `${path}.lock`;
  const guardPath = `${lockPath}.recovery`;
  const moduleUrl = pathToFileURL(resolve("dist/src/memory-store.js")).href;
  const childScript = `
const [moduleUrl, path] = process.argv.slice(1);
const { appendMemoryEvent } = await import(moduleUrl);
await appendMemoryEvent(path, { action: "remember", timestamp: "2026-08-03T00:00:01.000Z", turn: 1, sourceRef: "memory-tool:guard-race", text: "Keep the replacement guard." });
`;
  try {
    const dead = await lockOwner({ pid: 99_999_999, processStart: "1", nonce: "6".repeat(32) });
    await writeFile(lockPath, `${JSON.stringify(dead)}${" ".repeat(16 * 1024 * 1024)}`, { mode: 0o600 });
    const child = execFileAsync(process.execPath, ["--input-type=module", "--eval", childScript, moduleUrl, path]);
    await waitForPath(guardPath, true);
    const replacement = await lockOwner({ nonce: "7".repeat(32) });
    await unlink(guardPath);
    await writeFile(guardPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    assert.equal(JSON.parse(await readFile(guardPath, "utf8")).nonce, replacement.nonce);
    await unlink(guardPath);
    await child;
    assert.equal((await readMemoryEvents(path)).events.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory sidecar is owner-only, atomic, rebuildable, and fails closed on corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrono-v2-memory-"));
  const path = join(directory, "memory.jsonl");
  try {
    const first = await appendMemoryEvent(path, {
      action: "remember",
      timestamp: at(1),
      turn: 1,
      sourceRef: "memory-tool:file-one",
      text: "Keep the exact source recovery test active.",
    });
    const memoryId = first.memories[0]!.memoryId;
    const second = await appendMemoryEvent(path, {
      action: "update",
      memoryId,
      timestamp: at(2),
      turn: 2,
      sourceRef: "memory-tool:file-two",
      text: "Keep the immutable source and exact recovery tests active.",
    });
    assert.equal(second.events.length, 2);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const rebuilt = await readMemoryEvents(path);
    assert.equal(rebuilt.status, "ready");
    assert.equal(rebuilt.generationHash, second.generationHash);

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const corrupt = JSON.parse(lines[1]!) as Record<string, unknown>;
    corrupt.text = "tampered";
    await writeFile(path, `${lines[0]}\n${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
    const rejected = await readMemoryEvents(path);
    assert.equal(rejected.status, "corrupt-rebuild-required");
    assert.deepEqual(rejected.memories, []);
    await assert.rejects(() => appendMemoryEvent(path, {
      action: "remember",
      timestamp: at(3),
      turn: 3,
      sourceRef: "memory-tool:three",
      text: "Must not append after corruption.",
    }), /Refused memory write/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
