import { CATALOG_TEXT_HASH, catalogHashUnit, createCatalogHash, finishCatalogHash, type CatalogHashState } from "./catalog-parser-hash.js";
import { decodeJsonStringByte, isJsonStringDecoderError, type JsonStringDecoderState } from "./json-string-decoder.js";

export const CATALOG_PARSER_VERSION = 1;
export const CATALOG_PARSER_LIMITS = Object.freeze({ depth: 64, metadataUnits: 1024, blocks: 256, bodies: 512, recordsPerCall: 64,
  /** Conservative UTF-8 JSON size bound derived from the fixed structural caps,
   * including worst-case six-byte JSON escapes in every metadata code unit.
   * Emitted records have a separate per-call count cap; use maxRecords=1 for
   * tight worker heaps. No serialization/allocation is done to enforce this.
   */
  checkpointJsonBytesUpperBound: 5 * 1024 * 1024,
});
/** Structural provenance only, never a truth/approval/status judgment. Retrieval
 * call/result joins across records belong to the catalog engine, not this bounded
 * parser. Unknown record/block types remain recoverable by their raw ranges.
 */
export type CatalogProvenance = "original" | "generated" | "mixed";
export interface CatalogBodyMetadata {
  field: string;
  /** Absolute byte range including the JSON string's quotes, end exclusive. */
  rawStart: number; rawEnd: number;
  /** Decoded coordinates are UTF-16 code units within THIS string, not bytes or code points. */
  decodedStart: 0; decodedEnd: number;
  hashAlgorithm: typeof CATALOG_TEXT_HASH; hash: string;
}
export interface CatalogBlockMetadata {
  index: number; type?: string; id?: string; name?: string;
  rawStart: number; rawEnd: number;
  provenance: CatalogProvenance;
  bodies: CatalogBodyMetadata[];
}
export interface CatalogRecordMetadata {
  /** Includes leading/trailing JSON whitespace (and CR in CRLF), excludes LF. */
  rawStart: number; rawEnd: number;
  /** Byte immediately after the committing LF. No EOF commit. */
  endByte: number;
  type?: string; id?: string; parentId?: string | null; timestamp?: string | number;
  version?: number; cwd?: string; parentSession?: string;
  role?: string; toolCallId?: string; toolName?: string; customType?: string;
  firstKeptEntryId?: string; fromId?: string;
  messageTimestamp?: number | string; messageCustomType?: string;
  provenance: CatalogProvenance;
  blocks: CatalogBlockMetadata[]; bodies: CatalogBodyMetadata[];
}
export interface CatalogParserError { code: string; byteOffset: number }
type Context = "root" | "message" | "content" | "block" | "other";
type Phase = "keyOrEnd" | "key" | "colon" | "value" | "valueOrEnd" | "commaOrEnd";
interface Frame { kind: "object" | "array"; context: Context; phase: Phase; key: string; index: number; block: number; seen: string[] }
interface Target { context: Context; key: string; block: number }
interface Token extends JsonStringDecoderState {
  kind: "string" | "number" | "literal"; target: Target; key: boolean; start: number;
  capture: string; overflow: boolean; mode: "skip" | "key" | "metadata" | "body";
  numberPhase: string; literal: string; literalIndex: number;
  hash?: CatalogHashState;
}
/** Plain JSON checkpoint. Caller must persist state and returned records in one
 * transaction, and verify checkpoint integrity before restoring it. Do not edit
 * its internal fields. No input buffers or complete decoded bodies are retained.
 * Current hash carry contains at most 1023 decoded UTF-16 units: 2046
 * reconstructable byte values, PRIVATE CHECKPOINT DATA (see hash contract).
 * Persist state only in the private catalog DB checkpoint, never search/index,
 * log, or report the carry. Completion removes the token and its carry; an
 * incomplete tail necessarily keeps this bounded tail until resumed/discarded.
 * This is resumable parser state, not M05 semantic retention. Catalog shadow
 * activation must stay default-off pending project-lead storage/privacy review.
 * Upper bounds are fixed per record; too many blocks/bodies/depth or oversized
 * metadata returns an error rather than discarding identity. Unknown keys use
 * only a 32-unit matching prefix; unknown values still receive JSON validation.
 */
