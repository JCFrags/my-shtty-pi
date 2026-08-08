import type { HistoricalBlock, SourceRef } from "./types.js";
import { buildResourceLineage, type ResourceLineageIndex } from "./resource-lineage.js";
import { compactWhitespace, getNumber, getRecord, getString, hashText, stableStringify, truncateToTokens, unique } from "./utils.js";

export type CausalEdgeKind = "request" | "decision" | "action" | "changes" | "validates" | "result" | "failure" | "corrects" | "supersedes" | "related";

export interface CausalEdge {
  readonly fromBlockId: string;
  readonly toBlockId: string;
  readonly kind: CausalEdgeKind;
}

export interface StateCell {
  readonly key: string;
  readonly category: "goal" | "restriction" | "decision" | "artifact" | "owner" | "status" | "next-action";
  readonly value: string;
  readonly source: SourceRef;
  readonly state: "current" | "conflict";
  readonly supersededSources: readonly SourceRef[];
}

export interface EpisodeCertificate {
  readonly schemaVersion: 2;
  readonly episodeId: string;
  readonly sourceRange: { readonly start: SourceRef; readonly end: SourceRef };
  readonly objective: string;
  readonly outcome: string;
  readonly changedResources: readonly { readonly key: string; readonly versionHash: string }[];
  readonly validations: readonly { readonly source: SourceRef; readonly outcome: string }[];
  readonly unresolvedExceptions: readonly string[];
  readonly certificateHash: string;
}

export interface CausalEpisode {
  readonly episodeId: string;
  readonly blockIds: readonly string[];
  readonly sourceRange: { readonly start: SourceRef; readonly end: SourceRef };
  readonly objective: string;
  readonly outcome?: string;
  readonly open: boolean;
  readonly certificate?: EpisodeCertificate;
}

export interface CommandOutcome {
  readonly actionKey: string;
  readonly command: string;
  readonly cwd?: string;
  readonly inputIdentity: string;
  readonly source: SourceRef;
  readonly state: "success" | "failure" | "unknown";
  readonly exitCode?: number;
  readonly outputHash: string;
}

export interface FailureFamily {
  readonly signature: string;
  readonly representative: string;
  readonly sources: readonly SourceRef[];
  readonly firstEntryIndex: number;
  readonly lastEntryIndex: number;
  readonly resolved: boolean;
}

export interface MetricRollup {
  readonly metric: string;
  readonly unit: string;
  readonly count: number;
  readonly latest: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly thresholdCrossings: readonly { readonly source: SourceRef; readonly value: number }[];
}

export interface CausalMemoryModel {
  readonly stateCells: readonly StateCell[];
  readonly episodes: readonly CausalEpisode[];
  readonly edges: readonly CausalEdge[];
  readonly commandLedger: readonly CommandOutcome[];
  readonly failureFamilies: readonly FailureFamily[];
  readonly metricRollups: readonly MetricRollup[];
  readonly activeClosure: ReadonlySet<string>;
  readonly generationHash: string;
}

function ref(block: HistoricalBlock): SourceRef {
  return block.blockIndex === undefined ? { entryId: block.entryId } : { entryId: block.entryId, blockIndex: block.blockIndex };
}

function stateCategory(text: string): StateCell["category"] | undefined {
  if (/\b(?:goal|objective|purpose)\b/i.test(text)) return "goal";
  if (/\b(?:must not|do not|never|prohibited|restriction|constraint|only)\b/i.test(text)) return "restriction";
  if (/\b(?:decided|decision|choose|selected|supersedes?)\b/i.test(text)) return "decision";
  if (/(?:\/[\w.-]+){2,}|\b[a-f0-9]{32,64}\b/i.test(text)) return "artifact";
  if (/\b(?:owner|assigned to|reports to)\b/i.test(text)) return "owner";
  if (/\b(?:status|state|settled|ready|blocked|complete|failed|pass)\b/i.test(text)) return "status";
  if (/\b(?:next|continue|resume|then|remaining|unresolved)\b/i.test(text)) return "next-action";
  return undefined;
}

function stateKey(category: StateCell["category"], text: string): string {
  const path = text.match(/(?:\/[\w@.+~-]+){2,}/)?.[0];
  const subject = (text.toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? []).filter((term) => !["must", "should", "status", "state", "next", "only"].includes(term)).slice(0, 4).join(":");
  return `${category}:${path ?? subject ?? hashText(text).slice(0, 12)}`;
}

