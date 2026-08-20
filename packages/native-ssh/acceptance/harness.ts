import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import nativeSsh from "../src/index.ts";

export default function acceptanceHarness(pi: ExtensionAPI) {
  const tools = new Map<string, any>();
  let remoteHandler: any;
  const proxy = new Proxy(pi as any, { get(target, property) {
    if (property === "registerTool") return (definition: any) => { tools.set(definition.name, definition); return target.registerTool(definition); };
    if (property === "registerCommand") return (name: string, definition: any) => { if (name === "remote") remoteHandler = definition.handler; return target.registerCommand(name, definition); };
    const value = target[property]; return typeof value === "function" ? value.bind(target) : value;
  } });
  nativeSsh(proxy);

  pi.registerCommand("accept-native-ssh", { description: "Run the installed native SSH acceptance cycle", handler: async (_raw, ctx) => {
    const output = process.env.PI_NATIVE_SSH_ACCEPTANCE_OUTPUT;
    if (!output) throw new Error("PI_NATIVE_SSH_ACCEPTANCE_OUTPUT is required");
    const token = `pi-native-ssh-${process.pid}-${Date.now()}`;
    const dir = `/tmp/${token}`;
    const remoteFile = `${dir}/cycle.txt`;
    const remoteUpload = `${dir}/upload.txt`;
    const records: any[] = [];
    const call = async (name: string, params: any, signal?: AbortSignal) => {
      const tool = tools.get(name); assert.ok(tool, `${name} tool registered`);
      return tool.execute(`accept-${name}`, params, signal, undefined, ctx);
    };
    assert.ok(remoteHandler);
    await remoteHandler("use server /tmp", ctx);
    assert.equal(tools.get("bash").name, "bash");
    let result = await call("bash", { command: `mkdir -m 700 ${dir}` });
    assert.ok(result.content.length >= 1);
    await call("write", { path: remoteFile, content: "alpha\n" });
    result = await call("read", { path: remoteFile, offset: 1, limit: 5 });
    assert.match(result.content[0].text, /alpha/);
    await call("edit", { path: remoteFile, edits: [{ oldText: "alpha", newText: "beta" }] });
    assert.match((await call("read", { path: remoteFile })).content[0].text, /beta/);
    writeFileSync("upload.txt", "transfer-data\n", { mode: 0o600 });
    await call("ssh_transfer", { action: "upload", localPath: "upload.txt", remotePath: remoteUpload });
    await call("ssh_transfer", { action: "download", localPath: "download.txt", remotePath: remoteUpload });
    assert.equal(readFileSync("download.txt", "utf8"), "transfer-data\n");
    await assert.rejects(call("bash", { command: "printf stdout; printf stderr >&2; exit 7" }), (error: any) => /stdout/.test(error.message) && /stderr/.test(error.message) && /code 7/.test(error.message));
    await assert.rejects(call("bash", { command: "sleep 2", timeout: 0.1 }), (error: any) => error.code === "REMOTE_TIMEOUT");
    const abort = new AbortController(); const pending = call("bash", { command: "sleep 5" }, abort.signal); setTimeout(() => abort.abort(), 100);
    await assert.rejects(pending, (error: any) => error.code === "REMOTE_CANCELLED");
    await assert.rejects(call("bash", { command: "yes x | head -c 70000" }), (error: any) => error.code === "REMOTE_OUTPUT_LIMIT");
    result = await call("bash", { command: `for f in ${remoteFile} ${remoteUpload} ${dir}/.pi-native-ssh-backup-cycle.txt ${dir}/.pi-native-ssh-new-cycle.txt ${dir}/.pi-native-ssh-backup-upload.txt ${dir}/.pi-native-ssh-new-upload.txt; do test ! -e \"$f\" || rm \"$f\"; done; rmdir ${dir}` });
    assert.ok(result.content.length >= 1);
    await assert.rejects(call("read", { path: remoteFile }), (error: any) => error.code === "REMOTE_NOT_FOUND");
    await remoteHandler("clear", ctx);
    records.push({ target: "server", harmlessCommand: true, writeReadEdit: true, uploadDownload: true, deleteCycle: true, timeout: true, cancellation: true, outputBound: true, clearLocal: true, remoteDir: dir });
    writeFileSync(output, JSON.stringify({ passed: true, records }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    ctx.ui.notify("Native SSH installed acceptance passed", "info");
  } });
}
