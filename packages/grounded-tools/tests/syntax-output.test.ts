import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { boundedOutput } from "@grounded/pi-core/output";
import { checkSyntax } from "@grounded/pi-core/syntax";

test("syntax checker reports exact JSON and JavaScript failures", async () => {
  assert.equal((await checkSyntax("x.json", "{\"ok\":true}")).ok, true);
  const json = await checkSyntax("x.json", "{");
  assert.equal(json.checked, true);
  assert.equal(json.ok, false);
  const js = await checkSyntax("x.js", "function () {");
  assert.equal(js.checked, true);
  assert.equal(js.ok, false);
});

test("bounded output preserves a complete spill file", async () => {
  const original = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
  const result = await boundedOutput(original, { prefix: "grounded-test", maxLines: 5, maxBytes: 1000 });
  assert.equal(result.truncated, true);
  assert.ok(result.fullOutputPath);
  assert.equal(await readFile(result.fullOutputPath!, "utf8"), original);
  assert.match(result.text, /Full output:/);
});