export interface CatalogParserState {
  version: 1; byteOffset: number; recordStart: number; frames: Frame[];
  token?: Token; record?: CatalogRecordMetadata; rootDone: boolean; bodyCount: number;
  error?: CatalogParserError;
}
export interface CatalogParserResult { state: CatalogParserState; consumedBytes: number; records: CatalogRecordMetadata[]; error?: CatalogParserError }
export function createCatalogParserState(startByte = 0): CatalogParserState {
  if (!Number.isSafeInteger(startByte) || startByte < 0) throw new Error("catalog-offset-invalid");
  return { version: 1, byteOffset: startByte, recordStart: startByte, frames: [], rootDone: false, bodyCount: 0 };
}
const rootStrings = new Set(["type", "id", "parentId", "timestamp", "cwd", "parentSession", "customType", "firstKeptEntryId", "fromId"]);
const messageStrings = new Set(["role", "toolCallId", "toolName", "customType", "timestamp"]);
const blockStrings = new Set(["type", "id", "name"]);
function metadata(t: Target): boolean {
  return t.context === "root" ? rootStrings.has(t.key) || t.key === "version"
    : t.context === "message" ? messageStrings.has(t.key) : t.context === "block" && blockStrings.has(t.key);
}
function body(t: Target): boolean {
  return ((t.context === "root" || t.context === "message") && ["content", "summary", "output"].includes(t.key))
    || (t.context === "block" && ["text", "thinking", "data"].includes(t.key)) || t.context === "content";
}
function fail(s: CatalogParserState, code: string): never { throw { code, byteOffset: s.byteOffset } satisfies CatalogParserError; }
function target(s: CatalogParserState): Target {
  const f = s.frames.at(-1);
  return f ? { context: f.context, key: f.kind === "array" ? String(f.index) : f.key, block: f.block } : { context: "other", key: "", block: -1 };
}
function completeValue(s: CatalogParserState): void {
  const f = s.frames.at(-1);
  if (f) {
    if (f.index === Number.MAX_SAFE_INTEGER) fail(s, "catalog-coordinate-overflow");
    f.phase = "commaOrEnd"; f.index++;
  } else s.rootDone = true;
}
function assign(s: CatalogParserState, t: Target, value: string | number | null): void {
  if (!metadata(t)) return;
  if (t.context === "block") {
    if (typeof value !== "string") fail(s, "catalog-metadata-type");
    Object.assign(s.record!.blocks[t.block]!, { [t.key]: value });
  } else {
    if (t.key === "version") { if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(s, "catalog-metadata-type"); }
    else if (t.key === "timestamp") { if (typeof value !== "string" && typeof value !== "number") fail(s, "catalog-metadata-type"); }
    else if (typeof value !== "string" && !(t.key === "parentId" && value === null)) fail(s, "catalog-metadata-type");
    const field = t.context === "message" && t.key === "timestamp" ? "messageTimestamp"
      : t.context === "message" && t.key === "customType" ? "messageCustomType" : t.key;
    Object.assign(s.record!, { [field]: value });
  }
}
function unit(s: CatalogParserState, t: Token, u: number): void {
  if (t.mode === "body") {
    if (t.hash!.units === Number.MAX_SAFE_INTEGER) fail(s, "catalog-coordinate-overflow");
    catalogHashUnit(t.hash!, u);
  } else if (t.mode === "metadata" || t.mode === "key") {
    const limit = t.mode === "key" ? 32 : CATALOG_PARSER_LIMITS.metadataUnits;
    if (t.capture.length < limit) t.capture += String.fromCharCode(u);
    else { t.overflow = true; if (t.mode === "metadata") fail(s, "catalog-metadata-limit"); }
  }
}
function finishString(s: CatalogParserState, t: Token): void {
  if (t.key) {
    const f = s.frames.at(-1)!;
    f.key = t.overflow ? "" : t.capture;
    // Reject duplicate structural fields. Unknown duplicate fields are valid
    // JSON and cannot alter the catalog. No lifetime-sized duplicate-key set.
    const relevant = metadata({ context: f.context, key: f.key, block: f.block })
      || (f.context === "root" && f.key === "message")
      || ((f.context === "root" || f.context === "message") && ["content", "summary", "output"].includes(f.key))
      || (f.context === "block" && ["text", "thinking", "data"].includes(f.key));
    if (relevant) {
      if (f.seen.includes(f.key)) fail(s, "catalog-duplicate-field");
      f.seen.push(f.key);
    }
    f.phase = "colon";
  } else {
    if (t.mode === "metadata") assign(s, t.target, t.capture);
    if (t.mode === "body") {
      if (++s.bodyCount > CATALOG_PARSER_LIMITS.bodies) fail(s, "catalog-body-limit");
      const descriptor: CatalogBodyMetadata = { field: t.target.key, rawStart: t.start, rawEnd: s.byteOffset + 1,
        decodedStart: 0, decodedEnd: t.hash!.units, hashAlgorithm: CATALOG_TEXT_HASH, hash: finishCatalogHash(t.hash!) };
      if (t.target.context === "block") s.record!.blocks[t.target.block]!.bodies.push(descriptor);
      else s.record!.bodies.push(descriptor);
    }
    completeValue(s);
  }
  delete s.token;
}
function parserStringUnit(s: CatalogParserState, u: number): void {
  unit(s, s.token!, u);
}
function numberByte(t: Token, b: number): boolean {
  const digit = b >= 48 && b <= 57;
  switch (t.numberPhase) {
    case "start": if (b === 45) t.numberPhase = "sign"; else if (b === 48) t.numberPhase = "zero"; else if (digit) t.numberPhase = "int"; else return false; break;
    case "sign": if (b === 48) t.numberPhase = "zero"; else if (b >= 49 && b <= 57) t.numberPhase = "int"; else return false; break;
    case "int": if (digit) break; if (b === 46) t.numberPhase = "dot"; else if (b === 101 || b === 69) t.numberPhase = "exp"; else return false; break;
    case "zero": if (b === 46) t.numberPhase = "dot"; else if (b === 101 || b === 69) t.numberPhase = "exp"; else return false; break;
    case "dot": if (digit) t.numberPhase = "frac"; else return false; break;
    case "frac": if (digit) break; if (b === 101 || b === 69) t.numberPhase = "exp"; else return false; break;
    case "exp": if (b === 43 || b === 45) t.numberPhase = "expSign"; else if (digit) t.numberPhase = "expDigits"; else return false; break;
    case "expSign": if (digit) t.numberPhase = "expDigits"; else return false; break;
    case "expDigits": if (!digit) return false; break;
  }
  return true;
}
function newToken(s: CatalogParserState, kind: Token["kind"], key = false): Token {
  const dest = target(s);
  const mode = key ? "key" : metadata(dest) ? "metadata" : kind === "string" && body(dest) ? "body" : "skip";
  const t: Token = { kind, target: dest, key, start: s.byteOffset, capture: "", overflow: false, mode,
    escape: false, unicodeLeft: 0, unicode: 0, utfLeft: 0, utfValue: 0, utfMin: 0,
    numberPhase: "start", literal: "", literalIndex: 0 };
  if (mode === "body") t.hash = createCatalogHash();
  s.token = t; return t;
}
function openContainer(s: CatalogParserState, b: number): void {
  if (s.frames.length >= CATALOG_PARSER_LIMITS.depth) fail(s, "catalog-depth-limit");
  const t = target(s);
  let context: Context = "other", block = -1;
  if (s.frames.length === 0) {
    if (b !== 123) fail(s, "catalog-record-not-object");
    context = "root";
    s.record = { rawStart: s.recordStart, rawEnd: 0, endByte: 0, provenance: "original", blocks: [], bodies: [] };
  } else {
    if (metadata(t)) fail(s, "catalog-metadata-type");
    if (t.context === "root" && t.key === "message" && b === 123) context = "message";
    if ((t.context === "root" || t.context === "message") && t.key === "content" && b === 91) context = "content";
    if (t.context === "content" && b === 123) {
      context = "block";
      if (s.record!.blocks.length >= CATALOG_PARSER_LIMITS.blocks) fail(s, "catalog-block-limit");
      block = s.record!.blocks.length;
      s.record!.blocks.push({ index: Number(t.key), rawStart: s.byteOffset, rawEnd: 0, provenance: "original", bodies: [] });
    }
  }
  s.frames.push({ kind: b === 123 ? "object" : "array", context, phase: b === 123 ? "keyOrEnd" : "valueOrEnd", key: "", index: 0, block, seen: [] });
}
function closeContainer(s: CatalogParserState): void {
  const f = s.frames.pop()!;
  if (f.context === "block") s.record!.blocks[f.block]!.rawEnd = s.byteOffset + 1;
  completeValue(s);
}
/** Exact registered retrieval names from pi-extension.ts, plus the explicit
 * history_read compatibility alias retained for archived sessions. Do not infer
 * provenance from payload text or a history_* prefix. Even exact retrieval is
 * a generated copy, not another independent original source. Its raw call and
 * result remain archived in chronology; assistant prose is classified separately.
 */
