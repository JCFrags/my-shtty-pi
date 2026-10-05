import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { release, platform, arch } from "node:os";
import { join } from "node:path";
import { getPackageDir, VERSION, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { audit, checkTopics } from "./audits.ts";
import { PROVIDER_EVENT, type Basis, type Evidence, type Field, type ProviderId, type ProviderReply, type Report, type Request, type Topic, type Value } from "./types.ts";

export const DIAGNOSTICS_VERSION = "0.1.0";
export interface LoadedIdentity { version: string; instanceId: string; sha256: string | null; entrypoint: URL }
export function fileHash(path: string | URL): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch { return null; }
}
export function loadedIdentity(entrypoint: URL): LoadedIdentity {
  return { version: DIAGNOSTICS_VERSION, instanceId: randomUUID(), sha256: fileHash(entrypoint), entrypoint };
}
const identifier = (value: unknown): string | null => typeof value === "string" && value.length <= 120 && /^[a-zA-Z0-9_.:/+\-]+$/.test(value) && !value.includes("://") ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const bool = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function at(value: unknown, path: string): unknown { return path.split(".").reduce(own, value); }
function ref(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function evidence(provider: string, source: string, scope: string, available = true): Evidence {
  return { provider, source, scope, observedAt: new Date().toISOString(), availability: available ? "available" : "unavailable", fields: [], limits: [] };
}
function field(target: Evidence, id: string, value: Value, unit = "state", basis: Basis = "reported", note?: string): void {
  target.fields.push({ id, value, unit, basis: value === null ? "unknown" : basis, ...(note ? { note } : {}) });
}
function gap(target: Evidence, id: string, note: string): void {
  if (target.availability === "available") target.availability = "partial";
  field(target, id, null, "unavailable", "unknown", note);
}

// Fixed owner IDs only. A deadline cannot preempt a synchronous same-process owner.
export function requestProvider(pi: ExtensionAPI, provider: ProviderId, signal: AbortSignal, deadline: number): Promise<ProviderReply | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value?: ProviderReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish();
    const timer = setTimeout(onAbort, Math.max(0, Math.min(750, deadline - Date.now())));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted || Date.now() >= deadline) return finish();
    try {
      pi.events.emit(PROVIDER_EVENT, {
        protocolVersion: 1, provider, signal, deadline,
        respond(reply: unknown) {
          if (signal.aborted || Date.now() > deadline) return;
          const observedAt = own(reply, "observedAt");
          if (own(reply, "protocolVersion") !== 1 || own(reply, "provider") !== provider || typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) return;
          finish({ protocolVersion: 1, provider, observedAt: new Date(observedAt).toISOString(), status: own(reply, "status") });
        },
      });
    } catch { finish(); }
  });
}
function telemetry(reply?: ProviderReply): Evidence {
  const result = evidence("telemetry", "Telemetry status-only provider v1", "existing collector run", !!reply);
  result.limits.push("Not native session totals. Quality observations are caller-reported, not measured accuracy. Memory samples cover the whole process.");
  if (!reply) { result.errorCode = "provider_unavailable"; gap(result, "telemetry.storage.state", "No read-only provider reply."); return result; }
  result.observedAt = reply.observedAt;
  const status = reply.status;
  field(result, "telemetry.run", identifier(at(status, "run")), "collector-run ID", "component-attested");
  field(result, "telemetry.active", bool(at(status, "active")));
  const storageStates = ["idle", "opening", "recording", "full", "failed", "closed"];
  const storage = at(status, "storage.state");
  field(result, "telemetry.storage.state", storageStates.includes(String(storage)) ? String(storage) : null);
  const storageError = at(status, "storage.error");
  field(result, "telemetry.storage.error", ["none", "unsafe_directory", "storage_unavailable", "write_failed", "global_cap", "startup_failed"].includes(String(storageError)) ? String(storageError) : null, "error code");
  for (const key of ["queued", "written", "dropped", "shutdownUnconfirmed", "writtenBytes", "claimedSlots"]) {
    field(result, `telemetry.storage.${key === "shutdownUnconfirmed" ? "unconfirmedWrites" : key}`, count(at(status, `storage.${key}`)), key === "writtenBytes" ? "bytes" : "records");
  }
  for (const key of ["observationErrors", "correlationDrops", "settled", "boundaries"]) field(result, `telemetry.runtime.${key}`, count(at(status, `runtime.${key}`)), "events");
  for (const operation of ["agent", "turn", "tool", "compaction"]) {
    for (const key of ["started", "ended", "succeeded", "failed", "aborted", "abandoned", "unpaired", "totalMs", "maxMs"]) {
      field(result, `telemetry.runtime.${operation}.${key}`, count(at(status, `runtime.${operation}.${key}`)), key.endsWith("Ms") ? "milliseconds" : "events");
    }
  }
  for (const channel of ["assistant", "tool", "compaction", "branch_summary"]) {
    for (const key of ["samples", "missingOrInvalid", "input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
      field(result, `telemetry.usage.${channel}.${key}`, count(at(status, `runtime.usage.${channel}.${key}`)), ["samples", "missingOrInvalid"].includes(key) ? "samples" : "tokens");
    }
  }
  for (const key of ["rssBytes", "heapUsedBytes", "samples"]) field(result, `telemetry.process.${key}`, count(at(status, `runtime.process.${key}`)), key.endsWith("Bytes") ? "bytes, whole process" : "samples");
  const quality = at(status, "quality.state");
  field(result, "quality.state", ["unknown", "observed_not_verified"].includes(String(quality)) ? String(quality) : null);
  for (const basis of ["self_report", "source_known_case"]) {
    for (const kind of ["retrieval", "agent_outcome"]) {
      for (const key of ["observations", "pass", "fail", "unknown"]) field(result, `quality.${basis}.${kind}.${key}`, count(at(status, `quality.${basis}.${kind}.${key}`)), "unverified observations");
    }
  }
  return result;
}
function nativeRuntime(ctx: ExtensionContext): Evidence {
  const result = evidence("host", "installed public ExtensionContext and Pi exports", "current Pi process/session");
  field(result, "runtime.runningVersion", identifier(VERSION), "version", "component-attested", "Pi module's VERSION captured at module load, not a binary closure attestation.");
  let installed: string | null = null;
  try {
    const path = join(getPackageDir(), "package.json");
    if (statSync(path).size <= 32 * 1024) installed = identifier(JSON.parse(readFileSync(path, "utf8")).version);
  } catch { /* An unavailable manifest is not running identity. */ }
  field(result, "runtime.installedVersion", installed, "on-disk version");
  field(result, "runtime.testedRange", ">=0.99.1 <0.100.0", "API version range");
  field(result, "runtime.model", identifier(ctx.model?.id), "model ID");
  field(result, "runtime.provider", identifier(ctx.model?.provider), "provider ID");
  field(result, "runtime.mode", identifier(ctx.mode));
  gap(result, "runtime.startupDiagnostics", "No supported loader/error inventory on ExtensionContext. A fresh factory does not establish resource health.");
  return result;
}
function session(ctx: ExtensionContext): Evidence {
  const result = evidence("session", "native ExtensionContext.getContextUsage", "active context, not session-file totals");
  const usage = ctx.getContextUsage();
  field(result, "context.tokens", count(usage?.tokens), "tokens", "estimated");
  field(result, "context.window", count(usage?.contextWindow ?? ctx.model?.contextWindow), "tokens");
  field(result, "context.percent", count(usage?.percent), "percent", "estimated");
  gap(result, "session.nativeTotals", "AgentSession.getSessionStats is not exposed here. Use native /session for recorded session-file totals, including other branches and compacted history.");
  gap(result, "context.compactionAdmission", "No cached owner headroom/admission contract. No transport or prompt character estimate is substituted.");
  gap(result, "session.logicalIdentity", "Not inferred from the native session file or active branch.");
  return result;
}
function components(pi: ExtensionAPI, loaded: LoadedIdentity, reply?: ProviderReply): Evidence {
  const result = evidence("components", "factory-time diagnostics attestation, native source metadata, optional reload provider", "this process's attested components only");
  field(result, "diagnostics.version", loaded.version, "version", "component-attested");
  field(result, "diagnostics.instanceId", loaded.instanceId, "factory ID", "component-attested");
  field(result, "diagnostics.loadedSha256", loaded.sha256, "SHA-256", "component-attested", "Factory-time entrypoint bytes, not a dependency closure proof.");
  field(result, "diagnostics.selectedSha256", fileHash(loaded.entrypoint), "SHA-256");
  if (reply) {
    const status = reply.status;
    field(result, "reload.version", identifier(at(status, "version")), "version", "component-attested");
    field(result, "reload.instanceId", identifier(at(status, "instanceId")), "factory ID", "component-attested");
    const hash = at(status, "sha256");
    field(result, "reload.loadedSha256", typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) ? hash : null, "SHA-256", "component-attested");
    field(result, "reload.pending", bool(at(status, "pending")));
    const selectedHash = at(status, "selectedSha256");
    field(result, "reload.selectedSha256", typeof selectedHash === "string" && /^[a-f0-9]{64}$/.test(selectedHash) ? selectedHash : null, "SHA-256");
  } else gap(result, "reload.loadedSha256", "No status-only reload provider reply. Tool names and on-disk bytes are not loaded identity.");
  const settings = pi.getSettings();
  field(result, "components.configuredPackageCount", settings.packages?.length ?? 0, "settings entries");
  gap(result, "components.loadedInventory", "No complete host loaded-resource inventory. Native tool source attribution is not a component census.");
  result.limits.push("Configured source, native registration attribution, loaded attestation, readiness, and practical use are separate. Entry hashes do not prove dependency-closure adoption.");
  return result;
}
function tools(pi: ExtensionAPI, ctx: ExtensionContext, reply?: ProviderReply): { evidence: Evidence; details: Field[] } {
  const result = evidence("tools", "native tool registry/active set and optional Progressive Tools status v1", "current registered tools");
  const registry = pi.getAllTools();
  const active = pi.getActiveTools();
  field(result, "tools.registeredCount", registry.length, "tools");
  field(result, "tools.activeCount", active.length, "tools");
  field(result, "tools.invalidActiveCount", registry.length <= 500 && active.length <= 500 ? active.filter(name => !registry.some(tool => tool.name === name) || registry.find(tool => tool.name === name)?.exposure === "hidden").length : null, "tools");
  const policy = reply?.status;
  field(result, "tools.policyViolationCount", count(at(policy, "violationCount")), "tools", "component-attested");
  field(result, "tools.configurationErrorCount", count(at(policy, "configurationErrorCount")), "errors", "component-attested");
  field(result, "tools.unclassifiedPolicyCount", count(at(policy, "unclassifiedCount")), "tools", "component-attested");
  const configTime = at(policy, "configurationObservedAt");
  field(result, "tools.policyObservedAt", typeof configTime === "string" && Number.isFinite(Date.parse(configTime)) ? new Date(configTime).toISOString() : null, "cached policy timestamp", "component-attested");
  gap(result, "tools.practicalCallability", "Diagnostics does not execute tools or bypass owner trust/policy checks.");
  const details: Field[] = [];
  for (const tool of registry.slice(0, 500)) {
    const name = identifier(tool.name);
    if (!name) continue;
    const source = tool.sourceInfo;
    const entries = own(policy, "entries");
    const ownerEntry = Array.isArray(entries) ? entries.slice(0, 500).find(entry => own(entry, "name") === tool.name) : undefined;
    const policyState = own(ownerEntry, "policy");
    const policyLabel = ["core", "managed", "unmanaged", "blocked"].includes(String(policyState)) ? String(policyState) : "unavailable";
    details.push({ id: `tools.${name}`, value: `registered; active=${active.includes(tool.name)}; exposure=${identifier(tool.exposure) ?? "unavailable"}; policy=${policyLabel}; sourceRef=${source?.path ? ref(source.path) : "unavailable"}`, unit: "registration metadata, not final declaration or callability", basis: "reported" });
  }
  if (registry.length > 500) result.limits.push("Tool registry detail is capped at 500 entries. Consistency is unknown when capped.");
  const command = ctx as Partial<ExtensionCommandContext>;
  if (typeof command.getSystemPromptOptions === "function") {
    const options = command.getSystemPromptOptions();
    field(result, "prompt.contextFileCount", options.contextFiles?.length ?? 0, "instruction sources");
    field(result, "prompt.discoveredSkillCount", options.skills?.length ?? 0, "discovered descriptions");
    field(result, "prompt.customPrefixPresent", !!options.customPrompt);
    field(result, "prompt.forcedPromptPresent", !!options.forceSystemPrompt);
    for (const [index, file] of (options.contextFiles ?? []).slice(0, 200).entries()) details.push({ id: `prompt.source.${index}`, value: `sourceRef=${ref(file.path)}`, unit: "instruction source metadata", basis: "reported" });
    for (const [index, skill] of (options.skills ?? []).slice(0, 200).entries()) details.push({ id: `prompt.skill.${index}`, value: `sourceRef=${ref(skill.filePath)}`, unit: "discovered skill, not full instructions read", basis: "reported" });
    result.limits.push("Command-context prompt inputs are base construction metadata, not the final provider request. Raw text and skill descriptions are omitted.");
  } else gap(result, "prompt.provenance", "Base prompt input options are command-only. Agent-tool context does not expose them.");
  gap(result, "prompt.rawText", "Raw prompts, conversation bodies, tool arguments, schema content, and credential stores are excluded. Raw export is not supported in this release.");
  return { evidence: result, details };
}
function resources(pi: ExtensionAPI, ctx: ExtensionContext): Evidence {
  const result = evidence("resources", "Node local runtime and grounded:session-transition-readiness:v1", "current local process and its known managed resources, no SSH inspection");
  field(result, "environment.os", platform());
  field(result, "environment.architecture", arch());
  field(result, "environment.kernel", release(), "kernel release");
  field(result, "environment.nodeVersion", process.versions.node, "version");
  field(result, "environment.timeZone", identifier(Intl.DateTimeFormat().resolvedOptions().timeZone), "local time zone");
  field(result, "resources.idle", ctx.isIdle());
  field(result, "resources.pendingMessages", ctx.hasPendingMessages());
  let replies = 0, invalid = false, jobs = 0, sessions = 0;
  pi.events.emit("grounded:session-transition-readiness:v1", {
    protocolVersion: 1,
    accept(value: unknown) {
      replies++;
      const running = own(value, "runningProcesses"), open = own(value, "openSessions");
      if (own(value, "protocolVersion") !== 1 || !Number.isSafeInteger(running) || !Number.isSafeInteger(open) || Number(running) < 0 || Number(open) < 0) invalid = true;
      else { jobs += Number(running); sessions += Number(open); }
    },
  });
  field(result, "resources.runningProcesses", replies && !invalid ? jobs : null, "managed jobs", "component-attested");
  field(result, "resources.openSessions", replies && !invalid ? sessions : null, "explicit local/SSH sessions, counts only", "component-attested");
  if (!replies || invalid) { result.availability = "partial"; result.errorCode = invalid ? "invalid_owner_reply" : "owner_unavailable"; }
  result.limits.push("Not a scan of all system processes. No sessions, servers, or remote routes are opened. Tool calls observe an active run. Drafts, approvals, third-party resources, and transition admission are not covered.");
  return result;
}

