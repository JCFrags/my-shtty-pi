import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  MAX_CONFIGURED_PREVIEW_BYTES,
  loadConfig,
  validateConfig,
} from "../src/config.js";

test("loadConfig uses safe defaults when the project file is absent", async () => {
  const result = await loadConfig("/project", async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.equal(result.config.nonInteractive, "block");
  assert.equal(result.config.outsideCwd, "double-confirm");
  assert.equal(result.config.allowApproveAllForTurn, false);
});

test("validateConfig accepts typed safe overrides", () => {
  const config = validateConfig({
    reviewEdit: false,
    reviewWrite: true,
    reviewBash: "off",
    allowApproveAllForTurn: true,
    maxPreviewBytes: 4096,
    nonInteractive: "allow",
    outsideCwd: "block",
  });
  assert.deepEqual(config, {
    reviewEdit: false,
    reviewWrite: true,
    reviewBash: "off",
    allowApproveAllForTurn: true,
    maxPreviewBytes: 4096,
    nonInteractive: "allow",
    outsideCwd: "block",
  });
});

test("loadConfig reports malformed JSON", async () => {
  const result = await loadConfig("/project", async () => "{not-json");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /invalid JSON/i);
});

test("validateConfig rejects unknown and invalid values without fallback", () => {
  assert.throws(
    () =>
      validateConfig({
        reviewEdit: "yes",
        reviewBash: "destructive",
        outsideCwd: "allow",
        surprise: true,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unknown key\(s\): surprise/);
      assert.match(error.message, /reviewEdit must be boolean/);
      assert.match(error.message, /reviewBash supports only "off"/);
      assert.match(error.message, /outsideCwd must be/);
      return true;
    },
  );
});

test("validateConfig rejects dangerous preview limits", () => {
  assert.throws(() => validateConfig({ maxPreviewBytes: 0 }), /maxPreviewBytes/);
  assert.throws(
    () => validateConfig({ maxPreviewBytes: MAX_CONFIGURED_PREVIEW_BYTES + 1 }),
    /maxPreviewBytes/,
  );
  assert.throws(() => validateConfig({ maxPreviewBytes: 1.5 }), /maxPreviewBytes/);
});

test("loadConfig reports read errors other than ENOENT", async () => {
  const result = await loadConfig("/project", async () => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /cannot read configuration: permission denied/);
});
