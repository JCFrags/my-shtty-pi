// Child-only module. Never import this module from the Pi extension or dispatcher.
import { lstat } from "node:fs/promises";
import { appendMemoryEvent, createMemoryEvent, memorySidecarPath, readMemoryEvents, searchMemories, type MemoryEvent } from "./memory-store.js";
import { getActiveBranch, readBoundedSessionJsonl } from "./jsonl.js";
import { historyGet, historyRange, historySearch } from "./retrieval.js";
import { buildLocalSearchIndex, renderRankedSearch, searchLocalHistory } from "./search-index.js";
import { buildCausalMemory } from "./causal-memory.js";
import { recallHistory, renderRecall } from "./recall.js";
import {
  boundedHistoryValue, HISTORY_FEEDBACK_LIMIT, HISTORY_WORKER_CAPS, LEGACY_HISTORY_MAX_BYTES,
  SEARCH_INDEX_SOURCE_MAX_BYTES, historyRefusal, historySourceAdmission,
  type HistoryWorkerRequest, type HistoryWorkerResponse, type HistoryWorkerSuccess, type HistoryWorkerStage,
} from "./history-worker-contract.js";

function boundedIds(values: Iterable<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value.length > 512 || seen.has(value)) continue;
    result.push(value); seen.add(value);
    if (result.length === HISTORY_FEEDBACK_LIMIT) break;
  }
  return result;
}

function encode(response: HistoryWorkerResponse): string {
  // Exact retrieval is never silently truncated. Oversize output is a refusal.
  if (response.status === "ok" && Buffer.byteLength(response.text) > 50 * 1024) return JSON.stringify(historyRefusal("history-output-limit"));
  const wire = JSON.stringify(response);
  return Buffer.byteLength(wire) <= HISTORY_WORKER_CAPS.responseBytes ? wire : JSON.stringify(historyRefusal("history-output-limit"));
}

/** Pure request/response handler for an already OS-bounded, one-shot child.
 * No cache, source mutation, full-index response, or fallback execution. */
