#!/usr/bin/env node
// @ts-nocheck
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { readBoundedSessionJsonl } from "../dist-test/src/jsonl.js";
import { buildLocalSearchIndex } from "../dist-test/src/search-index.js";
import { parseBranchEntries } from "../dist-test/src/jsonl.js";

const SCHEMA_VERSION = 1;
const LEGACY_LIMIT = 64 * 1024 * 1024;

function collect() { if (typeof global.gc === "function") global.gc(); return process.memoryUsage(); }
function deterministicUniqueText(index, bytes) {
  let output = "";
  let ordinal = 0;
  while (output.length < bytes) { output += ` unique-${index}-${ordinal} path/synthetic/${index}/${ordinal}`; ordinal += 1; }
  return output.slice(0, bytes);
}
function legacyEstimate(index) {
  return index.documents.reduce((total, document) => total + Buffer.byteLength(document.block.exactText) + (document.bodyTerms.size + document.pathTerms.size + document.identifierTerms.size) * 48, 0);
}

async function thresholdRace(directory) {
  const path = join(directory, "threshold.jsonl");
  const prefix = `${JSON.stringify({ type: "session", version: 3, id: "threshold" })}\n{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"`;
  const suffix = '"}}\n';
  const padding = "x".repeat(LEGACY_LIMIT - Buffer.byteLength(prefix) - Buffer.byteLength(suffix));
  await writeFile(path, prefix + padding + suffix, { mode: 0o600 });
  let requestedBytes = 0, bytesRead = 0, code = "unexpected-success";
  const started = performance.now();
  try {
    await readBoundedSessionJsonl(path, LEGACY_LIMIT, { async afterOpened() { await appendFile(path, "yy"); }, onRead(requested, observed) { requestedBytes += requested; bytesRead += observed; } });
  } catch (error) { code = error instanceof Error ? error.message : "unknown"; }
  return { deterministic: { limitBytes: LEGACY_LIMIT, initialBytes: LEGACY_LIMIT, appendedBytes: 2, requestedBytes, bytesRead, refusalCode: code, parseReached: false }, advisory: { wallMs: performance.now() - started } };
}

function indexAccounting() {
  const entries = [];
  let parentId = null;
  for (let index = 0; index < 512; index += 1) {
    const id = `u${index}`;
    entries.push({ type: "message", id, parentId, message: { role: "user", content: deterministicUniqueText(index, 2048) } });
    parentId = id;
  }
  const serialized = entries.map((entry) => JSON.stringify(entry)).join("\n");
  const before = collect();
  const session = parseBranchEntries(entries);
  const afterParse = collect();
  const started = performance.now();
  const index = buildLocalSearchIndex(session);
  const afterIndex = collect();
  const estimate = legacyEstimate(index);
  const sourceBytes = Buffer.byteLength(serialized);
  const retainedDelta = Math.max(0, afterIndex.heapUsed - before.heapUsed);
  const conservativeAdmissionBytes = Math.max(8 * 1024 * 1024, sourceBytes * 32);
  return {
    deterministic: {
      sourceBytes,
      documents: index.documents.length,
      legacyEstimatedBytes: estimate,
      conservativeAdmissionBytes,
      admissionMultiplier: 32,
      admissionComponents: {
        liveIndexBytes: Math.floor(conservativeAdmissionBytes * 10 / 32),
        retainedReferenceBytes: Math.floor(conservativeAdmissionBytes * 18 / 32),
        queryResultBytes: conservativeAdmissionBytes - Math.floor(conservativeAdmissionBytes * 10 / 32) - Math.floor(conservativeAdmissionBytes * 18 / 32),
      },
      legacyAccountingKnownOmissionClasses: 7,
    },
    advisory: {
      buildMs: performance.now() - started,
      heapUsedBefore: before.heapUsed,
      heapUsedAfterParse: afterParse.heapUsed,
      heapUsedAfterIndex: afterIndex.heapUsed,
      retainedHeapDelta: retainedDelta,
      retainedToLegacyEstimateRatio: estimate === 0 ? 0 : retainedDelta / estimate,
      observedMaterialUnderstatement: retainedDelta > estimate * 2,
      admissionCoveredObservedRetained: conservativeAdmissionBytes >= retainedDelta,
      admissionHeadroomRatio: retainedDelta === 0 ? null : conservativeAdmissionBytes / retainedDelta,
      peakRssKiB: process.resourceUsage().maxRSS,
    },
  };
}

export async function runMemoryCharacterization() {
  const directory = await mkdtemp(join(tmpdir(), "chrono-memory-characterization-"));
  try {
    const threshold = await thresholdRace(directory);
    const index = indexAccounting();
    const thresholdPassed = threshold.deterministic.refusalCode === "history-source-changed" && threshold.deterministic.requestedBytes === LEGACY_LIMIT && threshold.deterministic.bytesRead === LEGACY_LIMIT;
    const accountingPassed = index.advisory.observedMaterialUnderstatement === true && index.advisory.admissionCoveredObservedRetained === true;
    const status = thresholdPassed && accountingPassed ? "passed" : "failed";
    return { schemaVersion: SCHEMA_VERSION, kind: "chrono-m02-memory-characterization", status, deterministic: { threshold: threshold.deterministic, index: index.deterministic }, advisory: { threshold: threshold.advisory, index: index.advisory } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runMemoryCharacterization().then((result) => { console.log(JSON.stringify(result)); if (result.status !== "passed") process.exitCode = 1; }).catch(() => { console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, kind: "chrono-m02-memory-characterization", status: "failed", failureCode: "characterization-failed" })); process.exitCode = 1; });
