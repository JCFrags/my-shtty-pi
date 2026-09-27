import { createHash } from "node:crypto";
import type { StateAnchorHost, SessionEntryView, OwnedObjectStore, ImportReceiptInput } from "@context-kit/state-store";
import { restoreStateCheckpoint, STATE_CHECKPOINT_ENTRY } from "@grounded/pi-core/state-transfer";
import { requireExactObject, stableJson, StateToolError } from "@grounded/pi-core/state";
import { isLegacyNotesEntry } from "./legacy.ts";
import type { NotesOwnerMetadata } from "./store.ts";
import { validateNotesState } from "./operations.ts";
import type { NotesState } from "@grounded/pi-core/notes";

/** Fresh transfer bootstrap only. Never replay ordinary legacy tool history here. */
export function findNotesBootstrap(host: StateAnchorHost): { state: NotesState; owner?: NotesOwnerMetadata; entries: SessionEntryView[]; scannedEntries: number } | undefined {
  const manager = host.sessionManager;
  let entryId = manager.getLeafId();
  let checkpoint: SessionEntryView | undefined, binding: SessionEntryView | undefined;
  const visited = new Set<string>();
  for (let scanned = 0; entryId !== null && scanned < 32; scanned++) {
    if (visited.has(entryId)) throw new StateToolError("STATE_CORRUPT", "Cyclic Notes bootstrap ancestry");
    visited.add(entryId);
    const entry = manager.getEntry(entryId);
    if (!entry || entry.id !== entryId) throw new StateToolError("STATE_CORRUPT", "Missing Notes bootstrap entry");
    if (entry.type === "custom" && entry.customType === "context-kit:owner-binding:v1") {
      const data = entry.data as { provider?: string } | undefined;
      if (data?.provider === "notes") {
        if (binding) throw new StateToolError("STATE_CORRUPT", "Duplicate Notes owner binding");
        binding = entry;
      }
    }
    if (isLegacyNotesEntry(entry)) {
      if (entry.type !== "custom" || entry.customType !== STATE_CHECKPOINT_ENTRY) return undefined;
      if (checkpoint) throw new StateToolError("STATE_CORRUPT", "Duplicate Notes checkpoint");
      checkpoint = entry;
    }
    entryId = entry.parentId;
  }
  if (entryId !== null || !checkpoint) return undefined;
  const state = restoreStateCheckpoint(checkpoint, "notes", validateNotesState);
  if (!state) throw new StateToolError("STATE_CORRUPT", "Invalid Notes bootstrap checkpoint");
  if (!binding) return { state, entries: [checkpoint], scannedEntries: visited.size };
  requireExactObject(binding.data, ["version", "provider", "sourceSessionId", "sourceLeafId", "binding"], [], "owner binding", "STATE_CORRUPT");
  const source = checkpoint.data as { sourceSessionId: string; sourceLeafId: string | null };
  if (binding.data.version !== 1 || binding.data.provider !== "notes" || binding.data.sourceSessionId !== source.sourceSessionId || binding.data.sourceLeafId !== source.sourceLeafId) {
    throw new StateToolError("STATE_CORRUPT", "Notes owner binding source does not match its checkpoint");
  }
  if (!binding.data.binding || typeof binding.data.binding !== "object" || Array.isArray(binding.data.binding)) {
    throw new StateToolError("STATE_CORRUPT", "Invalid Notes owner binding metadata");
  }
  return { state, owner: binding.data.binding as NotesOwnerMetadata, entries: [checkpoint, binding], scannedEntries: visited.size };
}

export async function notesBootstrapReceipt(host: StateAnchorHost, bootstrap: NonNullable<ReturnType<typeof findNotesBootstrap>>, objects: OwnedObjectStore, signal?: AbortSignal): Promise<ImportReceiptInput> {
  const source = { sessionId: host.sessionManager.getSessionId(), leafId: host.sessionManager.getLeafId() };
  const evidence = await objects.publish({ version: 1, source, sourceFile: host.sessionManager.getSessionFile() ?? null,
    digestKind: "normalized-native-checkpoint/v1", entries: bootstrap.entries,
  }, { maxBytes: 9 * 1024 * 1024, signal });
  return { importer: "context-kit-notes-bootstrap/1", source, coverage: { complete: true,
    scannedEntries: bootstrap.scannedEntries, providerEntries: 1,
    sourceDigest: createHash("sha256").update(stableJson(bootstrap.entries)).digest("hex"),
  }, evidence };
}
