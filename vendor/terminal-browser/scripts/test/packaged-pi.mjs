import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const tools = ["browser_open", "browser_tabs", "browser_observe", "browser_act", "browser_control"];
export function assertPiResources(result, schemaVersion, commandOnly = false) {
  assert.deepEqual(result.errors, []);
  const split = schemaVersion === 3;
  assert([1, 2, 3].includes(schemaVersion));
  assert(split || !commandOnly, "retained single-resource packages have no command-only menu");
  const names = split ? ["menu.js", ...(commandOnly ? [] : ["extension.js"])] : ["extension.js"];
  assert.deepEqual(result.extensions.map(extension => path.basename(extension.resolvedPath)), names);
  assert.deepEqual(result.extensions.flatMap(extension => [...extension.tools.keys()]), commandOnly ? [] : tools);
  assert.deepEqual(result.extensions.flatMap(extension => [...extension.commands.keys()]), split ? ["browser"] : []);
  if (split) {
    assert.equal(result.extensions[0].tools.size, 0);
    assert.equal(result.extensions[0].handlers.get("session_start").length, 1);
    assert.equal(result.extensions[0].handlers.get("session_shutdown").length, 1);
    if (!commandOnly) assert.equal(result.extensions[1].handlers.size, 0, "tools must not own a second lifecycle");
  }
  // The offline loader has no AgentSession runner. Supply only its tool inventory query.
  result.runtime.getAllTools = () => result.extensions.flatMap(extension => [...extension.tools.values()].map(tool => tool.definition));
  return result.extensions[0];
}

export async function piLoader() {
  const { SettingsManager, DefaultResourceLoader, SessionManager, createEventBus } = await import(process.env.PI_ROOT + "/dist/index.js");
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const settings = SettingsManager.create("/tmp/project", agentDir);
  const ctx = { cwd: "/tmp/project", hasUI: false, sessionManager: SessionManager.inMemory("/tmp/project") };
  const installation = JSON.parse(fs.readFileSync(process.env.TERMINAL_BROWSER_INSTALLATION));
  const receipts = path.join(installation.paths.stateHome, installation.namespace, "pi-loaded");
  const count = () => fs.existsSync(receipts) ? fs.readdirSync(receipts).length : 0;
  const bus = createEventBus();
  let identity;
  let lifecycle;
  bus.on("terminal-browser:loaded", value => { identity = value; });
  const loader = new DefaultResourceLoader({ cwd: "/tmp/project", agentDir, settingsManager: settings, eventBus: bus, noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }) });
  const shutdown = async () => {
    for (const handler of lifecycle?.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "reload" }, ctx);
    lifecycle = undefined;
    assert.equal(count(), 0);
  };
  return {
    shutdown,
    async load(artifactId) {
      await shutdown();
      identity = undefined;
      await settings.reload();
      await loader.reload();
      const result = loader.getExtensions();
      assert.deepEqual(result.errors, []);
      assert(result.extensions.length > 0);
      const root = path.resolve(path.dirname(result.extensions[0].resolvedPath), "../..");
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "build-manifest.json")));
      assert.equal(manifest.artifactId, artifactId);
      const selected = settings.getPackages().find(entry => (typeof entry === "string" ? entry : entry.source) === path.join(root, "pi-extension"));
      assert(selected);
      const commandOnly = JSON.stringify(selected.extensions) === JSON.stringify(["dist/menu.js"]);
      lifecycle = assertPiResources(result, manifest.schemaVersion, commandOnly);
      assert.equal(count(), 0, "factory must not write a runtime receipt");
      assert.equal(identity, undefined, "factory must not emit a loaded lifecycle");
      for (const handler of lifecycle.handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "reload" }, ctx);
      assert.equal(identity.artifactId, artifactId);
      assert.equal(count(), 1);
      if (manifest.schemaVersion === 3) {
        assert.deepEqual(identity.loadedResources, commandOnly ? ["dist/menu.js"] : ["dist/menu.js", "dist/extension.js"]);
        assert.equal(identity.toolNames.length, commandOnly ? 0 : 5);
        assert.equal(identity.receiptEntrypoint, "dist/menu.js");
      }
      return identity;
    },
  };
}
