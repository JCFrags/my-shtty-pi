import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserOwner } from "pixel-store";
import { control } from "./control";
import { ownerMatches, recordKey } from "./instances";
import { instances } from "./registry";

export type CompanionMode = "agent" | "human" | "shared" | "paused";
export type PageFormat = "link" | "visual";
export interface CompanionAddress { schemaVersion: 1; ownerKey: string; browserSessionKey: string; runtimeInstanceId: string }
export interface RecoveryStatus {
  state: "unavailable" | "pending" | "restored" | "fresh" | "none";
  revision: string | null;
  entries: { kind: "url" | "excluded"; url: string; reason?: string }[];
  activeIndex: number | null;
  warning: string;
}
export type RecoveryResponse = CompanionAddress & RecoveryStatus;
export interface ReceiverTuple { bindingId: string; receiverGeneration: string }
export interface ReceiverBinding extends ReceiverTuple { receiverKind: "pi" | "cli"; receiverSessionId: string }
export interface CompanionStatus extends CompanionAddress {
  sequence: number;
  binding: ReceiverBinding | null;
  receiverOnline: boolean;
  pendingShareId: string | null;
  mode: CompanionMode;
  controlEpoch: number;
  updates: { enabled: boolean; active: boolean; description: string };
  limits: string[];
}
export interface PageVisual {
  mimeType: "image/png"; width: number; height: number; bytes: number;
  scope: "viewport"; rect: { x: number; y: number; width: number; height: number };
}
export interface CompanionEvent extends CompanionAddress, ReceiverTuple {
  changed: true;
  sequence: number;
  replacedCount: number;
  kind: "auto-visual" | "control" | "human-share";
  contextId: number;
  contextKind: "tab" | "popup";
  documentGeneration: number;
  viewRevision: number;
  reasons: ("navigation" | "scroll" | "visual" | "context" | "follow-start" | "updates-stopped")[];
  mode: CompanionMode;
  controlEpoch: number;
  capturedAt: number;
  settled: boolean;
  visual?: PageVisual;
  shareId?: string;
  url?: string;
  title?: string;
}
export interface UnchangedEvent extends CompanionAddress, ReceiverTuple { changed: false; sequence: number }
export interface HumanCapture extends CompanionAddress {
  contextId: number; contextKind: "tab" | "popup"; documentGeneration: number;
  viewRevision: number; url: string; title: string; capturedAt: number; visual?: PageVisual;
}
export interface HumanShareOptions extends ReceiverTuple { format: PageFormat; expectedContextId: number; expectedDocumentGeneration: number }
export interface ClosePreview extends CompanionAddress {
  revision: string;
  contexts: { contextId: number; contextKind: "tab" | "popup"; openerId: number | null; documentGeneration: number; title: string }[];
  transfers: { id: string; contextId: number; state: string }[];
}
export interface CloseResult extends CompanionAddress { status: "closed" | "partial" | "decision-required" | "refused" | "unknown"; closedContextIds: number[]; remainingContextIds: number[] }
export interface CompanionCommandOptions {
  browserSessionKey?: string;
  runtimeInstanceId?: string;
  imageOutput?: string;
  requireImage: boolean;
  timeoutMs: number;
  request: Record<string, unknown>;
}

