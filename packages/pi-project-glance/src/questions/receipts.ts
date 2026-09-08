import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { QUESTION_ANSWER_MESSAGE_TYPE, QUESTION_ENTRY_TYPE } from "./model.js";
import { digest, record } from "./wire.js";

export interface DiskReceipts {
  entries: Map<string, string>;
  messages: Map<string, { deliveryId: string; payloadDigest: string; contentDigest: string; detailsDigest: string }>;
}
/** Read only this runtime's current file. Never open a second SessionManager or repair JSONL.
 * Bounds: 64 MiB/file and 2 MiB/line. Only hashes of own entries survive the scan.
 * This confirms readable bytes, not fsync or exactly-once model processing.
 */
export function readCurrentReceipts(path: string | undefined, sessionId: string): DiskReceipts {
  if (!path) throw new Error("Question persistence requires a saved session.");
  const fd = openSync(path, "r");
  const result: DiskReceipts = { entries: new Map(), messages: new Map() };
  try {
    const size = fstatSync(fd).size;
    if (size === 0 || size > 64 * 1024 * 1024) throw new Error("Session receipt size limit.");
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let read = 0;
    let header = false;
    const line = (source: string): void => {
      if (!source.trim()) return;
      if (Buffer.byteLength(source) > 2 * 1024 * 1024) throw new Error("Session receipt line limit.");
      const entry: unknown = JSON.parse(source);
      if (!record(entry)) throw new Error("Invalid session receipt.");
      if (!header) {
        if (entry.type !== "session" || entry.id !== sessionId) throw new Error("Session receipt identity mismatch.");
        header = true;
        return;
      }
      if (typeof entry.id !== "string") return;
      if (entry.type === "custom" && entry.customType === QUESTION_ENTRY_TYPE) result.entries.set(entry.id, digest(entry.data));
      if (entry.type === "custom_message" && entry.customType === QUESTION_ANSWER_MESSAGE_TYPE && record(entry.details) && typeof entry.details.deliveryId === "string" && typeof entry.details.payloadDigest === "string") {
        result.messages.set(entry.id, { deliveryId: entry.details.deliveryId, payloadDigest: entry.details.payloadDigest, contentDigest: digest(entry.content), detailsDigest: digest(entry.details) });
      }
    };
    while (read < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - read), null);
      if (!count) throw new Error("Session receipt changed during read.");
      read += count;
      pending += decoder.write(buffer.subarray(0, count));
      let index: number;
      while ((index = pending.indexOf("\n")) !== -1) {
        line(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
      if (Buffer.byteLength(pending) > 2 * 1024 * 1024) throw new Error("Session receipt line limit.");
    }
    pending += decoder.end();
    if (pending.trim()) throw new Error("Incomplete session receipt line.");
    if (!header) throw new Error("Missing session receipt header.");
    return result;
  } finally { closeSync(fd); }
}