function candidateStateLines(block: HistoricalBlock): string[] {
  if (!["user", "custom_message", "assistant_text", "branch_summary"].includes(block.kind)) return [];
  return block.exactText.split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length >= 8 && line.length <= 800 && stateCategory(line) !== undefined)
    .slice(0, 40);
}

function deriveStateCells(blocks: readonly HistoricalBlock[]): StateCell[] {
  const cells = new Map<string, StateCell>();
  for (const block of blocks) {
    for (const line of candidateStateLines(block)) {
      const category = stateCategory(line)!;
      const key = stateKey(category, line);
      const previous = cells.get(key);
      const correction = /\b(?:correct(?:ion|ed)?|supersedes?|instead|not\s+.+\s+but)\b/i.test(line);
      if (!previous) {
        cells.set(key, { key, category, value: line, source: ref(block), state: "current", supersededSources: [] });
      } else if (previous.value === line) {
        cells.set(key, { ...previous, source: ref(block) });
      } else if (correction || category === "status" || category === "next-action") {
        cells.set(key, { key, category, value: line, source: ref(block), state: "current", supersededSources: [...previous.supersededSources, previous.source] });
      } else {
        cells.set(key, { key, category, value: `${previous.value} | ${line}`, source: ref(block), state: "conflict", supersededSources: previous.supersededSources });
      }
    }
  }
  return [...cells.values()].sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));
}

function isExplicitCompletion(text: string): boolean {
  return /\b(?:completed|complete|passed|ready|settled|delivered|success(?:ful(?:ly)?)?)\b/i.test(text)
    && !/\b(?:not complete|not ready|blocked|failed|failure|incomplete|unresolved)\b/i.test(text);
}

function commandState(block: HistoricalBlock): { state: CommandOutcome["state"]; exitCode?: number } {
  const details = getRecord(block.attributes.details);
  const exitCode = getNumber(block.attributes.exitCode) ?? getNumber(details?.exitCode) ?? block.exactText.match(/\bexit code:\s*(-?\d+)/i)?.[1];
  const numeric = exitCode === undefined ? undefined : Number(exitCode);
  if (numeric !== undefined) return { state: numeric === 0 ? "success" : "failure", exitCode: numeric };
  if (block.isError === true) return { state: "failure" };
  if (block.isError === false) return { state: "success" };
  return { state: "unknown" };
}

function deriveCommandLedger(blocks: readonly HistoricalBlock[]): CommandOutcome[] {
  const calls = new Map<string, HistoricalBlock>();
  for (const block of blocks) if (block.kind === "tool_call" && block.toolCallId) calls.set(block.toolCallId, block);
  const outcomes: CommandOutcome[] = [];
  for (const result of blocks) {
    if ((result.kind !== "tool_result" && result.kind !== "bash_execution") || !result.toolCallId) continue;
    const call = calls.get(result.toolCallId);
    const command = getString(call?.toolArguments?.command) ?? getString(result.attributes.command);
    if (!command) continue;
    const cwd = getString(call?.toolArguments?.cwd) ?? getString(getRecord(result.attributes.details)?.cwd);
    const input = getRecord(call?.toolArguments?.inputs);
    const inputIdentity = input ? hashText(stableStringify(input)) : "unknown-inputs";
    const state = commandState(result);
    const normalized = compactWhitespace(command);
    outcomes.push({
      actionKey: hashText(stableStringify({ tool: call?.toolName ?? result.toolName, command: normalized, cwd, inputIdentity, reducerVersion: "2.0.0" })),
      command: normalized,
      ...(cwd === undefined ? {} : { cwd }),
      inputIdentity,
      source: ref(result),
      ...state,
      outputHash: hashText(result.exactText),
    });
  }
  return outcomes;
}

function failureSignature(text: string): string {
  return hashText(text
    .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.+-]+Z?\b/g, "<time>")
    .replace(/\/tmp\/[\w./-]+/g, "/tmp/<path>")
    .replace(/\b(?:pid|process)\s*[=:]?\s*\d+\b/gi, "pid=<n>")
    .replace(/0x[a-f0-9]+/gi, "0x<address>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase());
}