export async function handleHistoryWorkerRequest(wire: string, progress: (stage: HistoryWorkerStage) => void = () => {}): Promise<string> {
  const finish = (response: HistoryWorkerResponse) => { progress("respond"); return encode(response); };
  try {
    progress("validate");
    if (typeof wire !== "string" || wire.length > HISTORY_WORKER_CAPS.requestBytes || Buffer.byteLength(wire) > HISTORY_WORKER_CAPS.requestBytes) return finish(historyRefusal("history-request-limit"));
    const request = JSON.parse(wire) as HistoryWorkerRequest;
    if (!boundedHistoryValue(request) || request.version !== 1 || typeof request.path !== "string" || !request.path.startsWith("/") || !request.source || !request.operation || !["get", "range", "legacy-search", "search", "recall"].includes(request.operation.kind)) return finish(historyRefusal("history-request-invalid"));
    const { operation: op, source } = request;
    if (typeof source.deviceId !== "string" || typeof source.inodeId !== "string" || !Number.isFinite(source.mtimeMs)) return finish(historyRefusal("history-request-invalid"));
    progress("admit");
    const refusal = historySourceAdmission(source.size, op);
    if (refusal) return finish(historyRefusal(refusal));
    const indexed = op.kind === "search" || op.kind === "recall";
    progress("read");
    const { session } = await readBoundedSessionJsonl(request.path, indexed ? SEARCH_INDEX_SOURCE_MAX_BYTES : LEGACY_HISTORY_MAX_BYTES, { expectedSource: source });
    let response: HistoryWorkerSuccess;
    if (op.kind === "get") {
      progress("query");
      response = { status: "ok", text: historyGet(session, op.entryId, op.options), details: { entryId: op.entryId, ...(op.options.blockIndex === undefined ? {} : { blockIndex: op.options.blockIndex }) } };
    } else if (op.kind === "range") {
      progress("query");
      response = { status: "ok", text: historyRange(session, op.startEntryId, op.endEntryId, op.options), details: { startEntryId: op.startEntryId, endEntryId: op.endEntryId } };
    } else if (op.kind === "legacy-search") {
      progress("query");
      response = { status: "ok", text: historySearch(session, op.query, op.options), details: { query: op.query, mode: "legacy-exact" } };
    } else {
      progress("index");
      const index = buildLocalSearchIndex(session);
      progress("query");
      if (op.kind === "search") {
        const result = searchLocalHistory(index, op.query, op.options);
        response = {
          status: "ok", text: renderRankedSearch(result),
          details: { query: op.query, mode: result.mode, generationHash: result.generationHash, hits: result.hits.length, tokenBudget: result.tokenBudget, returnedTokens: result.returnedTokens },
          feedback: {
            generationHash: result.generationHash, query: op.query,
            resultCount: result.hits.filter((hit) => !hit.context).length, retrievedTokens: result.returnedTokens,
            resourceKeys: boundedIds(result.hits.flatMap((hit) => hit.resourceKey ? [hit.resourceKey] : [])),
            blockIds: boundedIds(result.hits.flatMap((hit) => { const id = index.documentByKey.get(hit.key)?.block.id; return id ? [id] : []; })),
          },
        };
      } else {
        const model = buildCausalMemory(index.documents.map((document) => document.block), index.resourceLineage);
        const result = recallHistory(index, model, op.query, op.options);
        const keys = new Set(result.items.flatMap((item) => item.sourceIds));
        // Iterate without constructing a second full document list for feedback.
        const resources: string[] = [], blocks: string[] = [];
        for (const document of index.documents) {
          if (!keys.has(document.key) && !keys.has(document.block.entryId)) continue;
          if (blocks.length < HISTORY_FEEDBACK_LIMIT && document.block.id.length <= 512) blocks.push(document.block.id);
          if (resources.length < HISTORY_FEEDBACK_LIMIT && document.resourceKey && document.resourceKey.length <= 512) resources.push(document.resourceKey);
          if (blocks.length >= HISTORY_FEEDBACK_LIMIT && resources.length >= HISTORY_FEEDBACK_LIMIT) break;
        }
        response = {
          status: "ok", text: renderRecall(result),
          details: { query: op.query, level: result.level, generationHash: result.generationHash, items: result.items.length, tokenBudget: result.tokenBudget, renderedTokens: result.renderedTokens },
          feedback: { generationHash: result.generationHash, query: op.query, resultCount: result.items.length, retrievedTokens: result.renderedTokens, expandedItems: result.items.length, resourceKeys: boundedIds(resources), blockIds: boundedIds(blocks) },
        };
      }
    }
    // Validate output before any promotion writes. Oversize recall is a refusal,
    // not an operation whose successful side effects are hidden by truncation.
    if (JSON.parse(encode(response)).status !== "ok") return finish(historyRefusal("history-output-limit"));
    if (op.kind === "recall" && op.promotion) {
      progress("promotion");
      const path = memorySidecarPath(request.path);
      const checkSidecar = async () => {
        try {
          const state = await lstat(path);
          if (!state.isFile() || state.nlink !== 1 || (state.mode & 0o077) !== 0 || state.size > 256 * 1024) throw new Error("history-promotion-unavailable");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      };
      await checkSidecar();
      const memory = await readMemoryEvents(path, { maxReadBytes: 256 * 1024 });
      if (memory.status !== "ready") return finish(historyRefusal("history-promotion-unavailable"));
      const turn = getActiveBranch(session, op.promotion.leafId === undefined ? session.inferredLeafId : op.promotion.leafId).length;
      const candidates = searchMemories(memory, op.query, { includeDemoted: true, limit: 3 })
        .filter((candidate) => !candidate.protected && candidate.state !== "superseded");
      const promotionEvents: MemoryEvent[] = [];
      for (const candidate of candidates) {
        const input = { action: candidate.state === "demoted" ? "promote" as const : "touch" as const,
          memoryId: candidate.memoryId, timestamp: new Date().toISOString(), turn,
          sourceRef: `history-recall:${op.promotion.toolCallId}`, reason: `history_recall matched query ${op.query}` };
        // Ensure each returned event is small before writing. Existing append uses
        // its own cross-process lock; all reread/expansion stays in this child.
        if (!boundedHistoryValue(createMemoryEvent(memory.events, input))) return finish(historyRefusal("history-promotion-unavailable"));
        await checkSidecar();
        const updated = await appendMemoryEvent(path, input, { maxReadBytes: 256 * 1024 });
        const event = updated.events[updated.events.length - 1]!;
        if (!boundedHistoryValue(event)) return finish(historyRefusal("history-promotion-unavailable"));
        promotionEvents.push(event);
      }
      response = { ...response, details: { ...response.details, promotedMemories: promotionEvents.length }, promotionEvents };
    } else if (op.kind === "recall") {
      response = { ...response, details: { ...response.details, promotedMemories: 0 } };
    }
    return finish(response);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    // Do not expose source text, parser excerpts, paths, or child stack traces.
    return finish(historyRefusal(["history-source-changed", "history-source-too-large", "history-source-unsafe-type", "history-promotion-unavailable"].includes(code) ? code : "history-worker-failed"));
  }
}
