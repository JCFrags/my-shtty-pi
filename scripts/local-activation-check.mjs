#!/usr/bin/env node
// Load resource registrations only. Never open a session or send a model prompt.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const candidate = value("--candidate");
const expectV1 = args.includes("--expect-v1");
const agentDir = resolve(value("--agent-dir") ?? join(homedir(), ".pi", "agent"));
const sdkRoot = value("--sdk-root") ?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const sandbox = await mkdtemp(join(tmpdir(), "pi-registration-check-"));
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";

function localSource(source) {
  assert.equal(typeof source, "string", "Resource source must be a string");
  if (/^(?:npm:|git:|https?:|ssh:)/u.test(source)) throw new Error("Remote resource sources require explicit local preparation");
  return source.startsWith("~") ? join(homedir(), source.slice(1)) : resolve(agentDir, source);
}
async function metadata(source) {
  try { return JSON.parse(await readFile(join(source, "package.json"), "utf8")); }
  catch { return undefined; }
}
try {
  const original = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  const packages = [];
  for (const item of original.packages ?? []) {
    const source = localSource(typeof item === "string" ? item : item.source);
    const manifest = await metadata(source);
    if (candidate && manifest?.name === "pi-signal-board") continue;
    const target = candidate && ["pi-project-glance", "pi-herdr-orchestrator"].includes(manifest?.name)
      ? join(resolve(candidate), "packages", manifest.name) : source;
    packages.push(typeof item === "string" ? target : { ...item, source: target });
  }
  const extensions = (original.extensions ?? []).map((item) => {
    assert.equal(typeof item, "string", "Unsupported extension resource setting");
    const negative = item.startsWith("!");
    return `${negative ? "!" : ""}${localSource(negative ? item.slice(1) : item)}`;
  });
  // Include the real auto-discovery directory through an explicit resource path;
  // do not copy credentials, model configuration, sessions, or private data.
  extensions.push(join(agentDir, "extensions"));
  const cwd = join(sandbox, "cwd");
  const isolatedAgent = join(sandbox, "agent");
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(isolatedAgent, { mode: 0o700 });
  await writeFile(join(isolatedAgent, "settings.json"), JSON.stringify({ packages, extensions }), { mode: 0o600 });
  const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
  const loader = new DefaultResourceLoader({
    cwd, agentDir: isolatedAgent,
    settingsManager: SettingsManager.create(cwd, isolatedAgent),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  // Do not print raw loader errors: they can contain sensitive configuration.
  assert.equal(loaded.errors.length, 0, `Resource loader failed for ${loaded.errors.length} extension(s)`);
  const registry = loaded.extensions.map((extension) => ({
    name: extension.resolvedPath.split("/").slice(-2).join("/"),
    commands: [...extension.commands.keys()], tools: [...extension.tools.keys()],
  }));
  const commands = registry.flatMap((entry) => entry.commands);
  const tools = registry.flatMap((entry) => entry.tools);
  if (expectV1) {
    assert.equal(commands.filter((name) => name === "project-glance").length, 1);
    assert.equal(commands.filter((name) => name === "agent-settings").length, 1);
    assert.equal(tools.filter((name) => name === "orchestrate").length, 1);
    assert(!commands.some((name) => ["signals", "signalboard", "agent-board", "pi-herd"].includes(name)));
    assert(!tools.some((name) => /^(?:signal_board_|project[_-]glance)/u.test(name)));
    const glance = loaded.extensions.filter((extension) => extension.commands.has("project-glance"));
    assert.equal(glance[0].tools.size, 0);
    assert.equal(glance[0].shortcuts.size, 0);
  }
  console.log(JSON.stringify({
    status: "pass", scope: candidate ? "candidate registrations" : "linked registrations",
    activatedInExistingSession: false, modelPromptSent: false,
    extensions: registry.length, commands: [...commands].sort(), tools: [...tools].sort(),
  }, null, 2));
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
