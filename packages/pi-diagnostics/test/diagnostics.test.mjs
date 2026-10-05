import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { collect, loadedIdentity } from "../src/collect.ts";
import { CHECKS } from "../src/audits.ts";
import { boundReport, checkCatalog, MODEL_BYTES, renderMarkdown } from "../src/render.ts";
import { Output, Parameters } from "../src/schema.ts";
import { saveReport } from "../src/export.ts";

const loaded = loadedIdentity(new URL("../extensions/index.ts", import.meta.url));
const fixture = {
  getSettings: () => ({ packages: [{ source: "/private/example", extensions: ["index.ts"] }] }),
  getAllTools: () => [{ name: "fixture", exposure: "direct", sourceInfo: { path: "/private/example", source: "local" }, description: "RAW_CONTENT_DO_NOT_COPY" }],
  getActiveTools: () => ["fixture"],
  events: { emit(event, request) {
    if (event === "grounded:session-transition-readiness:v1") return request.accept({ protocolVersion: 1, runningProcesses: 0, openSessions: 0 });
    if (request.provider === "telemetry") request.respond({ protocolVersion: 1, provider: "telemetry", observedAt: new Date().toISOString(), status: {
      run: "fixture-run", active: true, storage: { state: "full", error: "global_cap", dropped: 1, shutdownUnconfirmed: 0 },
      quality: { state: "unknown" }, raw: "RAW_CONTENT_DO_NOT_COPY",
    } });
    else if (request.provider === "progressive-tools") request.respond({ protocolVersion: 1, provider: request.provider, observedAt: new Date().toISOString(), status: {
      violationCount: 0, configurationErrorCount: 0, unclassifiedCount: 0, configurationObservedAt: new Date().toISOString(), entries: [],
    } });
  } },
};
const ctx = {
  mode: "print", model: { id: "fixture", provider: "fixture", contextWindow: 1000 },
  getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 1000 }),
  isIdle: () => true, hasPendingMessages: () => false,
};

test("shared bounded evidence: mismatch, full storage, unknown context, typed catalog, and no raw content", async () => {
  const report = boundReport(await collect(fixture, ctx, { ...loaded, sha256: "0".repeat(64) }, {
    topics: ["session", "components", "telemetry", "tools", "resources"], view: "detailed", limit: 1,
    checkIds: ["runtime.loaded-source-match", "telemetry.storage-health", "context.headroom-status", "state.provider-readiness"],
  }));
  assert.equal(Value.Check(Output, report), true);
  assert.deepEqual(report.findings.map(item => item.outcome), ["fail", "warn", "unknown", "unknown"]);
  assert.equal(report.complete, false);
  assert.equal(report.page.nextOffset, 1);
  const fields = report.providers.flatMap(item => item.fields);
  assert.equal(fields.find(item => item.id === "quality.state").value, "unknown");
  assert.equal(fields.find(item => item.id === "session.nativeTotals").value, null);
  const json = JSON.stringify(report);
  assert(!json.includes("/private/example"));
  assert(!json.includes("RAW_CONTENT_DO_NOT_COPY"));
  assert(renderMarkdown(report).includes("telemetry.storage.state"));
  assert.equal(checkCatalog().checks.length, CHECKS.length);
  assert.equal(Value.Check(Parameters, { action: "inspect", topics: ["tools"] }), true);
  assert.equal(Value.Check(Parameters, { action: "audit" }), false);
  assert.equal(Value.Check(Parameters, { action: "status", command: "repair" }), false);
  assert.equal(Value.Check(Parameters, { action: "audit", checkIds: ["arbitrary"] }), false);
  const oversized = structuredClone(report);
  const detail = oversized.providers.find(item => item.provider === "details");
  detail.fields = Array.from({ length: 50 }, (_, i) => ({ id: `fixture.${i}`, value: "x".repeat(500), unit: "fixture", basis: "reported" }));
  const bounded = boundReport(oversized);
  assert(Buffer.byteLength(JSON.stringify(bounded)) <= MODEL_BYTES);
  assert.equal(bounded.page.truncated, true);
  assert(bounded.findings.some(item => item.evidence.includes("telemetry.storage.state")));
  const controller = new AbortController(); controller.abort();
  const cancelled = await collect(fixture, ctx, loaded, { topics: [], checkIds: ["runtime.compatibility"] }, controller.signal);
  assert.equal(cancelled.findings[0].outcome, "skipped");
});

test("explicit local export is private, exclusive, and refuses symlink destinations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-diagnostics-export-"));
  try {
    const directory = join(root, "reports"); await mkdir(directory, { mode: 0o700 });
    const path = join(directory, "report.json");
    const report = checkCatalog();
    assert.equal(await saveReport(report, "json", path), path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), report);
    await assert.rejects(saveReport(report, "json", path), /already exists/);
    const link = join(root, "linked"); await symlink(directory, link);
    await assert.rejects(saveReport(report, "markdown", join(link, "report.md")), /symlinks/);
    await assert.rejects(saveReport(report, "json", "relative.json"), /absolute/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
