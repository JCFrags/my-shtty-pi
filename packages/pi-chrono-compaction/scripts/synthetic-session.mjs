// @ts-nocheck
const PROFILE_NAMES = ["small", "medium", "large", "adversarial", "multi-agent"];
const MAX_EVENTS = 100_000;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_COMPACTIONS = 10_000;
const MAX_AGENTS = 64;
const DEFAULT_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export const SYNTHETIC_PROFILES = Object.freeze({
  small: Object.freeze({ eventCount: 80, toolResultBytes: 1024, giantRecordBytes: 0, forkEvery: 0, compactionCount: 1, agentCount: 1, shardEntries: 16 }),
  medium: Object.freeze({ eventCount: 240, toolResultBytes: 4 * 1024, giantRecordBytes: 0, forkEvery: 40, compactionCount: 4, agentCount: 2, shardEntries: 64 }),
  large: Object.freeze({ eventCount: 2_000, toolResultBytes: 16 * 1024, giantRecordBytes: 2 * 1024 * 1024, forkEvery: 250, compactionCount: 12, agentCount: 4, shardEntries: 256 }),
  adversarial: Object.freeze({ eventCount: 96, toolResultBytes: 8 * 1024, giantRecordBytes: 8 * 1024 * 1024, forkEvery: 11, compactionCount: 8, agentCount: 3, shardEntries: 20 }),
  "multi-agent": Object.freeze({ eventCount: 320, toolResultBytes: 2 * 1024, giantRecordBytes: 0, forkEvery: 32, compactionCount: 5, agentCount: 8, shardEntries: 40 }),
});

function boundedInteger(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`synthetic-${name}`);
  return value;
}

function knownKeys(value, allowed) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error("synthetic-option");
}

export function resolveSyntheticProfile(input = "small") {
  const options = typeof input === "string" ? { profile: input } : input;
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("synthetic-profile");
  knownKeys(options, new Set(["profile", "eventCount", "toolResultBytes", "giantRecordBytes", "giantRecordIndex", "forkEvery", "compactionCount", "agentCount", "shardEntries", "malformedTail", "sessionId"]));
  const profile = options.profile ?? "small";
  if (!PROFILE_NAMES.includes(profile)) throw new Error("synthetic-profile");
  const preset = SYNTHETIC_PROFILES[profile];
  const eventCount = boundedInteger("event-count", options.eventCount ?? preset.eventCount, 1, MAX_EVENTS);
  const toolResultBytes = boundedInteger("tool-result-bytes", options.toolResultBytes ?? preset.toolResultBytes, 0, MAX_RESULT_BYTES);
  const giantRecordBytes = boundedInteger("giant-record-bytes", options.giantRecordBytes ?? preset.giantRecordBytes, 0, MAX_RESULT_BYTES);
  const giantRecordIndex = boundedInteger("giant-record-index", options.giantRecordIndex ?? Math.max(0, eventCount - 2), 0, eventCount - 1);
  const forkEvery = boundedInteger("fork-every", options.forkEvery ?? preset.forkEvery, 0, eventCount);
  const compactionCount = boundedInteger("compaction-count", options.compactionCount ?? preset.compactionCount, 0, Math.min(MAX_COMPACTIONS, eventCount));
  const agentCount = boundedInteger("agent-count", options.agentCount ?? preset.agentCount, 1, MAX_AGENTS);
  const shardEntries = boundedInteger("shard-entries", options.shardEntries ?? Math.min(preset.shardEntries, eventCount), 1, eventCount);
  const malformedTail = options.malformedTail ?? "none";
  if (!["none", "truncated-json", "invalid-json", "missing-newline"].includes(malformedTail)) throw new Error("synthetic-malformed-tail");
  const sessionId = options.sessionId ?? `synthetic-${profile}`;
  if (typeof sessionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(sessionId)) throw new Error("synthetic-session-id");
  return Object.freeze({ profile, eventCount, toolResultBytes, giantRecordBytes, giantRecordIndex, forkEvery, compactionCount, agentCount, shardEntries, malformedTail, sessionId });
}