export async function collect(pi: ExtensionAPI, ctx: ExtensionContext, loaded: LoadedIdentity, request: Request, signal?: AbortSignal): Promise<Report> {
  const startedAt = new Date().toISOString();
  const topics: Topic[] = [...new Set([...request.topics, ...checkTopics(request.checkIds ?? [])])];
  const controller = new AbortController();
  const deadline = Date.now() + 5000;
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(onAbort, 5000);
  const providers: Evidence[] = [], details: Field[] = [];
  try {
    const ids: ProviderId[] = [];
    if (topics.includes("telemetry")) ids.push("telemetry");
    if (topics.includes("tools")) ids.push("progressive-tools");
    if (topics.includes("components")) ids.push("reload");
    const replies = await Promise.all(ids.map(id => requestProvider(pi, id, controller.signal, deadline)));
    const reply = (id: ProviderId) => replies[ids.indexOf(id)];
    const attempt = (topic: Topic, action: () => Evidence) => {
      if (!topics.includes(topic)) return;
      try { providers.push(action()); }
      catch { const item = evidence(topic, "supported collector", "current process/session", false); item.errorCode = "collector_unavailable"; item.limits.push("Collection failed. Error content is not copied into the report."); providers.push(item); }
    };
    attempt("runtime", () => nativeRuntime(ctx));
    attempt("session", () => session(ctx));
    attempt("telemetry", () => {
      const item = telemetry(reply("telemetry"));
      const core = /^(?:telemetry\.(?:run|active|storage\.(?:state|error|dropped|unconfirmedWrites)|runtime\.(?:observationErrors|correlationDrops|(?:agent|turn|tool|compaction)\.(?:unpaired|abandoned))|usage\.[^.]+\.totalTokens|process\.(?:rssBytes|heapUsedBytes))|quality\.state)$/;
      details.push(...item.fields.filter(field => !core.test(field.id)));
      item.fields = item.fields.filter(field => core.test(field.id));
      return item;
    });
    attempt("components", () => {
      const item = components(pi, loaded, reply("reload"));
      for (const [index, entry] of (pi.getSettings().packages ?? []).slice(0, 200).entries()) {
        const source = typeof entry === "string" ? entry : entry.source;
        if (typeof source === "string") details.push({ id: `components.configured.${index}`, value: `configured sourceRef=${ref(source)}; kind=${source.startsWith("npm:") ? "npm" : source.startsWith("git:") ? "git" : "local/other"}; selection and loaded identity are not established`, unit: "settings metadata", basis: "reported" });
      }
      return item;
    });
    attempt("tools", () => { const item = tools(pi, ctx, reply("progressive-tools")); details.push(...item.details); return item.evidence; });
    attempt("resources", () => resources(pi, ctx));
    attempt("state", () => { const item = evidence("state", "owner contract availability", "cached status only", false); item.errorCode = "unsupported_cached_contract"; gap(item, "state.cachedReadiness", "No supported read-only cached native/history/role binding in this release. State read/import/checkpoint and history initialization are not called."); return item; });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  const findings = audit(request.checkIds ?? [], providers, controller.signal.aborted);
  const offset = request.offset ?? 0, limit = request.limit ?? 25;
  const page = request.view === "detailed" ? details.slice(offset, offset + limit) : [];
  if (page.length) providers.push({ ...evidence("details", "paged native metadata", "requested topics"), fields: page });
  return {
    schemaVersion: 1, kind: "report", reportId: randomUUID(), startedAt, endedAt: new Date().toISOString(), scope: "current Pi process/session",
    requestedTopics: request.topics, requestedChecks: request.checkIds ?? [], providers, findings, checks: [],
    complete: !controller.signal.aborted && providers.every(provider => provider.availability === "available" && provider.fields.every(field => field.basis !== "unknown")),
    page: { offset, limit, total: details.length, nextOffset: request.view === "detailed" && offset + page.length < details.length ? offset + page.length : null, truncated: request.view === "detailed" && (offset > 0 || offset + page.length < details.length) },
    limits: ["Explicit, non-atomic observation. Values can change during collection.", "Five-second cooperative collection budget. Same-process synchronous handlers cannot be preempted. Optional replies wait at most 750 ms independently.", "No control actions, remote access, model calls, raw content, or automatic storage/publication.", ...(controller.signal.aborted ? ["Collection budget expired or request was cancelled. Evidence can be partial."] : [])],
  };
}
