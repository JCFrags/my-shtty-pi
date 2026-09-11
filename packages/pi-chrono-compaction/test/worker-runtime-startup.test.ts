import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeTrustedWorkerRuntime, type WorkerRuntimeStartupTestInterface } from "../src/worker-runtime-startup.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const limits = { slots: { min: 1, max: 4 }, timeoutSeconds: { min: 30, max: 3600 }, nice: { min: 0, max: 19 }, hostMemoryBytes: 2 * 1024 * 1024 * 1024, sourceBytes: 256 * 1024 * 1024 };
const workers = ["catalog-worker-entry.js", "capsule-worker-entry.js", "search-v3-worker-entry.js", "compaction-worker-entry.js", "history-worker-entry.js", "worker-runtime-bootstrap.js", "worker-runtime-bridge.js"];

async function privateFile(path: string, value = ""): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(value); } finally { await handle.close(); }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chrono-startup-test-"));
  const packagePath = join(root, "package"), source = join(packagePath, "dist/src");
  await mkdir(source, { recursive: true, mode: 0o700 });
  const packageJson = JSON.stringify({ name: "pi-chrono-compact", version: "2.0.7", type: "module" });
  const dummy = "export const fixture = true;\n";
  await writeFile(join(packagePath, "package.json"), packageJson); await writeFile(join(source, "dummy.js"), dummy);
  const configPath = join(root, "config.json"), configuration = { hostWorkerSlots: 2, workerTimeoutSeconds: 900, workerNiceLevel: 10, isolatedWorkerEnabled: true };
  await writeFile(configPath, JSON.stringify(configuration));
  const authorizationPath = join(root, "authorization.json");
  const authorization = {
    schemaVersion: 1, purpose: "chrono-trusted-fresh-boot-startup",
    package: { path: packagePath, name: "pi-chrono-compact", version: "2.0.7", sourceCommit: "a".repeat(40), files: { "package.json": hash(packageJson), "dist/src/dummy.js": hash(dummy) } },
    configuration: { path: configPath, projectionKeys: ["hostWorkerSlots", "workerTimeoutSeconds", "workerNiceLevel", "isolatedWorkerEnabled"], projectionSha256: hash(JSON.stringify(configuration)) },
    policy: { schemaVersion: 2 }, workerProcessBasenames: workers,
  };
  await privateFile(authorizationPath, JSON.stringify(authorization));
  const runtimeDirectory = join(root, "runtime"), legacyDirectory = join(root, "legacy"), lockPath = join(root, "startup.lock");
  let installs = 0, quiescenceChecks = 0;
  const gateValid = async () => {
    try {
      const runtime = await readdir(runtimeDirectory), legacy = await readdir(legacyDirectory);
      return runtime.includes("legacy-gate.json") && [0, 1, 2, 3].every(slot => legacy.includes(`slot-${slot}.json`));
    } catch { return false; }
  };
  const testOnly: WorkerRuntimeStartupTestInterface = {
    runtimeDirectory, legacyDirectory, lockPath,
    processQuiescent: async names => { quiescenceChecks++; assert.deepEqual(names, workers); return true; },
    apis: {
      defaultRuntimeDirectory: () => { throw new Error("production-path-used"); }, legacySchedulerDirectory: () => { throw new Error("production-path-used"); },
      runtimeUnitName: (_directory, slot) => `fixture-${slot}`, runtimeUnitState: async () => "inactive", limits,
      verifyLegacyAdmissionGate: gateValid,
      installLegacyAdmissionGate: async options => {
        installs++;
        await privateFile(join(options.runtimeDirectory, "admission.lock"));
        for (let slot = 0; slot < 4; slot++) await privateFile(join(options.legacyDirectory, `slot-${slot}.json`), "{}");
        assert.equal(await options.confirmLegacyQuiescent(), true);
        await privateFile(join(options.runtimeDirectory, "legacy-gate.json"), "{}");
      },
    },
  };
  return { root, packagePath, authorizationPath, runtimeDirectory, legacyDirectory, testOnly, installs: () => installs, checks: () => quiescenceChecks };
}

test("trusted startup initializes only fresh state, serializes repeats, and refuses unsafe or foreign state", async t => {
  await t.test("fresh and concurrent repeat", async () => {
    const f = await fixture();
    try {
      const results = await Promise.all(Array.from({ length: 3 }, () => initializeTrustedWorkerRuntime({ authorizationPath: f.authorizationPath, expectedPackagePath: f.packagePath, testOnly: f.testOnly })));
      assert.equal(results.filter(result => result.changed).length, 1); assert.equal(results.every(result => result.ready), true); assert.equal(f.installs(), 1);
      assert.ok(f.checks() >= 6); assert.equal(JSON.parse(await readFile(join(f.runtimeDirectory, "policy.json"), "utf8")).schemaVersion, 2);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  await t.test("unsafe authorization", async () => {
    const f = await fixture(); try { await chmod(f.authorizationPath, 0o644); await assert.rejects(initializeTrustedWorkerRuntime({ authorizationPath: f.authorizationPath, testOnly: f.testOnly }), /unsafe-file/); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  });
  await t.test("partial namespace", async () => {
    const f = await fixture(); try { await mkdir(f.runtimeDirectory, { mode: 0o700 }); await assert.rejects(initializeTrustedWorkerRuntime({ authorizationPath: f.authorizationPath, testOnly: f.testOnly }), /partial-or-foreign-namespace/); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  });
  await t.test("foreign artifact in otherwise healthy namespace", async () => {
    const f = await fixture(); try {
      await initializeTrustedWorkerRuntime({ authorizationPath: f.authorizationPath, testOnly: f.testOnly }); await privateFile(join(f.runtimeDirectory, "foreign.json"), "{}");
      await assert.rejects(initializeTrustedWorkerRuntime({ authorizationPath: f.authorizationPath, testOnly: f.testOnly }), /partial-or-foreign-namespace/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  await t.test("owned-looking malformed ticket is ambiguous", async () => {
    const f = await fixture(); try {
      await initializeTrustedWorkerRuntime({ authorizationPath: f.authorizationPath, testOnly: f.testOnly });
      await privateFile(join(f.runtimeDirectory, `ticket-${"b".repeat(32)}.json`), "{}");
      await assert.rejects(initializeTrustedWorkerRuntime({ authorizationPath: f.authorizationPath, testOnly: f.testOnly }), /malformed-scheduler-artifact/);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
