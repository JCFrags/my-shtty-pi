import { createHash } from "node:crypto";
import type { StateAnchorHost, SessionEntryView, OwnedObjectStore, ImportReceiptInput } from "@context-kit/state-store";
import { restoreStateCheckpoint, STATE_CHECKPOINT_ENTRY } from "@grounded/pi-core/state-transfer";
import { requireExactObject, stableJson, StateToolError } from "@grounded/pi-core/state";
import { isLegacyTodoEntry } from "./legacy.ts";
import type { TodoOwnerMetadata } from "./store.ts";
import { validateTodoState } from "./operations.ts";
import type { TaskState } from "@grounded/pi-core/tasks";

/** Fresh transfer bootstrap only. Never replay ordinary legacy tool history here. */
export function findTodoBootstrap(host: StateAnchorHost): { state: TaskState; owner?: TodoOwnerMetadata; entries: SessionEntryView[]; scannedEntries: number } | undefined {
  const manager = host.sessionManager;
  let entryId = manager.getLeafId();
  let checkpoint: SessionEntryView | undefined, binding: SessionEntryView | undefined;
  const visited = new Set<string>();
  for (let scanned = 0; entryId !== null && scanned < 32; scanned++) {
    if (visited.has(entryId)) throw new StateToolError("STATE_CORRUPT", "Cyclic Todo bootstrap ancestry");
    visited.add(entryId);
    const entry = manager.getEntry(entryId);
    if (!entry || entry.id !== entryId) throw new StateToolError("STATE_CORRUPT", "Missing Todo bootstrap entry");
    if (entry.type === "custom" && entry.customType === "context-kit:owner-binding:v1") {
      const data = entry.data as { provider?: string } | undefined;
      if (data?.provider === "todo") {
        if (binding) throw new StateToolError("STATE_CORRUPT", "Duplicate Todo owner binding");
        binding = entry;
      }
    }
    if (isLegacyTodoEntry(entry)) {
      if (entry.type !== "custom" || entry.customType !== STATE_CHECKPOINT_ENTRY) return undefined;
      if (checkpoint) throw new StateToolError("STATE_CORRUPT", "Duplicate Todo checkpoint");
      checkpoint = entry;
    }
    entryId = entry.parentId;
  }
  if (entryId !== null || !checkpoint) return undefined;
  const state = restoreStateCheckpoint(checkpoint, "todo", validateTodoState);
  if (!state) throw new StateToolError("STATE_CORRUPT", "Invalid Todo bootstrap checkpoint");
  if (!binding) return { state, entries: [checkpoint], scannedEntries: visited.size };
  requireExactObject(binding.data, ["version", "provider", "sourceSessionId", "sourceLeafId", "binding"], [], "owner binding", "STATE_CORRUPT");
  const source = checkpoint.data as { sourceSessionId: string; sourceLeafId: string | null };
  if (binding.data.version !== 1 || binding.data.provider !== "todo" || binding.data.sourceSessionId !== source.sourceSessionId || binding.data.sourceLeafId !== source.sourceLeafId) {
    throw new StateToolError("STATE_CORRUPT", "Todo owner binding source does not match its checkpoint");
  }
  if (!binding.data.binding || typeof binding.data.binding !== "object" || Array.isArray(binding.data.binding)) {
    throw new StateToolError("STATE_CORRUPT", "Invalid Todo owner binding metadata");
  }
  return { state, owner: binding.data.binding as TodoOwnerMetadata, entries: [checkpoint, binding], scannedEntries: visited.size };
}

export async function todoBootstrapReceipt(host: StateAnchorHost, bootstrap: NonNullable<ReturnType<typeof findTodoBootstrap>>, objects: OwnedObjectStore, signal?: AbortSignal): Promise<ImportReceiptInput> {
  const source = { sessionId: host.sessionManager.getSessionId(), leafId: host.sessionManager.getLeafId() };
  const evidence = await objects.publish({ version: 1, source, sourceFile: host.sessionManager.getSessionFile() ?? null,
    digestKind: "normalized-native-checkpoint/v1", entries: bootstrap.entries,
  }, { maxBytes: 9 * 1024 * 1024, signal });
  return { importer: "context-kit-todo-bootstrap/1", source, coverage: { complete: true,
    scannedEntries: bootstrap.scannedEntries, providerEntries: 1,
    sourceDigest: createHash("sha256").update(stableJson(bootstrap.entries)).digest("hex"),
  }, evidence };
}
