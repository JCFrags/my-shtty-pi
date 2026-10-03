import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { runtimeRoot } from "./launch.js";

export const COMPILED_RESOURCES = ["menu.js", "extension.js"] as const;
export const COMPILED_CLOSURE = ["bridge.js", "client.js", "extension.js", "identity.js", "launch-mode.js", "launch.js", "menu.js", "owner-binding.js"] as const;

function capturedIdentity() {
  let artifactId: string | null = null;
  let sourceRevision: string | null = null;
  let build: string | null = null;
  let extensionBuild: string | null = null;
  let menuBuild: string | null = null;
  let closureBuild: string | null = null;
  let processStart: string | null = null;
  try {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (/^[0-9]+$/.test(ticks) && /^[a-f0-9-]{36}$/.test(boot)) processStart = `${boot}:${ticks}`;
  } catch {}
  try {
    const file = path.join(runtimeRoot, "build-manifest.json");
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error("invalid manifest");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const files = manifest.schemaVersion === 3 ? COMPILED_CLOSURE : ["extension.js"];
    if (![1, 2, 3].includes(manifest.schemaVersion)) throw new Error("unsupported artifact");
    if (manifest.schemaVersion === 3 && JSON.stringify(manifest.identity?.integrations?.pi?.extensions) !==
        JSON.stringify(COMPILED_RESOURCES.map(name => `./dist/${name}`))) throw new Error("invalid Pi resource layout");
    const hashes = files.map(name => {
      const file = `pi-extension/dist/${name}`;
      const hash = createHash("sha256").update(fs.readFileSync(path.join(runtimeRoot, file))).digest("hex");
      if (manifest.files?.find((entry: { path: string }) => entry.path === file)?.sha256 !== hash) throw new Error("invalid extension closure");
      return [name, hash] as const;
    });
    const hash = hashes.find(([name]) => name === "extension.js")![1];
    if (!/^[a-f0-9]{64}$/.test(manifest.artifactId) || !/^[a-f0-9]{40}$/.test(manifest.identity?.source?.commit)) throw new Error("invalid artifact");
    const browser = manifest.files?.find((entry: { path: string }) => entry.path === "browser/dist/main.js")?.sha256;
    if (!/^[a-f0-9]{64}$/.test(browser)) throw new Error("missing browser build");
    artifactId = manifest.artifactId; sourceRevision = manifest.identity.source.commit; build = browser; extensionBuild = hash;
    menuBuild = hashes.find(([name]) => name === "menu.js")?.[1] ?? null;
    closureBuild = manifest.schemaVersion === 3 ? createHash("sha256").update(JSON.stringify(hashes)).digest("hex") : null;
  } catch {}
  return Object.freeze({ artifactId, sourceRevision, build, protocol: 2, pid: process.pid, processStart, instanceId: randomUUID(), extensionBuild,
    menuBuild, closureBuild, packageResources: COMPILED_RESOURCES, receiptEntrypoint: "dist/menu.js" });
}

export const LOADED_IDENTITY = capturedIdentity();
const receiptSequenceKey = Symbol.for("terminal-browser.pi-receipt-sequence");

function nextReceiptSequence() {
  const shared = globalThis as any;
  const sequence = Number.isSafeInteger(shared[receiptSequenceKey]) ? shared[receiptSequenceKey] + 1 : 1;
  shared[receiptSequenceKey] = sequence;
  return sequence;
}

export function startupReceipt(identity: typeof LOADED_IDENTITY & { loadedResources?: string[]; toolNames?: string[] } = LOADED_IDENTITY): () => void {
  const file = process.env.TERMINAL_BROWSER_INSTALLATION ?? path.resolve(runtimeRoot, "../../../installation.json");
  if (!fs.existsSync(file)) return () => {};
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("invalid browser installation receipt");
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  if (receipt.schemaVersion !== 1 || !/^terminal-browser(?:-dev)?-[a-f0-9]{8}$/.test(receipt.namespace) || typeof receipt.paths?.stateHome !== "string" || !path.isAbsolute(receipt.paths.stateHome)) throw new Error("invalid browser state namespace");
  const directory = path.join(receipt.paths.stateHome, receipt.namespace, "pi-loaded");
  if (directory.startsWith(`${runtimeRoot}/`)) throw new Error("runtime receipts must be outside artifacts");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receiptId = randomUUID();
  const destination = path.join(directory, `${receiptId}.json`);
  const bytes = `${JSON.stringify({ identity, receipt: { id: receiptId, createdAt: new Date().toISOString(), sequence: nextReceiptSequence() } })}\n`;
  fs.writeFileSync(destination, bytes, { mode: 0o600, flag: "wx" });
  return () => { try { if (fs.readFileSync(destination, "utf8") === bytes) fs.unlinkSync(destination); } catch {} };
}
