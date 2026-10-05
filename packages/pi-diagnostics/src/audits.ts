import type { Check, Evidence, Finding, Topic } from "./types.ts";

export const CHECKS: Check[] = [
  { id: "runtime.loaded-source-match", purpose: "Compare selected entrypoint bytes with loaded component attestations", topics: ["components"], evidenceNeeds: ["component loaded hash", "same-entrypoint selected hash"], limits: "An entrypoint match does not verify the dependency closure or every extension." },
  { id: "runtime.startup-errors", purpose: "Read host loader/startup diagnostics", topics: ["runtime"], evidenceNeeds: ["supported host error inventory"], limits: "The current extension context does not expose that inventory." },
  { id: "runtime.compatibility", purpose: "Check the diagnostics host/API version", topics: ["runtime"], evidenceNeeds: ["running Pi version", "tested diagnostics API range"], limits: "This checks diagnostics only, not all package manifests or actual behavior." },
  { id: "tools.exposure-consistency", purpose: "Check active names against registration and owner policy", topics: ["tools"], evidenceNeeds: ["native registered/active names", "optional Progressive Tools policy"], limits: "Registration is not practical callability. Native built-in replacements are intentional." },
  { id: "runtime.role-readiness", purpose: "Read owner-reported role/binding failures", topics: ["state"], evidenceNeeds: ["non-mutating role status contract"], limits: "No role, assignment, or permission is inferred from tool absence." },
  { id: "telemetry.storage-health", purpose: "Check existing Telemetry recording status", topics: ["telemetry"], evidenceNeeds: ["Telemetry storage state", "dropped/unconfirmed records"], limits: "In-memory counters can remain usable when recording fails. No cleanup is performed." },
  { id: "telemetry.observation-integrity", purpose: "Check Telemetry observation errors and event gaps", topics: ["telemetry"], evidenceNeeds: ["observation errors", "unpaired events", "abandoned spans"], limits: "A correlation gap does not establish operational failure or answer quality." },
  { id: "context.headroom-status", purpose: "Inspect the native active-context estimate", topics: ["session"], evidenceNeeds: ["native context usage", "model context window"], limits: "Unknown usage stays unknown. This does not establish compaction admission or trigger compaction." },
  { id: "state.provider-readiness", purpose: "Read cached native/history provider readiness", topics: ["state"], evidenceNeeds: ["cached status without initialization or ancestry reads"], limits: "Unsupported cached contracts remain unknown. No stores are opened or repaired." },
  { id: "resources.transition-readiness", purpose: "Inspect known managed jobs and sessions", topics: ["resources"], evidenceNeeds: ["Grounded Process readiness reply", "native idle/queue status"], limits: "Not transition permission or complete coverage of dialogs and third-party resources." },
];
export const CHECK_IDS = CHECKS.map(check => check.id);
export const OVERVIEW_CHECKS = ["runtime.loaded-source-match", "telemetry.storage-health", "context.headroom-status"];
export const QUICK_CHECKS = ["runtime.compatibility", "tools.exposure-consistency", "telemetry.storage-health", "telemetry.observation-integrity", "context.headroom-status", "resources.transition-readiness"];
export function checkTopics(ids: string[]): Topic[] {
  return [...new Set(CHECKS.filter(check => ids.includes(check.id)).flatMap(check => check.topics))];
}
export function audit(ids: string[], providers: Evidence[], cancelled = false): Finding[] {
  const fields = new Map(providers.flatMap(provider => provider.fields.map(field => [field.id, field] as const)));
  const value = (id: string) => fields.get(id)?.value;
  return ids.map(checkId => {
    const check = CHECKS.find(item => item.id === checkId)!;
    const result = (outcome: Finding["outcome"], explanation: string, evidence: string[], nextInspection: string): Finding => ({
      checkId, outcome, severity: outcome === "fail" ? "error" : outcome === "warn" ? "warning" : "info",
      explanation, evidence, nextInspection,
    });
    const unknown = (reason: string, evidence: string[] = []) => result("unknown", reason, evidence, "Inspect the existing owner interface. Do not repair from this result alone.");
    if (cancelled) return result("skipped", "The request was cancelled before this check completed.", [], "Run only the needed check in a new explicit request.");
    switch (checkId) {
      case "runtime.compatibility": {
        const version = value("runtime.runningVersion");
        if (typeof version !== "string") return unknown("Running Pi identity is unavailable.", ["runtime.runningVersion"]);
        const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
        if (!match) return unknown("Running Pi version cannot be compared.", ["runtime.runningVersion"]);
        const supported = Number(match[1]) === 0 && Number(match[2]) === 99 && Number(match[3]) >= 1;
        return result(supported ? "pass" : "warn", supported ? "Running Pi is in the diagnostics tested API range (>=0.99.1 <0.100.0)." : "Running Pi is outside the diagnostics tested API range. This is not proof of a broken component.", ["runtime.runningVersion", "runtime.testedRange"], "Exercise diagnostics on this host before relying on unsupported API fields.");
      }
      case "runtime.loaded-source-match": {
        const pairs = ["diagnostics", "reload"].filter(id => typeof value(`${id}.loadedSha256`) === "string" && typeof value(`${id}.selectedSha256`) === "string");
        const references = pairs.flatMap(id => [`${id}.loadedSha256`, `${id}.selectedSha256`]);
        if (!pairs.length) return unknown("No comparable loaded entrypoint attestation is available.", ["diagnostics.loadedSha256", "reload.loadedSha256"]);
        const mismatch = pairs.some(id => value(`${id}.loadedSha256`) !== value(`${id}.selectedSha256`));
        return result(mismatch ? "fail" : "pass", mismatch ? "A selected entrypoint differs from its factory-time attestation." : "Comparable selected entrypoints match their factory-time attestations. Coverage is limited to the listed components.", references, "Inspect the component's selected source and loaded identity. Matching entrypoints do not prove dependency adoption.");
      }
      case "tools.exposure-consistency": {
        if (value("tools.invalidActiveCount") === null || value("tools.invalidActiveCount") === undefined) return unknown("Native registered/active tool metadata is unavailable.", ["tools.invalidActiveCount"]);
        const invalid = Number(value("tools.invalidActiveCount"));
        const policy = value("tools.policyViolationCount");
        const configErrors = value("tools.configurationErrorCount");
        if (typeof configErrors === "number" && configErrors > 0) return result("warn", "The policy owner reports configuration errors. A fallback policy is not proof of the intended policy.", ["tools.configurationErrorCount", "tools.policyObservedAt"], "Inspect /tool-audit and the intended policy configuration.");
        if (invalid > 0 || (typeof policy === "number" && policy > 0)) return result("warn", "Active tool names disagree with native registration or the owner's reported policy.", ["tools.invalidActiveCount", "tools.policyViolationCount"], "Inspect native tool source metadata and /tool-audit. Preserve intentional replacements and policy exclusions.");
        if (typeof policy !== "number" || value("tools.unclassifiedPolicyCount") !== 0) return unknown("Native active names are consistent, but managed policy coverage is unavailable or incomplete.", ["tools.invalidActiveCount", "tools.policyViolationCount", "tools.unclassifiedPolicyCount"]);
        return result("pass", "Native active names and the owner's reported policy are consistent. Practical callability is not tested.", ["tools.invalidActiveCount", "tools.policyViolationCount"], "Use the relevant tool normally when practical verification is needed.");
      }
      case "telemetry.storage-health": {
        const state = value("telemetry.storage.state");
        if (typeof state !== "string") return unknown("Telemetry storage evidence is unavailable.", ["telemetry.storage.state"]);
        const refs = ["telemetry.storage.state", "telemetry.storage.error", "telemetry.storage.dropped", "telemetry.storage.unconfirmedWrites"];
        if (state === "recording" && (!refs.slice(2).every(key => typeof value(key) === "number"))) return unknown("Telemetry recording counters are incomplete.", refs);
        const unhealthy = ["full", "failed"].includes(state) || Number(value("telemetry.storage.dropped") ?? 0) > 0 || Number(value("telemetry.storage.unconfirmedWrites") ?? 0) > 0;
        if (["idle", "closed"].includes(state)) return result("skipped", "Telemetry recording is inactive. No active recording health is established.", refs, "Inspect /context-telemetry if recording was expected.");
        if (!["recording", "full", "failed"].includes(state)) return unknown("Telemetry storage has not confirmed active recording.", refs);
        return result(unhealthy ? "warn" : "pass", unhealthy ? "Telemetry reports a recording limit, failure, or lost/unconfirmed records. In-memory metrics may still be available." : "Telemetry reports no recording problem in this collector run.", refs, "Inspect /context-telemetry. Any storage change requires separate authorization.");
      }
      case "telemetry.observation-integrity": {
        const keys = ["telemetry.runtime.observationErrors", "telemetry.runtime.correlationDrops", ...["agent", "turn", "tool", "compaction"].flatMap(operation => [`telemetry.runtime.${operation}.unpaired`, `telemetry.runtime.${operation}.abandoned`])];
        if (!keys.every(key => typeof value(key) === "number")) return unknown("Telemetry correlation evidence is incomplete.", keys);
        const gap = keys.some(key => Number(value(key)) > 0);
        return result(gap ? "warn" : "pass", gap ? "Telemetry reports observation errors or event pairing gaps. Operation outcomes and answer quality are not inferred." : "Telemetry reports no observation errors or pairing gaps in this run.", keys, "Inspect the collector-run interval and owner event coverage.");
      }
      case "context.headroom-status": {
        const tokens = value("context.tokens"), window = value("context.window");
        const keys = ["context.tokens", "context.window", "context.percent", "context.compactionAdmission"];
        if (typeof tokens !== "number" || typeof window !== "number" || window <= 0) return unknown("Native active-context usage is unknown, for example after compaction. No value is reconstructed.", keys);
        return result(tokens >= window * 0.9 ? "warn" : "pass", tokens >= window * 0.9 ? "The native active-context estimate is at least 90% of the model window." : "The native active-context estimate is below 90% of the model window. Compaction admission and reserves remain unavailable.", keys, "Inspect native /session and the context owner's readiness. Do not compact automatically.");
      }
      case "resources.transition-readiness": {
        const jobs = value("resources.runningProcesses"), sessions = value("resources.openSessions");
        const keys = ["resources.runningProcesses", "resources.openSessions", "resources.idle", "resources.pendingMessages"];
        if (typeof jobs !== "number" || typeof sessions !== "number") return unknown("Managed resource coverage is unavailable or invalid.", keys);
        const busy = jobs > 0 || sessions > 0 || value("resources.idle") === false || value("resources.pendingMessages") === true;
        return result(busy ? "warn" : "pass", busy ? "Known managed resources or native work are active. Preserve that work." : "No blockers appear in the reported managed resources and native idle/queue fields. Other safety checks are not covered.", keys, "Use the transition owner's safety engine if a separately approved transition is needed.");
      }
      default:
        return unknown(`${check.purpose} is unsupported by a cached read-only contract in this release. Missing evidence is not a pass.`, checkId === "runtime.startup-errors" ? ["runtime.startupDiagnostics"] : ["state.cachedReadiness"]);
    }
  });
}
