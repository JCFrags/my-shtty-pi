import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("public documentation describes the old history editor only as retired compatibility", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  const architecture = await readFile(resolve("docs/architecture.md"), "utf8");
  assert.doesNotMatch(readme, /separate, default-off `Experimental LLM history classifier` setting|Enable the experimental one-job V1\.1/);
  assert.doesNotMatch(architecture, /history-editor\.ts` can run one optional model job after deterministic planning/);
  assert.match(`${readme}\n${architecture}`, /retired from extension use/i);
});

test("authoritative hand-off documents the replay-only degraded summary fallback", async () => {
  const handoff = await readFile(resolve("docs/hand-off.md"), "utf8");
  assert.match(handoff, /If Pi's regular summary generation is unavailable/i);
  assert.match(handoff, /replay-only degraded fallback/i);
  assert.match(handoff, /operational failure path/i);
});