/** Exact native or Herdr owner only. A supplied key narrows, never adopts a neighbor. */
export async function companionSessionCommand(owner: BrowserOwner, args: string[]): Promise<number> {
  const options = parseCompanionSessionArgs(args);
  const owned = ownerMatches(await instances(), owner);
  const found = options.browserSessionKey ? owned.filter(record => recordKey(record) === options.browserSessionKey) : owned;
  if (found.length !== 1) throw new Error(found.length ? "multiple browsers claim this owner; supply its exact --browser key" : "no browser for the exact selected owner and browser key");
  const browser = found[0]!;
  const value = await control(browser.socket, {
    ...options.request, owner, expectedBrowserSessionKey: recordKey(browser),
    ...(options.runtimeInstanceId ? { expectedRuntimeInstanceId: options.runtimeInstanceId } : {}),
  }, options.timeoutMs) as Record<string, unknown>;
  if (!value || typeof value !== "object" || value.browserSessionKey !== recordKey(browser) || (options.runtimeInstanceId !== undefined && value.runtimeInstanceId !== options.runtimeInstanceId)) throw new Error("companion response identity mismatch");
  await writeVisual(value, options.imageOutput, options.requireImage);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

export function parseCompanionSessionArgs(input: string[]): CompanionCommandOptions {
  const args = [...input];
  const command = args.shift();
  const browserSessionKey = option(args, "--browser");
  const runtimeInstanceId = option(args, "--runtime-instance");
  if (browserSessionKey !== undefined) text(browserSessionKey, "--browser", 256);
  if (runtimeInstanceId !== undefined) text(runtimeInstanceId, "--runtime-instance", 128);
  let request: Record<string, unknown>;
  let timeoutMs = 10000;
  let imageOutput: string | undefined;
  let requireImage = false;
  const tuple = (): ReceiverTuple => ({ bindingId: uuid(option(args, "--binding"), "--binding"), receiverGeneration: uuid(option(args, "--receiver-generation"), "--receiver-generation") });
  if (command === "receiver") {
    const action = args.shift();
    if (action === "status") request = { cmd: "receiver.status" };
    else if (action === "bind") {
      const kind = option(args, "--receiver-kind");
      if (kind !== "pi" && kind !== "cli") throw new Error("--receiver-kind must be pi or cli");
      const receiverSessionId = text(option(args, "--receiver-session"), "--receiver-session", 512);
      const receiverGeneration = uuid(option(args, "--receiver-generation"), "--receiver-generation");
      const replace = option(args, "--replace-binding");
      request = { cmd: "receiver.bind", receiverKind: kind, receiverSessionId, receiverGeneration, ...(replace === undefined ? {} : { replaceBindingId: uuid(replace, "--replace-binding") }) };
    } else if (action === "unbind") request = { cmd: "receiver.unbind", ...tuple() };
    else throw new Error("session receiver needs status, bind, or unbind");
  } else if (command === "recovery") {
    const action = args.shift();
    if (action === "status") request = { cmd: "recovery.status" };
    else if (action === "restore" || action === "fresh") {
      const revision = option(args, "--confirm");
      if (revision === undefined || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("recovery choice requires --confirm with a 64-character lowercase hexadecimal revision");
      request = { cmd: "recovery.choose", choice: action, revision };
    } else throw new Error("session recovery needs status, restore, or fresh");
  } else if (command === "updates") {
    const enabled = option(args, "--enabled");
    if (enabled !== "true" && enabled !== "false") throw new Error("--enabled must be true or false");
    request = { cmd: "updates.set", ...tuple(), enabled: enabled === "true" };
  } else if (command === "events") {
    if (args.shift() !== "wait") throw new Error("session events needs wait");
    const after = integer(option(args, "--after"), "--after", 0, Number.MAX_SAFE_INTEGER);
    const waitMs = integer(option(args, "--timeout-ms") ?? "25000", "--timeout-ms", 0, 30000);
    imageOutput = text(option(args, "--image-output"), "--image-output", 4096);
    timeoutMs = waitMs + 5000;
    request = { cmd: "events.wait", ...tuple(), after, timeoutMs: waitMs };
  } else if (command === "human") {
    const action = args.shift();
    if (action === "capture" || action === "share") {
      const format = option(args, "--format");
      if (format !== "link" && format !== "visual") throw new Error("--format must be link or visual");
      if (action === "capture") {
        imageOutput = option(args, "--image-output");
        if (format === "visual") { text(imageOutput, "--image-output", 4096); requireImage = true; }
        else if (imageOutput !== undefined) throw new Error("link capture does not use --image-output");
        request = { cmd: "human.capture", format };
      } else {
        request = {
          cmd: "human.share", format, ...tuple(),
          expectedContextId: integer(option(args, "--context"), "--context", 1, Number.MAX_SAFE_INTEGER),
          expectedDocumentGeneration: integer(option(args, "--document-generation"), "--document-generation", 0, Number.MAX_SAFE_INTEGER),
        };
      }
    } else if (action === "close") {
      const preview = flag(args, "--preview");
      const revision = option(args, "--confirm");
      if (preview === (revision !== undefined)) throw new Error("human close needs exactly one of --preview or --confirm REVISION");
      if (revision !== undefined && !/^[a-f0-9]{64}$/.test(revision)) throw new Error("invalid --confirm revision");
      request = { cmd: "human.close", ...(preview ? { preview: true } : { revision }) };
      timeoutMs = 30000;
    } else if (action === "blocking") {
      const selected = args.shift() ?? "status";
      const site = option(args, "--site");
      if (!["status", "enable", "disable", "allow-site", "block-site", "clear-diagnostics", "reload"].includes(selected)) throw new Error("invalid human blocking action");
      const siteAction = selected === "allow-site" || selected === "block-site";
      if (siteAction) text(site, "--site", 2048);
      else if (site !== undefined) throw new Error("--site requires allow-site or block-site");
      request = { cmd: "human.blocking", action: selected, ...(site === undefined ? {} : { site }) };
    } else throw new Error("session human needs capture, share, close, or blocking");
  } else throw new Error("session needs receiver, recovery, updates, events, human, or tabs");
  if (args.length) throw new Error(`unexpected ${args[0]}`);
  return { request, timeoutMs, imageOutput, requireImage, browserSessionKey, runtimeInstanceId };
}

/** Metadata-only results never create an output file. The caller owns file disposal. */
async function writeVisual(value: Record<string, unknown>, output: string | undefined, required: boolean) {
  const visual = value.visual as (PageVisual & { data?: Buffer }) | undefined;
  if (!visual) { if (required) throw new Error("browser returned no visual image"); return; }
  if (!output || visual.mimeType !== "image/png" || !Buffer.isBuffer(visual.data) || visual.data.byteLength > 2 * 1024 * 1024 || visual.data.byteLength !== visual.bytes) throw new Error("invalid companion visual response");
  const file = path.resolve(output);
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(visual.data); }
  catch (error) { await handle.close(); await fs.unlink(file).catch(() => {}); throw error; }
  await handle.close();
  const { data: _data, ...metadata } = visual;
  value.visual = metadata;
}

function option(args: string[], name: string): string | undefined {
  const indices = args.flatMap((arg, index) => arg === name || arg.startsWith(`${name}=`) ? [index] : []);
  if (indices.length > 1) throw new Error(`duplicate ${name}`);
  const at = indices[0];
  if (at === undefined) return undefined;
  if (args[at]!.startsWith(`${name}=`)) return args.splice(at, 1)[0]!.slice(name.length + 1);
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(at, 2); return value;
}
function flag(args: string[], name: string) { const at = args.indexOf(name); if (at < 0) return false; args.splice(at, 1); return true; }
function text(value: string | undefined, name: string, max: number) { if (!value?.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`invalid or missing ${name}`); return value; }
function uuid(value: string | undefined, name: string) { if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new Error(`invalid or missing ${name}`); return value; }
function integer(value: string | undefined, name: string, min: number, max: number) {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`invalid or missing ${name}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`invalid ${name}`);
  return number;
}
