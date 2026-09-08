import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { nextCacheGeneration, readCompactionCache, writeCompactionCache } from "../src/cache.js";
import { compactEntries } from "../src/compactor.js";
import { getActiveBranch, readSessionJsonl } from "../src/jsonl.js";

const fixture = resolve("test/fixtures/session.jsonl");

test("generation cache is atomic, reusable, and rejects malformed sidecars", async () => {
  const path = `/tmp/pi-retro-cache-${randomUUID()}.json`;
  try {
    const session = await readSessionJsonl(fixture);
    const result = await compactEntries(getActiveBranch(session), { config: { targetTokens: 2_500 } });
    await writeCompactionCache(path, {
      schemaVersion: 4,
      generation: 1,
      sourceHash: result.details.generationHash,
      configHash: "config-hash",
      summary: result.summary,
      piSummary: "REGULAR_PI_SUMMARY_ONLY",
      rawTokens: result.rawTokens,
      renderedTokens: result.renderedTokens,
      targetTokens: result.targetTokens,
      details: result.details,
      createdAt: "2026-07-24T00:00:00.000Z",
    });
    const loaded = await readCompactionCache(path);
    assert.ok(loaded);
    assert.equal(loaded.summary, result.summary);
    assert.equal(loaded.piSummary, "REGULAR_PI_SUMMARY_ONLY");
    assert.equal(await nextCacheGeneration(path), 2);
    assert.match(await readFile(path, "utf8"), /\"generation\": 1/);
    assert.equal((await stat(path)).mode & 0o777, 0o600, "new private cache files are owner-only");

    await writeFile(path, `${JSON.stringify({ ...loaded, schemaVersion: 3 })}\n`, "utf8");
    assert.equal(await readCompactionCache(path), undefined, "pre-second-correction cache schema must be stale");

    await writeFile(path, "{malformed", "utf8");
    assert.equal(await readCompactionCache(path), undefined);
    assert.equal(await nextCacheGeneration(path), 1);
  } finally {
    await rm(path, { force: true });
  }
});