function deterministicText(bytes, label) {
  if (bytes === 0) return "";
  const unit = `${label}:0123456789abcdefghijklmnopqrstuvwxyz\n`;
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

function compactionPositions(eventCount, compactionCount) {
  const positions = new Set();
  for (let index = 1; index <= compactionCount; index += 1) positions.add(Math.max(0, Math.ceil((index * eventCount) / (compactionCount + 1)) - 1));
  return positions;
}

function messageEntry(index, parentId, config) {
  const id = `syn-e-${String(index + 1).padStart(6, "0")}`;
  const agent = `agent-${String((index % config.agentCount) + 1).padStart(2, "0")}`;
  const phase = index % 4;
  if (phase === 0) return { type: "message", id, parentId, timestamp: DEFAULT_TIMESTAMP, message: { role: "user", content: `Task ${index + 1} for ${agent}: preserve deterministic state and request approval before release.` } };
  if (phase === 1) return { type: "message", id, parentId, timestamp: DEFAULT_TIMESTAMP, message: { role: "assistant", content: [{ type: "toolCall", id: `syn-call-${index + 1}`, name: "read", arguments: { path: `/synthetic/${agent}/unit-${index + 1}.ts`, offset: 1, limit: 80 } }], stopReason: "toolUse" } };
  if (phase === 2) {
    const bytes = index === config.giantRecordIndex && config.giantRecordBytes > 0 ? config.giantRecordBytes : config.toolResultBytes;
    return { type: "message", id, parentId, timestamp: DEFAULT_TIMESTAMP, message: { role: "toolResult", toolCallId: `syn-call-${index}`, toolName: "read", content: [{ type: "text", text: deterministicText(bytes, `result-${index + 1}-${agent}`) }], isError: index % 37 === 2, details: { exitCode: index % 37 === 2 ? 1 : 0 } } };
  }
  return { type: "message", id, parentId, timestamp: DEFAULT_TIMESTAMP, message: { role: "assistant", content: [{ type: "text", text: `Observed deterministic event ${index + 1} for ${agent}; later work may supersede it.` }], stopReason: "stop" } };
}

export function createSyntheticSession(input = "small") {
  const config = resolveSyntheticProfile(input);
  const header = { type: "session", version: 3, id: config.sessionId, timestamp: DEFAULT_TIMESTAMP, cwd: "/synthetic" };
  const entries = [];
  const generations = [];
  const compactAt = compactionPositions(config.eventCount, config.compactionCount);
  let mainParent = null;
  let compactionOrdinal = 0;
  for (let index = 0; index < config.eventCount; index += 1) {
    const fork = config.forkEvery > 0 && index > 1 && (index + 1) % config.forkEvery === 0;
    const parentId = fork ? entries[Math.max(0, index - 2)]?.id ?? mainParent : mainParent;
    let entry;
    if (compactAt.has(index)) {
      compactionOrdinal += 1;
      entry = { type: "compaction", id: `syn-c-${String(compactionOrdinal).padStart(4, "0")}`, parentId, timestamp: DEFAULT_TIMESTAMP, summary: `Synthetic compaction ${compactionOrdinal}; unresolved work remains.`, tokensBefore: (index + 1) * 128 };
      generations.push(entries.length + 1);
    } else {
      entry = messageEntry(index, parentId, config);
    }
    entries.push(entry);
    if (!fork) mainParent = entry.id;
  }
  const shards = createShardPlan(entries, config.shardEntries);
  return Object.freeze({ schemaVersion: 1, config, header: Object.freeze(header), entries: Object.freeze(entries), generations: Object.freeze(generations), shards });
}

export function serializeSyntheticSession(session, options = {}) {
  if (!session || session.schemaVersion !== 1 || !session.header || !Array.isArray(session.entries)) throw new Error("synthetic-session");
  knownKeys(options, new Set(["malformedTail"]));
  const malformedTail = options.malformedTail ?? session.config?.malformedTail ?? "none";
  if (!["none", "truncated-json", "invalid-json", "missing-newline"].includes(malformedTail)) throw new Error("synthetic-malformed-tail");
  const complete = [session.header, ...session.entries].map((record) => JSON.stringify(record)).join("\n");
  if (malformedTail === "truncated-json") return `${complete}\n{"type":"message","id":"incomplete`;
  if (malformedTail === "invalid-json") return `${complete}\nnot-json\n`;
  return malformedTail === "missing-newline" ? complete : `${complete}\n`;
}

export function createShardPlan(entries, shardEntries) {
  boundedInteger("shard-entries", shardEntries, 1, MAX_EVENTS);
  const shards = [];
  for (let start = 0; start < entries.length; start += shardEntries) {
    const records = entries.slice(start, start + shardEntries);
    const content = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    shards.push(Object.freeze({ ordinal: shards.length, startEntry: start, endEntryExclusive: start + records.length, recordCount: records.length, bytes: Buffer.byteLength(content), content }));
  }
  return Object.freeze({ schemaVersion: 1, rolloverAfterEntries: shardEntries, shards: Object.freeze(shards) });
}

export function appendScenario(session, appendEventCount = 4) {
  boundedInteger("append-event-count", appendEventCount, 1, 10_000);
  const initialText = serializeSyntheticSession(session);
  const lastId = session.entries.at(-1)?.id ?? null;
  const appendEntries = Array.from({ length: appendEventCount }, (_, offset) => ({
    type: "message", id: `syn-append-${String(offset + 1).padStart(6, "0")}`, parentId: offset === 0 ? lastId : `syn-append-${String(offset).padStart(6, "0")}`,
    timestamp: DEFAULT_TIMESTAMP, message: { role: "user", content: `Concurrent append event ${offset + 1}.` },
  }));
  const appendText = appendEntries.map((record) => JSON.stringify(record)).join("\n") + "\n";
  return Object.freeze({ checkpointBytes: Buffer.byteLength(initialText), initialText, appendText, finalText: initialText + appendText, appendEntries: Object.freeze(appendEntries) });
}

export function replaceScenario(session) {
  const currentId = session.config.sessionId;
  const replacementId = `${currentId.slice(0, -1)}${currentId.endsWith("x") ? "y" : "x"}`;
  const replacement = createSyntheticSession({ ...session.config, sessionId: replacementId });
  return Object.freeze({ originalText: serializeSyntheticSession(session), replacementText: serializeSyntheticSession(replacement) });
}

export function truncateScenario(session, retainedBytes) {
  const originalText = serializeSyntheticSession(session);
  boundedInteger("retained-bytes", retainedBytes, 0, Buffer.byteLength(originalText));
  return Object.freeze({ originalBytes: Buffer.byteLength(originalText), retainedBytes, truncated: Buffer.from(originalText).subarray(0, retainedBytes).toString("utf8") });
}

export function mutatePrefixScenario(session, byteOffset = 0) {
  const original = Buffer.from(serializeSyntheticSession(session));
  boundedInteger("mutation-offset", byteOffset, 0, Math.max(0, original.length - 1));
  const mutated = Buffer.from(original);
  mutated[byteOffset] = mutated[byteOffset] === 0x78 ? 0x79 : 0x78;
  return Object.freeze({ byteOffset, originalText: original.toString("utf8"), mutatedText: mutated.toString("utf8") });
}

export function syntheticEntries(taskCount = 250) {
  boundedInteger("task-count", taskCount, 1, 5_000);
  const entries = [{ type: "message", id: "syn-root", parentId: null, message: { role: "user", content: "Maintain the year-run service. Never publish private evidence. Keep immutable JSONL. The migration remains unresolved until approval." } }];
  let parentId = "syn-root";
  for (let task = 1; task <= taskCount; task += 1) {
    const userId = `syn-u-${task}`, callEntryId = `syn-a-${task}`, resultId = `syn-r-${task}`, answerId = `syn-f-${task}`, callId = `syn-call-${task}`;
    if ((task - 1) % 10 === 0) { entries.push({ type: "message", id: userId, parentId, message: { role: "user", content: `Inspect year-run revisions for tasks ${task} through ${Math.min(taskCount, task + 9)} and report state changes.` } }); parentId = userId; }
    entries.push({ type: "message", id: callEntryId, parentId, message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "/repo/src/year-run.ts", revision: `r${task}`, offset: 1, limit: 80 } }], stopReason: "toolUse" } });
    const middle = Array.from({ length: 70 }, (_, line) => `export const stable${line} = ${line};`).join("\n");
    const failure = task === 173 ? "\nERROR migration guard expected=pending received=complete" : "";
    entries.push({ type: "message", id: resultId, parentId: callEntryId, message: { role: "toolResult", toolCallId: callId, toolName: "read", content: [{ type: "text", text: `export const revision = \"r${task}\";\n${middle}${failure}` }], isError: task === 173, details: { exitCode: task === 173 ? 1 : 0 } } });
    entries.push({ type: "message", id: answerId, parentId: resultId, message: { role: "assistant", content: [{ type: "text", text: task === taskCount ? `Revision r${taskCount} is current. Migration remains unresolved. Next action: obtain approval before release.` : `Observed revision r${task}; later work may supersede it.` }], stopReason: "stop" } });
    parentId = answerId;
  }
  return entries;
}