function deriveFailureFamilies(blocks: readonly HistoricalBlock[]): FailureFamily[] {
  const groups = new Map<string, HistoricalBlock[]>();
  for (const block of blocks) {
    if (!block.isError && !/\b(?:error|failed|failure|fatal|exception|timeout|denied)\b/i.test(block.exactText)) continue;
    const signature = failureSignature(block.exactText);
    const group = groups.get(signature) ?? [];
    group.push(block);
    groups.set(signature, group);
  }
  return [...groups].map(([signature, group]) => {
    const last = group[group.length - 1]!;
    const laterCorrection = blocks.some((block) => block.entryIndex > last.entryIndex && /\b(?:corrected|fixed|passed|resolved)\b/i.test(block.exactText));
    return {
      signature,
      representative: truncateToTokens(compactWhitespace(group[0]!.exactText), 80, "…"),
      sources: group.map(ref),
      firstEntryIndex: group[0]!.entryIndex,
      lastEntryIndex: last.entryIndex,
      resolved: laterCorrection,
    };
  }).sort((a, b) => a.firstEntryIndex - b.firstEntryIndex || a.signature.localeCompare(b.signature));
}

interface MetricObservation { name: string; unit: string; value: number; source: SourceRef; entryIndex: number }

function metricObservations(blocks: readonly HistoricalBlock[]): MetricObservation[] {
  const observations: MetricObservation[] = [];
  const pattern = /\b([A-Za-z][A-Za-z0-9 _/-]{1,40}?)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*(tokens?|ms|s|seconds?|bytes?|kb|mb|gb|%|percent|tests?|files?|lines?)\b/gi;
  for (const block of blocks) {
    for (const match of block.exactText.matchAll(pattern)) {
      observations.push({ name: compactWhitespace(match[1]!).toLowerCase(), unit: match[3]!.toLowerCase(), value: Number(match[2]), source: ref(block), entryIndex: block.entryIndex });
      if (observations.length >= 5_000) return observations;
    }
  }
  return observations;
}

