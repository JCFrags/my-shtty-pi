import * as fs from "node:fs/promises";

export interface PrefixReadResult {
  bytes: Buffer;
  bytesRead: number;
  truncated: boolean;
}

export async function readFilePrefix(absolutePath: string, maxBytes: number): Promise<PrefixReadResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError(`Invalid byte limit: ${maxBytes}`);
  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let totalRead = 0;
    while (totalRead < buffer.length) {
      const { bytesRead } = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    return {
      bytes: buffer.subarray(0, Math.min(totalRead, maxBytes)),
      bytesRead: Math.min(totalRead, maxBytes),
      truncated: totalRead > maxBytes,
    };
  } finally {
    await handle.close();
  }
}

function expectedUtf8SequenceLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

function isValidUtf8Prefix(bytes: Uint8Array, leadIndex: number, expectedLength: number): boolean {
  const lead = bytes[leadIndex];
  if (lead === undefined) return false;
  for (let index = leadIndex + 1; index < bytes.length; index += 1) {
    const continuation = bytes[index];
    if (continuation === undefined || continuation < 0x80 || continuation > 0xbf) return false;
  }
  const second = bytes[leadIndex + 1];
  if (second !== undefined) {
    if (lead === 0xe0 && second < 0xa0) return false;
    if (lead === 0xed && second > 0x9f) return false;
    if (lead === 0xf0 && second < 0x90) return false;
    if (lead === 0xf4 && second > 0x8f) return false;
  }
  return bytes.length - leadIndex < expectedLength;
}

/** Return only a valid, incomplete UTF-8 suffix length; never hide malformed bytes. */
function incompleteUtf8TailLength(buffer: Uint8Array): number {
  if (buffer.length === 0) return 0;
  let leadIndex = buffer.length - 1;
  while (leadIndex >= 0) {
    const byte = buffer[leadIndex];
    if (byte === undefined || byte < 0x80 || byte > 0xbf) break;
    leadIndex -= 1;
  }
  if (leadIndex < 0) return 0;
  const lead = buffer[leadIndex];
  if (lead === undefined) return 0;
  const expectedLength = expectedUtf8SequenceLength(lead);
  if (expectedLength === 0 || !isValidUtf8Prefix(buffer, leadIndex, expectedLength)) return 0;
  return buffer.length - leadIndex;
}

export function decodeUtf8(buffer: Uint8Array, options: { allowTrimmedTail?: boolean } = {}): {
  text: string;
  invalid: boolean;
  bytesConsumed: number;
} {
  const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    return { text: fatalDecoder.decode(buffer), invalid: false, bytesConsumed: buffer.byteLength };
  } catch {
    if (options.allowTrimmedTail) {
      const trim = incompleteUtf8TailLength(buffer);
      if (trim > 0) {
        const slice = buffer.subarray(0, buffer.byteLength - trim);
        try {
          return { text: fatalDecoder.decode(slice), invalid: false, bytesConsumed: slice.byteLength };
        } catch {
          // A malformed sequence exists before the incomplete tail.
        }
      }
    }
    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
    return { text: decoder.decode(buffer), invalid: true, bytesConsumed: buffer.byteLength };
  }
}
