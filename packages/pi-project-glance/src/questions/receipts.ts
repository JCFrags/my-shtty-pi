import { closeSync, fsyncSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { dirname } from "node:path";
import { QUESTION_ANSWER_MESSAGE_TYPE, QUESTION_ENTRY_TYPE } from "./model.js";
import { digest, record } from "./wire.js";

/** Flush the SDK-owned current session file and its directory after an append.
 * The directory flush also makes a newly created session name durable. This remains
 * a storage boundary, not an exactly-once model-processing guarantee. */
export function fsyncCurrentSessionFile(path: string | undefined): void {
  if (!path) throw new Error("Question persistence requires a saved session.");
  const file = openSync(path, "r");
  try { fsyncSync(file); } finally { closeSync(file); }
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export interface ReceiptSelection {
  entryIds?: ReadonlySet<string>;
  messageEntryIds?: ReadonlySet<string>;
}

export interface DiskReceipts {
  entries: Map<string, string>;
  messages: Map<string, { deliveryId: string; payloadDigest: string; contentDigest: string; detailsDigest: string }>;
}
/** Read only this runtime's current file. Never open a second SessionManager or repair JSONL.
 * Reads in fixed chunks with a 2 MiB line bound. The file itself is not capped:
 * large current sessions must not permanently trap a question. Optional selection
 * keeps retained receipt state bounded to active-branch entries.
 * This confirms readable bytes, not fsync or exactly-once model processing.
 */
export function readCurrentReceipts(path: string | undefined, sessionId: string, selection: ReceiptSelection = {}): DiskReceipts {
  if (!path) throw new Error("Question persistence requires a saved session.");
  const fd = openSync(path, "r");
  const result: DiskReceipts = { entries: new Map(), messages: new Map() };
  try {
    const size = fstatSync(fd).size;
    if (size === 0) throw new Error("Empty session receipt.");
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let read = 0;
    let header = false;
    let skippingOversizedLine = false;
    const line = (source: string): void => {
      if (!source.trim()) return;
      if (Buffer.byteLength(source) > 2 * 1024 * 1024) {
        if (!header) throw new Error("Session receipt header line limit.");
        return;
      }
      const entry: unknown = JSON.parse(source);
      if (!record(entry)) throw new Error("Invalid session receipt.");
      if (!header) {
        if (entry.type !== "session" || entry.id !== sessionId) throw new Error("Session receipt identity mismatch.");
        header = true;
        return;
      }
      if (typeof entry.id !== "string") return;
      if (entry.type === "custom" && entry.customType === QUESTION_ENTRY_TYPE && (!selection.entryIds || selection.entryIds.has(entry.id))) result.entries.set(entry.id, digest(entry.data));
      if (entry.type === "custom_message" && entry.customType === QUESTION_ANSWER_MESSAGE_TYPE && (!selection.messageEntryIds || selection.messageEntryIds.has(entry.id)) && record(entry.details) && typeof entry.details.deliveryId === "string" && typeof entry.details.payloadDigest === "string") {
        result.messages.set(entry.id, { deliveryId: entry.details.deliveryId, payloadDigest: entry.details.payloadDigest, contentDigest: digest(entry.content), detailsDigest: digest(entry.details) });
      }
    };
    while (read < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - read), null);
      if (!count) throw new Error("Session receipt changed during read.");
      read += count;
      let chunk = decoder.write(buffer.subarray(0, count));
      if (skippingOversizedLine) {
        const newline = chunk.indexOf("\n");
        if (newline === -1) continue;
        chunk = chunk.slice(newline + 1);
        skippingOversizedLine = false;
      }
      pending += chunk;
      let index: number;
      while ((index = pending.indexOf("\n")) !== -1) {
        line(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
      if (Buffer.byteLength(pending) > 2 * 1024 * 1024) {
        if (!header) throw new Error("Session receipt header line limit.");
        pending = "";
        skippingOversizedLine = true;
      }
    }
    pending += decoder.end();
    if (skippingOversizedLine || pending.trim()) throw new Error("Incomplete session receipt line.");
    if (!header) throw new Error("Missing session receipt header.");
    return result;
  } finally { closeSync(fd); }
}