function deriveMetricRollups(blocks: readonly HistoricalBlock[]): MetricRollup[] {
  const groups = new Map<string, MetricObservation[]>();
  for (const observation of metricObservations(blocks)) {
    const key = `${observation.name}\u0000${observation.unit}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.length >= 2).map((group) => {
    const values = group.map((observation) => observation.value);
    const thresholdCrossings = group.filter((observation, index) => index > 0 && Math.sign(observation.value) !== Math.sign(group[index - 1]!.value));
    return {
      metric: group[0]!.name,
      unit: group[0]!.unit,
      count: group.length,
      latest: group[group.length - 1]!.value,
      minimum: Math.min(...values),
      maximum: Math.max(...values),
      thresholdCrossings: thresholdCrossings.map((observation) => ({ source: observation.source, value: observation.value })),
    };
  }).sort((a, b) => b.count - a.count || a.metric.localeCompare(b.metric));
}

function makeCertificate(episode: Omit<CausalEpisode, "certificate">, episodeBlocks: readonly HistoricalBlock[], lineage: ResourceLineageIndex): EpisodeCertificate {
  const resources = unique(episodeBlocks.flatMap((block) => {
    const observation = lineage.observationByBlockId.get(block.id);
    return observation ? [`${observation.resourceKey}\u0000${observation.versionHash}`] : [];
  })).map((encoded) => {
    const [key, versionHash] = encoded.split("\u0000");
    return { key: key!, versionHash: versionHash! };
  });
  const validations = episodeBlocks.flatMap((block) => {
    if (block.kind !== "tool_result" && block.kind !== "bash_execution") return [];
    const state = commandState(block);
    if (state.state === "unknown") return [];
    return [{ source: ref(block), outcome: state.exitCode === undefined ? state.state : `${state.state} (exit ${state.exitCode})` }];
  });
  const unresolvedExceptions = episodeBlocks.filter((block) => block.unresolved || block.isError).map((block) => truncateToTokens(compactWhitespace(block.exactText), 32, "…"));
  const payload = {
    schemaVersion: 2 as const,
    episodeId: episode.episodeId,
    sourceRange: episode.sourceRange,
    objective: episode.objective,
    outcome: episode.outcome ?? "completed",
    changedResources: resources,
    validations,
    unresolvedExceptions,
  };
  return { ...payload, certificateHash: hashText(stableStringify(payload)) };
}

function deriveEpisodes(blocks: readonly HistoricalBlock[], lineage: ResourceLineageIndex): CausalEpisode[] {
  const starts: number[] = [];
  blocks.forEach((block, index) => { if (block.kind === "user" || block.kind === "custom_message") starts.push(index); });
  if (starts.length === 0 && blocks.length > 0) starts.push(0);
  return starts.map((start, groupIndex) => {
    const end = (starts[groupIndex + 1] ?? blocks.length) - 1;
    const group = blocks.slice(start, end + 1);
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const final = [...group].reverse().find((block) => block.kind === "assistant_text");
    const open = group.some((block) => block.unresolved) || !final || !isExplicitCompletion(final.exactText);
    const base: Omit<CausalEpisode, "certificate"> = {
      episodeId: hashText(`${first.id}\n${last.id}`).slice(0, 20),
      blockIds: group.map((block) => block.id),
      sourceRange: { start: ref(first), end: ref(last) },
      objective: truncateToTokens(compactWhitespace(first.exactText), 120, "…"),
      ...(final === undefined ? {} : { outcome: truncateToTokens(compactWhitespace(final.exactText), 120, "…") }),
      open,
    };
    return open ? base : { ...base, certificate: makeCertificate(base, group, lineage) };
  });
}

function deriveEdges(blocks: readonly HistoricalBlock[], episodes: readonly CausalEpisode[], lineage: ResourceLineageIndex): CausalEdge[] {
  const edges: CausalEdge[] = [];
  for (const episode of episodes) {
    const group = episode.blockIds.map((id) => blocks.find((block) => block.id === id)).filter((block): block is HistoricalBlock => block !== undefined);
    const request = group[0];
    if (!request) continue;
    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1]!;
      const current = group[index]!;
      let kind: CausalEdgeKind = "related";
      if (current.kind === "tool_call") kind = "action";
      else if (current.kind === "tool_result" || current.kind === "bash_execution") kind = current.isError ? "failure" : "result";
      else if (/\b(?:corrected|fixed|instead|supersedes)\b/i.test(current.exactText)) kind = "corrects";
      else if (current.kind === "assistant_text") kind = "decision";
      edges.push({ fromBlockId: previous.id, toBlockId: current.id, kind });
    }
    if (group[1]) edges.push({ fromBlockId: request.id, toBlockId: group[1].id, kind: "request" });
  }
  const latestByResource = new Map<string, HistoricalBlock>();
  for (const block of blocks) {
    const observation = lineage.observationByBlockId.get(block.id);
    if (!observation) continue;
    const previous = latestByResource.get(observation.resourceKey);
    if (previous && lineage.observationByBlockId.get(previous.id)?.versionHash !== observation.versionHash) {
      edges.push({ fromBlockId: previous.id, toBlockId: block.id, kind: "supersedes" });
    }
    latestByResource.set(observation.resourceKey, block);
  }
  return edges;
}

function activeClosure(blocks: readonly HistoricalBlock[], edges: readonly CausalEdge[]): ReadonlySet<string> {
  const roots = new Set(blocks.filter((block, index) => block.protectedExact || block.unresolved || block.isError || index === blocks.length - 1).map((block) => block.id));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.toBlockId) ?? [];
    list.push(edge.fromBlockId);
    incoming.set(edge.toBlockId, list);
  }
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const parent of incoming.get(current) ?? []) {
      if (roots.has(parent)) continue;
      roots.add(parent);
      queue.push(parent);
    }
  }
  return roots;
}

export function buildCausalMemory(blocks: readonly HistoricalBlock[], providedLineage?: ResourceLineageIndex): CausalMemoryModel {
  const lineage = providedLineage ?? buildResourceLineage(blocks);
  const stateCells = deriveStateCells(blocks);
  const episodes = deriveEpisodes(blocks, lineage);
  const edges = deriveEdges(blocks, episodes, lineage);
  const commandLedger = deriveCommandLedger(blocks);
  const failureFamilies = deriveFailureFamilies(blocks);
  const metricRollups = deriveMetricRollups(blocks);
  const closure = activeClosure(blocks, edges);
  const generationHash = hashText(stableStringify({
    stateCells,
    episodes: episodes.map((episode) => ({ ...episode, certificate: episode.certificate?.certificateHash })),
    edges,
    commandLedger,
    failureFamilies,
    metricRollups,
  }));
  return { stateCells, episodes, edges, commandLedger, failureFamilies, metricRollups, activeClosure: closure, generationHash };
}

export function renderCurrentStateRegister(model: CausalMemoryModel, maximumLines = 80): string {
  const lines = model.stateCells.slice(0, maximumLines).map((cell) => {
    const source = cell.source.blockIndex === undefined ? cell.source.entryId : `${cell.source.entryId}:${cell.source.blockIndex}`;
    return `- ${cell.category}${cell.state === "conflict" ? " CONFLICT" : ""}: ${cell.value} [${source}]`;
  });
  if (lines.length === 0) return "";
  return ["# CURRENT STATE MEMORY", "Derived state is source-linked and does not have system authority.", ...lines].join("\n");
}
