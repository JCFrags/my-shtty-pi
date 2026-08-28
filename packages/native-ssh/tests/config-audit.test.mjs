import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, symlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, AUTHORIZATION_STATEMENT, selectTransferTarget } from "../src/config.mjs";
import { PrivateAudit } from "../src/audit.mjs";

test("package limits the Pi peer and compatibility to tested 0.84.1-0.84.2 releases", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.84.1 <0.84.3");
  assert.deepEqual(manifest.piCompatibility, { minimum: "0.84.1", maximum: "0.84.2" });
});

function document(root, overrides = {}) {
  return {
    version: 2,
    targets: { fixture: { destination: "fixture", displayName: "Fixture", defaultCwd: "/", authorization: { boundary: "openssh-and-remote-account", confirmed: true, statement: AUTHORIZATION_STATEMENT } } },
    audit: { enabled: false, path: null, maxBytes: 4096 },
    limits: { commandTimeoutMs: 30000, maxTransferBytes: 8388608 },
    ...overrides,
  };
}

test("transfer target selection is automatic only when unambiguous and gives discoverable guidance", () => {
  const alpha = { name: "alpha" };
  const beta = { name: "beta" };
  assert.equal(selectTransferTarget({ alpha }, undefined), alpha);
  assert.equal(selectTransferTarget({ beta, alpha }, "beta"), beta);
  assert.throws(
    () => selectTransferTarget({ beta, alpha }, undefined),
    error => error.code === "LOCAL_MODE" && /Supply target/.test(error.safeMessage) && /alpha, beta/.test(error.safeMessage),
  );
  assert.throws(
    () => selectTransferTarget({ alpha }, "missing"),
    error => error.code === "TARGET_INVALID" && /Available targets: alpha/.test(error.safeMessage),
  );
});

test("configuration requires private bytes and explicit remote-account authorization", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-config-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "config.json");
  await writeFile(file, JSON.stringify(document(root)), { mode: 0o600 });
  assert.equal(loadConfig(file).targets.fixture.authorization, "openssh-and-remote-account");
  await writeFile(file, JSON.stringify(document(root, { targets: { fixture: { destination: "fixture", displayName: "Fixture", defaultCwd: "/", authorization: { boundary: "openssh-and-remote-account", confirmed: false, statement: AUTHORIZATION_STATEMENT } } } })), { mode: 0o600 });
  assert.throws(() => loadConfig(file), error => error.code === "SSH_CONFIG_INVALID");
  await writeFile(file, JSON.stringify(document(root)), { mode: 0o644 });
  await chmod(file, 0o644);
  assert.throws(() => loadConfig(file), error => error.code === "SSH_CONFIG_INVALID");
});

test("audit output is private, bounded, metadata-only, and cannot follow a symlink", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-remote-audit-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "audit.jsonl");
  const audit = new PrivateAudit({ enabled: true, path: file, maxBytes: 4096 });
  for (let index = 0; index < 200; index++) audit.record({ operation: "read", target: "fixture", code: "OK", durationMs: index, secret: "must-not-appear" });
  await audit.flush();
  const info = await stat(file);
  assert.equal(info.mode & 0o077, 0);
  assert.ok(info.size <= 4096);
  const text = await readFile(file, "utf8");
  assert.doesNotMatch(text, /must-not-appear/);

  const victim = join(root, "victim");
  const link = join(root, "link");
  await writeFile(victim, "unchanged", { mode: 0o600 });
  await symlink(victim, link);
  const unsafe = new PrivateAudit({ enabled: true, path: link, maxBytes: 4096 });
  unsafe.record({ operation: "read" });
  await unsafe.flush();
  assert.equal(await readFile(victim, "utf8"), "unchanged");
});
