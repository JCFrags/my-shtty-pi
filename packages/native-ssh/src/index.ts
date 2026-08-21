import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, createLsToolDefinition, createFindToolDefinition, createGrepToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { Controller } from "./controller.mjs";
import { SshTransport } from "./transport.mjs";
import { PrivateAudit } from "./audit.mjs";
import { RemoteRuntime } from "./runtime.mjs";
import { classifyCommand } from "./policy.mjs";
import { fail } from "./protocol.mjs";

function confinedLocal(cwd: string, value: string) {
  const result = resolve(cwd, value);
  const rel = relative(cwd, result);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || resolve(result) === resolve(cwd) && value === "") throw new Error("Local transfer path must stay inside Pi's working directory");
  return result;
}

export default function nativeSsh(pi: ExtensionAPI) {
  const config = loadConfig(process.env.PI_NATIVE_SSH_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-native-ssh", "config.json"));
  const helper = readFileSync(fileURLToPath(new URL("./helper.py", import.meta.url)), "utf8");
  const controller = new Controller(pi, config);
  const audit = new PrivateAudit(config.audit);
  const imageProcessor = async (image: any, args: any, signal: AbortSignal | undefined, ctx: any) => {
    const bytes = Buffer.from(image.data, "base64");
    const nativeRead = createReadToolDefinition(ctx.cwd, { operations: { access: async () => {}, detectImageMimeType: async () => image.mimeType, readFile: async () => bytes } });
    return nativeRead.execute("native-ssh-image", { path: args.path, offset: args.offset, limit: args.limit ?? undefined }, signal, undefined, ctx);
  };
  const runtime = new RemoteRuntime(controller, new SshTransport(helper), audit, imageProcessor, config.limits);

  function registerLocal(cwd: string) {
    pi.registerTool(createReadToolDefinition(cwd)); pi.registerTool(createLsToolDefinition(cwd)); pi.registerTool(createFindToolDefinition(cwd)); pi.registerTool(createGrepToolDefinition(cwd));
    pi.registerTool(createWriteToolDefinition(cwd)); pi.registerTool(createEditToolDefinition(cwd)); pi.registerTool(createBashToolDefinition(cwd));
    pi.setActiveTools([...new Set([...pi.getActiveTools(), "ls"])]);
  }

  function registerRemote(ctx: ExtensionContext) {
    const remoteCwd = controller.status().target?.cwd ?? "/";
    const read = createReadToolDefinition(remoteCwd);
    pi.registerTool({ ...read, description: `${read.description} REMOTE mode reads the selected configured SSH host and never falls back locally.`, promptGuidelines: ["REMOTE mode uses only the visible configured SSH route."], execute: (_id, p, signal, _u, c) => runtime.execute("read", { path: p.path, offset: p.offset ?? 1, limit: p.limit ?? null }, signal, c) });
    const ls = createLsToolDefinition(remoteCwd);
    pi.registerTool({ ...ls, description: `${ls.description} REMOTE mode lists the selected SSH host.`, execute: (_id, p, signal, _u, c) => runtime.execute("ls", { path: p.path ?? ".", limit: p.limit ?? 500 }, signal, c) });
    const find = createFindToolDefinition(remoteCwd);
    pi.registerTool({ ...find, description: `${find.description} REMOTE mode searches the selected SSH host.`, execute: (_id, p, signal, _u, c) => runtime.execute("find", { path: p.path ?? ".", pattern: p.pattern, limit: p.limit ?? 1000 }, signal, c) });
    const grep = createGrepToolDefinition(remoteCwd);
    pi.registerTool({ ...grep, description: `${grep.description} REMOTE mode searches the selected SSH host.`, execute: (_id, p, signal, _u, c) => runtime.execute("grep", { path: p.path ?? ".", pattern: p.pattern, glob: p.glob ?? null, ignoreCase: p.ignoreCase ?? false, literal: p.literal ?? false, context: p.context ?? 0, limit: p.limit ?? 100 }, signal, c) });

    const write = createWriteToolDefinition(remoteCwd);
    pi.registerTool({ ...write, description: `${write.description} REMOTE mode performs an atomic bounded write and keeps one same-directory rollback copy.`, async execute(id, p, signal, update, c) {
      const tool = createWriteToolDefinition(remoteCwd, { operations: { mkdir: path => runtime.mkdir(path, signal, c).then(() => {}), writeFile: (path, content) => runtime.write(path, content, signal, c).then(() => {}) } });
      return tool.execute(id, p, signal, update, c);
    } });
    const edit = createEditToolDefinition(remoteCwd);
    pi.registerTool({ ...edit, description: `${edit.description} REMOTE mode uses bounded compare-in-process editing and atomic write with rollback.`, async execute(id, p, signal, update, c) {
      const tool = createEditToolDefinition(remoteCwd, { operations: { readFile: path => runtime.rawRead(path, signal, c), access: path => runtime.access(path, true, signal, c), writeFile: (path, content) => runtime.write(path, content, signal, c).then(() => {}) } });
      return tool.execute(id, p, signal, update, c);
    } });
    const bash = createBashToolDefinition(remoteCwd);
    pi.registerTool({ ...bash, description: `${bash.description} REMOTE mode executes a bounded non-interactive command on the selected SSH host. Ordinary commands run directly. Clearly destructive or trust-changing commands require visible confirmation. Credential exposure is refused.`, async execute(id, p, signal, update, c) {
      const risk = classifyCommand(p.command);
      if (risk?.kind === "credential") throw fail("CREDENTIAL_INTERACTION_REQUIRED", risk.reason, { recommendedAction: "use_terminal" });
      if (risk && !(c.hasUI && await c.ui.confirm(`Remote ${risk.kind} command`, `${risk.reason}\n\nTarget: ${controller.status().target?.displayName}\nProceed?`))) throw fail("CONFIRMATION_REQUIRED", "Remote command was not confirmed");
      const tool = createBashToolDefinition(remoteCwd, { exposeSessionEnvironment: false, operations: { exec: async (command, _cwd, options) => {
        const result = await runtime.exec(command, options.timeout ? options.timeout * 1000 : undefined, options.signal, c);
        if (result.stdout.length) options.onData(result.stdout); if (result.stderr.length) options.onData(result.stderr);
        if (result.timedOut) throw fail("REMOTE_TIMEOUT", "Remote command timed out; rollback is not claimed", { retryable: true });
        return { exitCode: result.exitCode };
      } } });
      return tool.execute(id, p, signal, update, c);
    } });
  }

  const registerForState = (ctx: ExtensionContext) => controller.status().mode === "remote" ? registerRemote(ctx) : registerLocal(ctx.cwd);
  pi.on("session_start", async (_event, ctx) => { controller.sessionStart(ctx); controller.restore(ctx); registerForState(ctx); });
  pi.on("session_tree", async (_event, ctx) => { controller.restore(ctx); registerForState(ctx); });
  pi.on("session_shutdown", async () => { controller.sessionShutdown(); await audit.flush(); });

  pi.registerTool({ name: "ssh_transfer", label: "SSH Transfer", description: "Upload or download one bounded file through the active configured SSH host, or roll back the latest remote write for a path. Local paths stay inside Pi's current working directory. Upload keeps one remote rollback copy.", parameters: Type.Object({ action: Type.Union([Type.Literal("upload"), Type.Literal("download"), Type.Literal("rollback")]), localPath: Type.Optional(Type.String()), remotePath: Type.String(), overwrite: Type.Optional(Type.Boolean()) }), async execute(_id, p, signal, _update, ctx) {
    if (controller.status().mode !== "remote") throw fail("LOCAL_MODE", "No SSH target is active");
    if (p.action === "rollback") { const result = await runtime.rollback(p.remotePath, signal, ctx); return { content: [{ type: "text", text: `Remote rollback completed: ${result.action}` }], details: { action: result.action } }; }
    if (!p.localPath) throw new Error("localPath is required for upload and download");
    const localPath = confinedLocal(ctx.cwd, p.localPath);
    if (p.action === "upload") { const data = await readFile(localPath); const result = await runtime.write(p.remotePath, data, signal, ctx); return { content: [{ type: "text", text: `Uploaded ${result.bytes} bytes. Remote rollback is available for this path.` }], details: { bytes: result.bytes, rollbackAvailable: true } }; }
    const data = await runtime.rawRead(p.remotePath, signal, ctx); await mkdir(dirname(localPath), { recursive: true, mode: 0o700 }); await writeFile(localPath, data, { flag: p.overwrite ? "w" : "wx", mode: 0o600 }); return { content: [{ type: "text", text: `Downloaded ${data.length} bytes to ${p.localPath}.` }], details: { bytes: data.length } };
  } });

  pi.registerCommand("remote", { description: "Select, inspect, recover, roll back, or clear a configured native SSH route", handler: async (raw, ctx) => {
    const parts = raw.trim().split(/\s+/).filter(Boolean); const action = parts.shift() ?? "status";
    try {
      if (action === "status") { ctx.ui.notify(JSON.stringify(controller.status(), null, 2), "info"); return; }
      if (action === "list") { ctx.ui.notify(Object.keys(config.targets).map(name => `${name}: ${config.targets[name].displayName}`).join("\n") || "No targets", "info"); return; }
      if (action === "use") { if (parts.length < 1 || parts.length > 2) throw new Error("Usage: /remote use TARGET [ABSOLUTE_CWD]"); const target = config.targets[parts[0]]; if (!target) throw new Error("Target is not configured"); await runtime.negotiate(target); controller.use(parts[0], parts[1], ctx); registerRemote(ctx); ctx.ui.notify(`Native SSH route active: ${target.displayName}.`, "info"); return; }
      if (action === "recover") { const state = controller.status(); if (parts.length || state.mode !== "remote" || !state.target) throw new Error("Usage: /remote recover (with an active route)"); await runtime.negotiate(state.target); controller.markRecovered(ctx); registerRemote(ctx); ctx.ui.notify("SSH capability negotiation succeeded.", "info"); return; }
      if (action === "rollback") { if (parts.length !== 1) throw new Error("Usage: /remote rollback REMOTE_PATH"); const result = await runtime.rollback(parts[0], undefined, ctx); ctx.ui.notify(`Remote rollback completed: ${result.action}`, "info"); return; }
      if (action === "clear") { if (parts.length) throw new Error("Usage: /remote clear"); controller.clear(ctx); registerLocal(ctx.cwd); ctx.ui.notify("Remote route cleared. Native tools are LOCAL. User ! commands were always LOCAL.", "info"); return; }
      throw new Error("Usage: /remote status | list | use TARGET [ABSOLUTE_CWD] | recover | rollback REMOTE_PATH | clear");
    } catch (error: any) { if (controller.status().mode === "remote" && error?.routeAffecting) controller.markError(error.code ?? "UNKNOWN", ctx); ctx.ui.notify(error?.safeMessage ?? error?.message ?? "Remote command failed", "error"); }
  } });
}