const retrieval = new Set(["history_get", "history_search", "history_recall", "history_range", "history_read", "history_status"]);
function classify(r: CatalogRecordMetadata): void {
  const generated = r.type === "compaction" || r.type === "branch_summary"
    || ((r.type === "custom" || r.type === "custom_message") && /^chrono(?:[-_:]|$)/.test(r.customType ?? ""))
    || (r.type === "message" && r.role === "custom" && /^chrono(?:[-_:]|$)/.test(r.messageCustomType ?? ""))
    || (r.type === "message" && r.role === "toolResult" && retrieval.has(r.toolName ?? ""));
  let originals = r.bodies.length > 0, derived = false;
  for (const b of r.blocks) {
    const g = generated || (r.type === "message" && r.role === "assistant" && b.type === "toolCall" && retrieval.has(b.name ?? ""));
    b.provenance = g ? "generated" : "original";
    if (g) derived = true; else originals = true;
  }
  r.provenance = generated ? "generated" : derived ? originals ? "mixed" : "generated" : "original";
}
/** Consume at most maxRecords (1..64) committed records. Stop exactly after the
 * last LF when the emission limit is reached; the driver must re-submit the
 * unconsumed input suffix. Errors are terminal for this checkpoint and include
 * prior completed records, so transaction policy remains with the engine.
 * The error byte is NOT consumed. No EOF operation: an incomplete append tail
 * remains resumable, including a complete object awaiting its LF.
 */
