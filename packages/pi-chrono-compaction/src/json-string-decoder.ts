/** Serializable state for one JSON string after its opening quote.
 * The field names intentionally match the catalog parser v1 token checkpoint.
 */
export interface JsonStringDecoderState {
  escape: boolean;
  unicodeLeft: number;
  unicode: number;
  utfLeft: number;
  utfValue: number;
  utfMin: number;
}

export type JsonStringDecoderErrorCode =
  | "json-string-invalid-utf8"
  | "json-string-invalid-escape"
  | "json-string-invalid-string";

export interface JsonStringDecoderError {
  code: JsonStringDecoderErrorCode;
}

export type JsonStringUnitSink<Context> = (context: Context, unit: number) => void;

const INVALID_UTF8 = Object.freeze({ code: "json-string-invalid-utf8" } as const);
const INVALID_ESCAPE = Object.freeze({ code: "json-string-invalid-escape" } as const);
const INVALID_STRING = Object.freeze({ code: "json-string-invalid-string" } as const);

export function createJsonStringDecoderState(): JsonStringDecoderState {
  return { escape: false, unicodeLeft: 0, unicode: 0, utfLeft: 0, utfValue: 0, utfMin: 0 };
}

export function isJsonStringDecoderError(value: unknown): value is JsonStringDecoderError {
  if (!value || typeof value !== "object" || !("code" in value)) return false;
  const code = (value as { code?: unknown }).code;
  return code === INVALID_UTF8.code || code === INVALID_ESCAPE.code || code === INVALID_STRING.code;
}

/** Consume one byte from inside a quoted JSON string.
 * Returns true only for the unescaped closing quote. Escaped UTF-16 surrogate
 * halves are emitted unchanged; literal non-BMP UTF-8 emits a surrogate pair.
 * An invalid byte throws a stable JsonStringDecoderError and does not buffer it.
 */
export function decodeJsonStringByte<Context>(
  state: JsonStringDecoderState,
  byte: number,
  sink: JsonStringUnitSink<Context>,
  context: Context,
): boolean {
  if (state.utfLeft) {
    if (byte < 0x80 || byte > 0xbf) throw INVALID_UTF8;
    state.utfValue = state.utfValue * 64 + (byte & 63);
    if (--state.utfLeft === 0) {
      const codePoint = state.utfValue;
      if (codePoint < state.utfMin || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) throw INVALID_UTF8;
      if (codePoint > 0xffff) {
        sink(context, 0xd800 + ((codePoint - 0x10000) >>> 10));
        sink(context, 0xdc00 + ((codePoint - 0x10000) & 1023));
      } else {
        sink(context, codePoint);
      }
    }
    return false;
  }
  if (state.unicodeLeft) {
    const hex = byte >= 48 && byte <= 57 ? byte - 48
      : byte >= 65 && byte <= 70 ? byte - 55
      : byte >= 97 && byte <= 102 ? byte - 87 : -1;
    if (hex < 0) throw INVALID_ESCAPE;
    state.unicode = state.unicode * 16 + hex;
    if (--state.unicodeLeft === 0) sink(context, state.unicode);
    return false;
  }
  if (state.escape) {
    state.escape = false;
    if (byte === 117) {
      state.unicodeLeft = 4;
      state.unicode = 0;
      return false;
    }
    let unit = -1;
    if (byte === 34 || byte === 92 || byte === 47) unit = byte;
    else if (byte === 98) unit = 8;
    else if (byte === 102) unit = 12;
    else if (byte === 110) unit = 10;
    else if (byte === 114) unit = 13;
    else if (byte === 116) unit = 9;
    if (unit < 0) throw INVALID_ESCAPE;
    sink(context, unit);
    return false;
  }
  if (byte === 34) return true;
  if (byte === 92) {
    state.escape = true;
    return false;
  }
  if (byte < 32) throw INVALID_STRING;
  if (byte < 128) {
    sink(context, byte);
    return false;
  }
  if (byte >= 0xc2 && byte <= 0xdf) {
    state.utfLeft = 1;
    state.utfValue = byte & 31;
    state.utfMin = 0x80;
  } else if (byte >= 0xe0 && byte <= 0xef) {
    state.utfLeft = 2;
    state.utfValue = byte & 15;
    state.utfMin = 0x800;
  } else if (byte >= 0xf0 && byte <= 0xf4) {
    state.utfLeft = 3;
    state.utfValue = byte & 7;
    state.utfMin = 0x10000;
  } else {
    throw INVALID_UTF8;
  }
  return false;
}

export type QuotedJsonStringErrorCode = JsonStringDecoderErrorCode | "json-string-opening-quote-expected";
export interface QuotedJsonStringError { code: QuotedJsonStringErrorCode; byteOffset: number }
export interface QuotedJsonStringState {
  opened: boolean;
  done: boolean;
  rawBytes: number;
  decodedUnits: number;
  decoder: JsonStringDecoderState;
  error?: QuotedJsonStringError;
}
export interface QuotedJsonStringResult {
  state: QuotedJsonStringState;
  consumedBytes: number;
  error?: QuotedJsonStringError;
}

export function createQuotedJsonStringState(): QuotedJsonStringState {
  return { opened: false, done: false, rawBytes: 0, decodedUnits: 0, decoder: createJsonStringDecoderState() };
}

interface DriverSinkContext<Context> {
  state: QuotedJsonStringState;
  sink?: JsonStringUnitSink<Context>;
  context: Context;
}
function driverSink<Context>(driver: DriverSinkContext<Context>, unit: number): void {
  if (driver.state.decodedUnits === Number.MAX_SAFE_INTEGER) throw new Error("json-string-coordinate-overflow");
  driver.state.decodedUnits++;
  driver.sink?.(driver.context, unit);
}

/** Bounded driver for one complete quoted JSON string. It stops at its closing
 * quote and leaves any suffix unconsumed. State can be JSON-serialized between
 * calls; decoded code units are delivered only to the caller's sink.
 */
export function decodeQuotedJsonStringChunk<Context = undefined>(
  state: QuotedJsonStringState,
  input: Uint8Array,
  sink?: JsonStringUnitSink<Context>,
  context?: Context,
): QuotedJsonStringResult {
  let consumedBytes = 0;
  if (state.error || state.done) return { state, consumedBytes, ...(state.error ? { error: state.error } : {}) };
  const driver: DriverSinkContext<Context> = { state, sink, context: context as Context };
  while (consumedBytes < input.length && !state.done) {
    const byte = input[consumedBytes]!;
    if (!state.opened) {
      if (byte !== 34) {
        state.error = { code: "json-string-opening-quote-expected", byteOffset: state.rawBytes };
        break;
      }
      state.opened = true;
    } else {
      try {
        state.done = decodeJsonStringByte(state.decoder, byte, driverSink, driver);
      } catch (error) {
        if (!isJsonStringDecoderError(error)) throw error;
        state.error = { code: error.code, byteOffset: state.rawBytes };
        break;
      }
    }
    consumedBytes++;
    state.rawBytes++;
  }
  return { state, consumedBytes, ...(state.error ? { error: state.error } : {}) };
}
