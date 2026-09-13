import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerContextProvider, sameScope, type ContextScope } from "@context-kit/protocol";
import { OWNER_BINDING_ENTRY, registerStateTransferProvider, StateTransferError, validateTransferEntries, type StateTransferEntry } from "@context-kit/protocol/transfer";
import { ANCHOR_TYPE, canonical, fail, integer, LIMITS, object, plain, safeError, sha, text, validityState, VISIBILITY, type Origin } from "./contracts.ts";
import { captureMemoryBinding, defaultMemoryRoot, initializeMemoryBinding, lookupMemoryBinding, openBoundMemory, restoreMemoryBinding, validateMemoryBinding, verifySessionTarget } from "./bindings.ts";
import { sourceTicket } from "./files.ts";
import { importLegacyV2, parseLegacyImport, readLegacySource } from "./legacy-import.ts";
import { exportMemoryV2, type MemoryV2ExportInput } from "./reverse-export.ts";
import { buildOperation, validateOperation, type Action } from "./operations.ts";
import { readMemoryContext, unavailable } from "./connector.ts";
import type { MemoryPage, MemoryStore } from "./store.ts";

export { captureMemoryBinding, defaultMemoryRoot, restoreMemoryBinding } from "./bindings.ts";
export { importLegacyV2, parseLegacyImport, readLegacySource } from "./legacy-import.ts";
export { exportMemoryV2, V2_EXPORT_LIMITS, type MemoryV2ExportInput, type MemoryV2ExportReceipt } from "./reverse-export.ts";
export const MEMORY_TOOL_NAMES = Object.freeze(["memory_remember", "memory_update", "memory_forget", "memory_promote", "memory_list", "memory_get", "memory_search", "memory_proposal"]);
const optionalText = (maxLength = 128) => Type.Optional(Type.String({ minLength: 1, maxLength }));
const enumeration = <T extends string>(values: T[]) => Type.Union(values.map(value => Type.Literal(value)));
const expected = Type.Optional(Type.Integer({ minimum: 1 }));
const temporal = {
  eventTime: Type.Optional(Type.Union([Type.Object({ kind: Type.Literal("unknown") }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("instant"), at: Type.String() }, { additionalProperties: false })])),
  validity: Type.Optional(Type.Union([Type.Object({ kind: Type.Literal("unknown") }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("interval"), from: Type.Union([Type.String(), Type.Null()]), until: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false })])),
  sources: Type.Optional(Type.Array(Type.Object({ identity: Type.String({ maxLength: 512 }), kind: enumeration(["history", "external"]),
    reference: optionalText(2048), role: optionalText(32), derivation: Type.Optional(enumeration(["original", "derived", "unknown"])) }, { additionalProperties: false }), { maxItems: 7 })),
};
const contentFields = { text: Type.String({ minLength: 1, maxLength: LIMITS.text }), scope: optionalText(256), confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), reason: optionalText(1024), ...temporal };
const pageFields = { scope: optionalText(256), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.results })), scan: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.scan })), cursor: optionalText(2048) };
const revision = Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: "^[1-9][0-9]*$", maxLength: 16 })]));
const inputObject = (fields: Record<string, any>) => Type.Object(fields, { additionalProperties: false });
function getRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && !/^[1-9][0-9]{0,15}$/.test(value)) fail("revision-invalid");
  return integer(typeof value === "string" ? Number(value) : value);
}
function scopeOf(ctx: ExtensionContext): ContextScope { return { sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId() }; }
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) fail("cancelled"); }
function result(data: Record<string, unknown>, details: Record<string, unknown> = {}) {
  const reply = { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: { protocol: "context-memory-result-v1", ...details } };
  if (Buffer.byteLength(JSON.stringify(reply)) > LIMITS.output) fail("output-limit");
  return reply;
}
/** One bounded bootstrap walk only when no direct physical binding exists. */
export function restoreBootstrapBinding(root: string, ctx: ExtensionContext): boolean {
  const sessionId = ctx.sessionManager.getSessionId(), sourcePath = ctx.sessionManager.getSessionFile();
  if (!sourcePath) fail("session-unpersisted");
  let id = ctx.sessionManager.getLeafId(), count = 0;
  let found: StateTransferEntry | undefined;
  const seen = new Set<string>();
  while (id !== null && count++ < 64) {
    if (seen.has(id)) fail("bootstrap-corrupt");
    seen.add(id);
    const entry = ctx.sessionManager.getEntry(id);
    if (!entry) fail("bootstrap-corrupt");
    if (entry.type === "custom" && entry.customType === OWNER_BINDING_ENTRY && (entry.data as any)?.provider === "memory") {
      if (found) fail("bootstrap-duplicate");
      found = validateTransferEntries([{ customType: entry.customType, data: entry.data }], undefined, "memory", 8192)[0];
    }
    // A historical independent write cannot be replaced by a later bootstrap.
    if (entry.type === "custom" && entry.customType === ANCHOR_TYPE) fail("binding-missing");
    id = entry.parentId;
  }
  if (id !== null) fail("bootstrap-scan-limit");
  if (!found || found.customType !== OWNER_BINDING_ENTRY) return false;
  const binding = validateMemoryBinding(found.data.binding);
  if (binding.sourceSessionId !== found.data.sourceSessionId || binding.sourceLeafId !== found.data.sourceLeafId) fail("bootstrap-scope");
  restoreMemoryBinding(root, binding, { sessionId, sourcePath });
  return true;
}
export default function memoryExtension(pi: ExtensionAPI) {
  const root = defaultMemoryRoot();
  let context: ExtensionContext | undefined, store: MemoryStore | undefined, boundSession: string | undefined;
  let epoch = 0, busy = 0, stopped = false;
  const origins = new Map<string, { origin: Origin; epoch: number; sessionId: string }>();
  function bindContext(ctx: ExtensionContext): void {
    store?.close(); store = undefined; boundSession = undefined; context = ctx; epoch++; origins.clear(); stopped = false;
  }
  function activeScope(): ContextScope | undefined { return stopped || !context ? undefined : scopeOf(context); }
  function ensure(ctx: ExtensionContext, create: boolean, explicitNew = false): MemoryStore {
    if (stopped || !context || scopeOf(ctx).sessionId !== scopeOf(context).sessionId) fail("scope-changed");
    const sessionId = ctx.sessionManager.getSessionId();
    if (store && boundSession === sessionId) { if (create) store.recover(); return store; }
    const sourcePath = ctx.sessionManager.getSessionFile();
    if (!sourcePath) fail("session-unpersisted");
    verifySessionTarget({ sessionId, sourcePath });
    if (!lookupMemoryBinding(root, sessionId)) {
      if (explicitNew || !restoreBootstrapBinding(root, ctx)) {
        if (!create || ctx.sessionManager.getHeader()?.parentSession && !explicitNew) fail("binding-missing");
        store = initializeMemoryBinding(root, { sessionId, sourcePath });
      }
    }
    store ??= openBoundMemory(root, sessionId);
    if (create) store.recover();
    boundSession = sessionId;
    return store;
  }
  function view(store: MemoryStore) {
    const meta = store.meta();
    return { status: "ready", storeId: meta.storeId, storeRevision: meta.revision,
      visibility: { kind: "logical_session", namespaceId: meta.namespaceId, branchBehavior: "shared" }, notice: VISIBILITY };
  }
  function readPage(owned: MemoryStore, page: MemoryPage) {
    const data = { ...view(owned), storeRevision: page.storeRevision, memories: page.records, count: page.records.length,
      coverage: { ...page.coverage }, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    while (true) {
      try { return result(data, { count: data.count, storeRevision: data.storeRevision }); }
      catch (error) {
        if (safeError(error).code !== "memory-output-limit" || !data.memories.length) throw error;
        data.memories.pop(); data.count--; data.coverage.excluded++;
      }
    }
  }
  const removeContext = registerContextProvider(pi.events, "memory", request => {
    const before = activeScope();
    if (!before || !sameScope(before, request.scope)) return unavailable("scope_changed");
    if (busy) return unavailable("pending");
    try {
      const owned = ensure(context!, false), page = readMemoryContext(request, owned), after = activeScope();
      return after && sameScope(before, after) ? page : unavailable("scope_changed");
    } catch (error) {
      const code = safeError(error).code;
      return unavailable(code === "memory-pending" ? "pending" : code.includes("corrupt") || code.includes("schema") ? "corrupt" : "unavailable");
    }
  });
  const removeTransfer = registerStateTransferProvider(pi.events, "memory", async (request, signal) => {
    checkSignal(signal);
    if (busy) throw new StateTransferError("state-checkpoint-pending");
    const owned = ensure(context!, true);
    if (owned.meta().pending) throw new StateTransferError("state-checkpoint-pending");
    const binding = captureMemoryBinding(root, request.scope); checkSignal(signal);
    return [{ customType: OWNER_BINDING_ENTRY, data: { version: 1, provider: "memory", sourceSessionId: request.scope.sessionId, sourceLeafId: request.scope.leafId, binding } }];
  }, activeScope);
  pi.on("session_start", (_event, ctx) => bindContext(ctx));
  pi.on("session_tree", (_event, ctx) => bindContext(ctx));
  pi.on("session_shutdown", () => {
    stopped = true; epoch++; origins.clear(); store?.close(); store = undefined; context = undefined;
    removeContext(); removeTransfer();
  });
  pi.on("tool_call", (event, ctx) => {
    if (!MEMORY_TOOL_NAMES.includes(event.toolName)) return;
    let leaf = ctx.sessionManager.getLeafId(), count = 0;
    while (leaf !== null && count++ < 32) {
      const entry = ctx.sessionManager.getEntry(leaf);
      if (!entry) break;
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(block => block.type === "toolCall" && block.id === event.toolCallId && block.name === event.toolName)) {
        if (origins.size >= 128) fail("inflight-limit");
        const sessionId = ctx.sessionManager.getSessionId();
        origins.set(event.toolCallId, { origin: { sessionId, leafId: entry.id, toolCallId: event.toolCallId }, epoch, sessionId });
        return;
      }
      leaf = entry.parentId;
    }
  });
  pi.on("tool_execution_end", event => { origins.delete(event.toolCallId); });
  function mutate(action: Action, toolCallId: string, raw: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext) {
    checkSignal(signal); const input = validateOperation(action, raw), origin = origins.get(toolCallId);
    if (!origin || origin.epoch !== epoch || origin.sessionId !== ctx.sessionManager.getSessionId()) fail("operation-origin-unavailable");
    const owned = ensure(ctx, true), savedEpoch = epoch, operationId = sha(`${origin.sessionId}\n${toolCallId}`);
    const ticket = sourceTicket(ctx.sessionManager.getSessionFile()!);
    const receipt = owned.execute(operationId, sha(canonical({ action, input })), ticket,
      meta => buildOperation(owned, meta, action, input, { operationId, origin: origin.origin }), anchor => {
        checkSignal(signal); if (savedEpoch !== epoch) fail("scope-changed"); pi.appendEntry(ANCHOR_TYPE, anchor);
      });
    const primary = receipt.records[0];
    return result({ ...view(owned), action, ...receipt, ...(primary ?? {}) }, { ...receipt, ...(primary ?? {}) });
  }
  function tool(name: string, description: string, parameters: any, execute: (id: string, args: any, signal: AbortSignal | undefined, ctx: ExtensionContext) => unknown) {
    pi.registerTool({ name, label: name, description, parameters, executionMode: "sequential",
      async execute(id, raw, signal, _update, ctx) {
        try { checkSignal(signal); if (busy) fail("pending"); return execute(id, plain(raw), signal, ctx) as any; }
        catch (error) { throw safeError(error); }
      } });
  }
  tool("memory_remember", `Record accepted ordinary knowledge with immutable revisions. ${VISIBILITY}`, inputObject({ ...contentFields, supersedesMemoryId: optionalText(), expectedSupersededRevision: expected }),
    (id, args, signal, ctx) => mutate("remember", id, args, signal, ctx));
  tool("memory_update", "Correct one accepted memory. Prior revisions and original provenance remain recoverable. Expected revision prevents stale writes.", inputObject({ memoryId: Type.String(), ...contentFields, expectedRevision: expected }),
    (id, args, signal, ctx) => mutate("update", id, args, signal, ctx));
  for (const action of ["forget", "promote"] as const) tool(`memory_${action}`,
    action === "forget" ? "Demote accepted knowledge without deletion. Protected legacy records cannot be changed." : "Reactivate accepted ordinary knowledge. Retention boost lasts eight Memory commits, not conversation turns. Does not accept a proposal.",
    inputObject({ memoryId: Type.String(), reason: optionalText(1024), expectedRevision: expected }), (id, args, signal, ctx) => mutate(action, id, args, signal, ctx));
  tool("memory_get", `Read one accepted memory or proposal, optionally at an exact immutable revision or recording time. Event time and validity are separate. ${VISIBILITY}`,
    inputObject({ memoryId: Type.String(), revision, recordedBefore: optionalText(32) }), (_id, args, _signal, ctx) => {
      object(args, ["memoryId", "revision", "recordedBefore"]); const owned = ensure(ctx, true);
      const record = owned.get(args.memoryId, { ...(args.revision === undefined ? {} : { revision: getRevision(args.revision) }), ...(args.recordedBefore === undefined ? {} : { recordedBefore: args.recordedBefore }) });
      if (!record) fail("not-found");
      return result({ ...view(owned), memory: record, validityNow: validityState(record) }, { memoryId: record.memoryId, revision: record.revision, revisionHash: record.revisionHash });
    });
  tool("memory_list", "List a bounded indexed page of accepted current or archived knowledge. Proposals are separate. A cursor pins the store revision.",
    inputObject({ ...pageFields, state: Type.Optional(enumeration(["current", "superseded", "demoted"])) }), (_id, args, _signal, ctx) => {
      const owned = ensure(ctx, true); return readPage(owned, owned.page({ ...args, kind: "knowledge", includeDemoted: true }));
    });
  tool("memory_search", "Search a bounded indexed page of accepted knowledge. Matching is page-local, not a lifetime-wide ranking. Does not touch or promote records.",
    inputObject({ query: Type.String({ maxLength: LIMITS.query }), ...pageFields, includeDemoted: Type.Optional(Type.Boolean()) }), (_id, args, _signal, ctx) => {
      const owned = ensure(ctx, true); return readPage(owned, owned.page({ ...args, kind: "knowledge" }));
    });
  tool("memory_proposal", "Manage extraction proposals separately from accepted knowledge. Propose/list/get/accept/reject. Accept and reject require expectedRevision. Accept can correct targetMemoryId with expectedTargetRevision.",
    inputObject({ action: enumeration(["propose", "list", "get", "accept", "reject"]), ...contentFields, text: optionalText(LIMITS.text), memoryId: optionalText(), expectedRevision: expected,
      targetMemoryId: optionalText(), expectedTargetRevision: expected, ...pageFields, state: Type.Optional(enumeration(["pending", "accepted", "rejected"])), revision }),
    (id, args, signal, ctx) => {
      const { action, ...input } = args;
      if (["propose", "accept", "reject"].includes(action)) return mutate(action, id, input, signal, ctx);
      const owned = ensure(ctx, true);
      if (action === "list") return readPage(owned, owned.page({ ...input, kind: "proposal" }));
      if (action !== "get") fail("action-invalid");
      object(input, ["memoryId", "revision"]);
      const record = owned.get(input.memoryId, input.revision === undefined ? {} : { revision: getRevision(input.revision) });
      if (!record || record.kind !== "proposal") fail("not-found");
      return result({ ...view(owned), proposal: record });
    });
  pi.registerCommand("memory-init", { description: "Explicitly start independent Memory for a persisted unbound child session. Does not import legacy knowledge.", handler: async (_args, ctx) => {
    try { ensure(ctx, true, true); ctx.ui.notify("Memory logical-session binding is ready.", "info"); } catch (error) { ctx.ui.notify(safeError(error).code, "error"); }
  } });
  pi.registerCommand("memory-export-v2", { description: "Operator-only bounded V2 export. JSON requires expectedStoreId, expectedStoreRevision, targetTurn, sidecarPath, companionPath, receiptPath. New files only. Does not activate the old writer.", handler: async (args, ctx) => {
    if (busy || !ctx.isIdle()) { ctx.ui.notify("memory-export-requires-idle", "error"); return; }
    busy++;
    try {
      if (Buffer.byteLength(args) > 16384) fail("input-limit");
      let raw: unknown; try { raw = JSON.parse(args); } catch { fail("input-invalid"); }
      const input = object(plain(raw), ["expectedStoreId", "expectedStoreRevision", "targetTurn", "sidecarPath", "companionPath", "receiptPath"]);
      const receipt = await exportMemoryV2(ensure(ctx, false), input as MemoryV2ExportInput);
      ctx.ui.notify(`Memory V2 export artifacts verified. Old writer is not active. Receipt: ${receipt.receiptPath}`, "info");
    } catch (error) { ctx.ui.notify(safeError(error).code, "error"); }
    finally { busy--; }
  } });
  pi.registerCommand("memory-import-v2", { description: 'Explicit exact legacy import. JSON: {"path":"/absolute/sidecar","sourceSessionId":"optional original ID"}. Empty destination only.', handler: async (args, ctx) => {
    if (busy) { ctx.ui.notify("memory-pending", "error"); return; }
    busy++;
    const savedEpoch = epoch;
    try {
      if (Buffer.byteLength(args) > 8192) fail("input-limit");
      let raw: unknown; try { raw = JSON.parse(args); } catch { fail("input-invalid"); }
      const input = object(plain(raw), ["path", "sourceSessionId"]);
      const source = await readLegacySource(text(input.path, 4096));
      const imported = parseLegacyImport(source.bytes, source.identity, input.sourceSessionId ?? null);
      const check = () => { if (savedEpoch !== epoch || stopped) fail("scope-changed"); };
      check(); const owned = ensure(ctx, true, true);
      const receipt = await importLegacyV2(owned, imported, ctx.sessionManager.getSessionFile()!, anchor => { check(); pi.appendEntry(ANCHOR_TYPE, anchor); }, check);
      ctx.ui.notify(`Memory V2 import ${receipt.noOp ? "already present" : "committed"}. Events: ${receipt.eventCount}. Exact source bytes retained.`, "info");
    } catch (error) { ctx.ui.notify(safeError(error).code, "error"); }
    finally { busy--; }
  } });
}