export function parseCatalogChunk(state: CatalogParserState, input: Uint8Array, maxRecords = 16): CatalogParserResult {
  const records: CatalogRecordMetadata[] = [];
  let consumedBytes = 0;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > CATALOG_PARSER_LIMITS.recordsPerCall) throw new Error("catalog-emission-limit-invalid");
  if (state.version !== CATALOG_PARSER_VERSION) throw new Error("catalog-checkpoint-version");
  if (state.error) return { state, consumedBytes, records, error: state.error };
  try {
    while (consumedBytes < input.length && records.length < maxRecords) {
      if (state.byteOffset >= Number.MAX_SAFE_INTEGER) fail(state, "catalog-coordinate-overflow");
      const b = input[consumedBytes]!;
      const t = state.token;
      if (t?.kind === "string") {
        if (decodeJsonStringByte(t, b, parserStringUnit, state)) finishString(state, t);
      }
      else if (t?.kind === "number" && numberByte(t, b)) {
        if (t.mode === "metadata") unit(state, t, b);
      } else if (t?.kind === "literal" && t.literalIndex < t.literal.length) {
        if (b !== t.literal.charCodeAt(t.literalIndex++)) fail(state, "catalog-invalid-literal");
      } else {
        if (t) {
          if (t.kind === "number") {
            if (!["zero", "int", "frac", "expDigits"].includes(t.numberPhase)) fail(state, "catalog-invalid-number");
            if (t.mode === "metadata") {
              const n = Number(t.capture); if (!Number.isFinite(n)) fail(state, "catalog-metadata-type"); assign(state, t.target, n);
            }
          } else if (t.mode === "metadata") {
            if (t.literal !== "null") fail(state, "catalog-metadata-type");
            assign(state, t.target, null);
          }
          delete state.token; completeValue(state);
        }
        if (b === 10) {
          if (!state.rootDone && (state.record || state.frames.length)) fail(state, "catalog-incomplete-record");
          if (state.rootDone) {
            const r = state.record!;
            if (typeof r.type !== "string" || !r.type) fail(state, "catalog-record-type-missing");
            r.rawEnd = state.byteOffset; r.endByte = state.byteOffset + 1; classify(r); records.push(r);
          }
          delete state.record; state.rootDone = false; state.bodyCount = 0; state.recordStart = state.byteOffset + 1;
        } else if (b === 32 || b === 9 || b === 13) { /* JSON whitespace */ }
        else if (state.rootDone) fail(state, "catalog-trailing-data");
        else {
          const f = state.frames.at(-1);
          if (f?.phase === "colon") {
            if (b !== 58) fail(state, "catalog-expected-colon"); f.phase = "value";
          } else if (f?.phase === "commaOrEnd") {
            if (b === (f.kind === "object" ? 125 : 93)) closeContainer(state);
            else if (b === 44) f.phase = f.kind === "object" ? "key" : "value";
            else fail(state, "catalog-expected-comma");
          } else if (f?.phase === "key" || f?.phase === "keyOrEnd") {
            if (b === 125 && f.phase === "keyOrEnd") closeContainer(state);
            else if (b === 34) newToken(state, "string", true);
            else fail(state, "catalog-expected-key");
          } else if (f?.phase === "valueOrEnd" && b === 93) closeContainer(state);
          else if (b === 123 || b === 91) openContainer(state, b);
          else if (!f) fail(state, "catalog-record-not-object");
          else if (b === 34) newToken(state, "string");
          else if (b === 45 || (b >= 48 && b <= 57)) {
            const n = newToken(state, "number"); numberByte(n, b); if (n.mode === "metadata") unit(state, n, b);
          } else if (b === 116 || b === 102 || b === 110) {
            const l = newToken(state, "literal"); l.literal = b === 116 ? "true" : b === 102 ? "false" : "null"; l.literalIndex = 1;
          } else fail(state, "catalog-invalid-value");
        }
      }
      consumedBytes++; state.byteOffset++;
    }
  } catch (e) {
    if (isJsonStringDecoderError(e)) {
      const code = e.code === "json-string-invalid-utf8" ? "catalog-invalid-utf8"
        : e.code === "json-string-invalid-escape" ? "catalog-invalid-escape" : "catalog-invalid-string";
      state.error = { code, byteOffset: state.byteOffset };
    } else {
      if (!e || typeof e !== "object" || !("code" in e) || !("byteOffset" in e)) throw e;
      state.error = e as CatalogParserError;
    }
  }
  return { state, consumedBytes, records, ...(state.error ? { error: state.error } : {}) };
}
