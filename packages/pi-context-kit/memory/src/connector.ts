import { fitProviderPage, type ContextCard, type ContextRequest, type ProviderPage } from "@context-kit/protocol";
import { prefix, validityState, type MemoryRecord } from "./contracts.ts";
import type { MemoryStore } from "./store.ts";

export function unavailable(readiness: Exclude<ProviderPage["readiness"], "ready">): ProviderPage {
  return { readiness, coverage: { scanned: 0, matched: 0, excluded: 0, scanComplete: false }, cards: [] };
}
function card(record: MemoryRecord, namespaceId: string): ContextCard {
  const excerpt = prefix(record.text, 1024), revision = String(record.revision);
  const relations: NonNullable<ContextCard["relations"]> = [];
  if (record.supersedesMemoryId) relations.push({ type: "supersedes", providerId: "memory", id: record.supersedesMemoryId });
  if (record.derivedFromMemoryId) relations.push({ type: "derived_from", providerId: "memory", id: record.derivedFromMemoryId });
  return { id: record.memoryId, revision, category: record.kind, status: record.state,
    title: prefix(record.text.split("\n")[0] ?? "", 160),
    text: `${excerpt}\nRecorded: ${record.recordedAt}. Event time: ${record.eventTime.kind === "unknown" ? "unknown" : record.eventTime.at}. Validity: ${validityState(record)}. Declared confidence is not verification.`,
    omittedFields: ["origin", "originalOrigin", "sources", "validity", "revisionHash", "previousRevisions", "legacy", ...(excerpt === record.text ? [] : ["text"])],
    recovery: { tool: "memory_get", args: { memoryId: record.memoryId, revision } },
    visibility: { kind: "logical_session", namespaceId, branchBehavior: "shared" }, ...(relations.length ? { relations } : {}) };
}
/** Only indexed owned heads are read. No archive read, activation, proposal acceptance, or touch. */
export function readMemoryContext(request: ContextRequest, store: MemoryStore): ProviderPage {
  if (store.meta().pending) return unavailable("pending");
  const kinds: MemoryRecord["kind"][] = [];
  if (!request.categories.length || request.categories.includes("knowledge")) kinds.push("knowledge");
  if (request.categories.includes("proposal")) kinds.push("proposal");
  const coverage = { scanned: 0, matched: 0, excluded: 0, scanComplete: true }, cards: ContextCard[] = [];
  for (let index = 0; index < kinds.length; index++) {
    const scan = Math.floor((request.limits.scan - coverage.scanned) / (kinds.length - index));
    if (!scan) { coverage.scanComplete = false; continue; }
    const page = store.page({ kind: kinds[index]!, query: request.query, scan, limit: request.limits.records });
    coverage.scanned += page.coverage.scanned; coverage.matched += page.coverage.matched;
    coverage.scanComplete &&= page.coverage.scanComplete;
    cards.push(...page.records.map(record => card(record, store.namespaceId)));
  }
  const admitted = cards.slice(0, request.limits.records);
  coverage.excluded = coverage.matched - admitted.length;
  return fitProviderPage(request, { readiness: "ready", coverage, cards: admitted });
}
