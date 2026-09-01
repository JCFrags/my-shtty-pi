export const PROTOCOL_VERSION = 2;
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
export const MAX_HELPER_BYTES = 64 * 1024;
export const MAX_STDERR_BYTES = 8 * 1024;

export class RemoteFailure extends Error {
  constructor(code, message, options = {}) {
    super(`${code}: ${message}`);
    this.name = "RemoteFailure";
    this.code = code;
    this.safeMessage = message;
    this.retryable = options.retryable === true;
    this.recommendedAction = options.recommendedAction ?? "none";
    this.routeAffecting = options.routeAffecting === true;
  }
}

export function fail(code, message, options) {
  return new RemoteFailure(code, message, options);
}

class StrictJsonParser {
  constructor(text) {
    this.text = text;
    this.i = 0;
    this.depth = 0;
  }
  parse() {
    const value = this.value();
    this.ws();
    if (this.i !== this.text.length) throw fail("PROTOCOL_ERROR", "Trailing bytes follow the JSON value", { routeAffecting: true });
    return value;
  }
  ws() { while (/[\x20\t\r\n]/.test(this.text[this.i] ?? "")) this.i++; }
  value() {
    this.ws();
    if (++this.depth > 20) throw fail("PROTOCOL_ERROR", "JSON nesting is too deep", { routeAffecting: true });
    try {
      const ch = this.text[this.i];
      if (ch === "{") return this.object();
      if (ch === "[") return this.array();
      if (ch === '"') return this.string();
      if (ch === "t" && this.text.slice(this.i, this.i + 4) === "true") { this.i += 4; return true; }
      if (ch === "f" && this.text.slice(this.i, this.i + 5) === "false") { this.i += 5; return false; }
      if (ch === "n" && this.text.slice(this.i, this.i + 4) === "null") { this.i += 4; return null; }
      return this.number();
    } finally { this.depth--; }
  }
  object() {
    this.i++;
    const out = Object.create(null);
    const seen = new Set();
    this.ws();
    if (this.text[this.i] === "}") { this.i++; return out; }
    while (true) {
      this.ws();
      if (this.text[this.i] !== '"') throw fail("PROTOCOL_ERROR", "Object key is not a JSON string", { routeAffecting: true });
      const key = this.string();
      if (seen.has(key)) throw fail("PROTOCOL_ERROR", `Duplicate JSON field: ${key}`, { routeAffecting: true });
      if (seen.size >= 64) throw fail("PROTOCOL_ERROR", "JSON object has too many fields", { routeAffecting: true });
      seen.add(key);
      this.ws();
      if (this.text[this.i++] !== ":") throw fail("PROTOCOL_ERROR", "Object field has no colon", { routeAffecting: true });
      out[key] = this.value();
      this.ws();
      const ch = this.text[this.i++];
      if (ch === "}") return out;
      if (ch !== ",") throw fail("PROTOCOL_ERROR", "Object field separator is invalid", { routeAffecting: true });
    }
  }
  array() {
    this.i++;
    const out = [];
    this.ws();
    if (this.text[this.i] === "]") { this.i++; return out; }
    while (true) {
      if (out.length >= 10000) throw fail("PROTOCOL_ERROR", "JSON array is too long", { routeAffecting: true });
      out.push(this.value());
      this.ws();
      const ch = this.text[this.i++];
      if (ch === "]") return out;
      if (ch !== ",") throw fail("PROTOCOL_ERROR", "Array separator is invalid", { routeAffecting: true });
    }
  }
  string() {
    const start = this.i++;
    let escaped = false;
    while (this.i < this.text.length) {
      const code = this.text.charCodeAt(this.i);
      const ch = this.text[this.i++];
      if (!escaped && ch === '"') {
        const token = this.text.slice(start, this.i);
        try { return JSON.parse(token); } catch { throw fail("PROTOCOL_ERROR", "JSON string escape is invalid", { routeAffecting: true }); }
      }
      if (!escaped && code < 0x20) throw fail("PROTOCOL_ERROR", "JSON string contains a control character", { routeAffecting: true });
      if (!escaped && ch === "\\") escaped = true; else escaped = false;
    }
    throw fail("PROTOCOL_ERROR", "JSON string is unterminated", { routeAffecting: true });
  }
  number() {
    const match = this.text.slice(this.i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) throw fail("PROTOCOL_ERROR", "JSON value is invalid", { routeAffecting: true });
    this.i += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw fail("PROTOCOL_ERROR", "JSON number is not finite", { routeAffecting: true });
    return value;
  }
}

export function strictJsonParse(bytes, maximum = MAX_RESPONSE_BYTES) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > maximum) throw fail("REMOTE_OUTPUT_LIMIT", "Protocol JSON exceeds its byte limit", { routeAffecting: true });
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw fail("PROTOCOL_ERROR", "Protocol JSON is not valid UTF-8", { routeAffecting: true }); }
  return new StrictJsonParser(text).parse();
}

export function encodeFrame(value, maximum = MAX_REQUEST_BYTES) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > maximum) throw fail("REMOTE_OUTPUT_LIMIT", "Protocol request exceeds its byte limit");
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function decodeSingleFrame(bytes, maximum = MAX_RESPONSE_BYTES) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length < 4) throw fail("PROTOCOL_ERROR", "Protocol frame header is incomplete", { routeAffecting: true });
  const length = bytes.readUInt32BE(0);
  if (length > maximum) throw fail("REMOTE_OUTPUT_LIMIT", "Protocol frame declares excessive output", { routeAffecting: true });
  if (bytes.length !== length + 4) {
    throw fail("PROTOCOL_ERROR", bytes.length < length + 4 ? "Protocol frame is truncated" : "Trailing bytes follow the protocol frame", { routeAffecting: true });
  }
  return strictJsonParse(bytes.subarray(4), maximum);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("PROTOCOL_ERROR", `${label} is not an object`, { routeAffecting: true });
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw fail("PROTOCOL_ERROR", `${label} fields are invalid`, { routeAffecting: true });
  }
}

function safeInteger(value, low, high, label) {
  if (!Number.isSafeInteger(value) || value < low || value > high) throw fail("PROTOCOL_ERROR", `${label} is invalid`, { routeAffecting: true });
}
function safeText(value, maximum, label, allowNul = false) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximum || (!allowNul && value.includes("\0"))) throw fail("PROTOCOL_ERROR", `${label} is invalid`, { routeAffecting: true });
}
function validateTruncation(value) {
  exactKeys(value, ["truncated", "truncatedBy", "totalLines", "totalBytes", "outputLines", "outputBytes", "lastLinePartial", "firstLineExceedsLimit", "maxLines", "maxBytes"], "Truncation");
  if (typeof value.truncated !== "boolean" || ![null, "lines", "bytes"].includes(value.truncatedBy) || typeof value.lastLinePartial !== "boolean" || typeof value.firstLineExceedsLimit !== "boolean") throw fail("PROTOCOL_ERROR", "Truncation flags are invalid", { routeAffecting: true });
  for (const key of ["totalLines", "totalBytes", "outputLines", "outputBytes"]) safeInteger(value[key], 0, 2 ** 31 - 1, `Truncation ${key}`);
  safeInteger(value.maxLines, 1, 2 ** 31 - 1, "Truncation maxLines");
  safeInteger(value.maxBytes, 1, MAX_RESPONSE_BYTES, "Truncation maxBytes");
  return value;
}
function validateResult(result, operation) {
  if (operation === "capabilities") return validateCapabilities(result);
  if (operation === "read") {
    if (result?.kind === "image") {
      exactKeys(result, ["kind", "mimeType", "data"], "Read image result");
      if (!["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"].includes(result.mimeType)) throw fail("PROTOCOL_ERROR", "Remote image MIME type is invalid", { routeAffecting: true });
      safeText(result.data, 45 * 1024 * 1024, "Read image data");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(result.data) || result.data.length % 4 !== 0) throw fail("PROTOCOL_ERROR", "Remote image base64 is invalid", { routeAffecting: true });
      return result;
    }
    exactKeys(result, ["kind", "data", "truncation", "totalFileLines", "startLine", "userLimitedLines", "hasMoreAfterUserLimit"], "Read text result");
    if (result.kind !== "text") throw fail("PROTOCOL_ERROR", "Read result kind is invalid", { routeAffecting: true });
    safeText(result.data, 60 * 1024, "Read data", true); validateTruncation(result.truncation);
    safeInteger(result.totalFileLines, 1, 2 ** 31 - 1, "Total file lines"); safeInteger(result.startLine, 1, 2 ** 31 - 1, "Start line");
    if (result.userLimitedLines !== null) safeInteger(result.userLimitedLines, 0, 2 ** 31 - 1, "User limited lines");
    if (typeof result.hasMoreAfterUserLimit !== "boolean") throw fail("PROTOCOL_ERROR", "Read continuation flag is invalid", { routeAffecting: true });
    return result;
  }
  if (operation === "access" || operation === "mkdir") {
    exactKeys(result, ["ok"], `${operation} result`);
    if (result.ok !== true) throw fail("PROTOCOL_ERROR", `${operation} result is invalid`, { routeAffecting: true });
    return result;
  }
  if (operation === "readRaw") {
    exactKeys(result, ["data", "bytes"], "Raw read result");
    safeText(result.data, 12 * 1024 * 1024, "Raw read data");
    safeInteger(result.bytes, 0, 8 * 1024 * 1024, "Raw read bytes");
    return result;
  }
  if (operation === "write") {
    exactKeys(result, ["bytes", "rollbackAvailable", "created"], "Write result");
    safeInteger(result.bytes, 0, 8 * 1024 * 1024, "Write bytes");
    if (result.rollbackAvailable !== true || typeof result.created !== "boolean") throw fail("PROTOCOL_ERROR", "Write flags are invalid", { routeAffecting: true });
    return result;
  }
  if (operation === "rollback") {
    exactKeys(result, ["action"], "Rollback result");
    if (!["restored", "removed-created-file"].includes(result.action)) throw fail("PROTOCOL_ERROR", "Rollback action is invalid", { routeAffecting: true });
    return result;
  }
  if (operation === "exec") {
    exactKeys(result, ["stdout", "stderr", "exitCode", "timedOut"], "Exec result");
    safeText(result.stdout, 100 * 1024, "Exec stdout"); safeText(result.stderr, 100 * 1024, "Exec stderr");
    safeInteger(result.exitCode, -255, 255, "Exec exit code");
    if (typeof result.timedOut !== "boolean") throw fail("PROTOCOL_ERROR", "Exec timeout flag is invalid", { routeAffecting: true });
    return result;
  }
  if (operation === "ls" || operation === "find") {
    exactKeys(result, ["data", "empty", "limitReached", "truncation"], operation === "ls" ? "List result" : "Find result");
    safeText(result.data, 60 * 1024, `${operation} data`);
    if (typeof result.empty !== "boolean" || typeof result.limitReached !== "boolean") throw fail("PROTOCOL_ERROR", `${operation} result flags are invalid`, { routeAffecting: true });
    if (result.truncation !== null) validateTruncation(result.truncation);
    return result;
  }
  if (operation === "grep") {
    exactKeys(result, ["data", "truncation", "matchLimitReached", "linesTruncated"], "Grep result");
    safeText(result.data, 60 * 1024, "Grep data");
    if (result.truncation !== null) validateTruncation(result.truncation);
    if (typeof result.matchLimitReached !== "boolean" || typeof result.linesTruncated !== "boolean") throw fail("PROTOCOL_ERROR", "Grep result flags are invalid", { routeAffecting: true });
    return result;
  }
  throw fail("PROTOCOL_ERROR", "Response operation is invalid", { routeAffecting: true });
}

export function validateResponse(value, requestId, operation) {
  exactKeys(value, value?.ok === true ? ["version", "id", "ok", "result"] : ["version", "id", "ok", "error"], "Response");
  if (value.version !== PROTOCOL_VERSION) throw fail("REMOTE_UNSUPPORTED", "Remote helper protocol version is unsupported", { routeAffecting: true });
  if (value.ok !== true && value.ok !== false) throw fail("PROTOCOL_ERROR", "Response status is invalid", { routeAffecting: true });
  if (value.ok === true) {
    if (value.id !== requestId || !/^[a-f0-9]{16}$/.test(value.id)) throw fail("PROTOCOL_ERROR", "Response request id does not match", { routeAffecting: true });
    return validateResult(value.result, operation);
  }
  exactKeys(value.error, ["code", "message"], "Error");
  if (typeof value.error.code !== "string" || !/^[A-Z_]{2,40}$/.test(value.error.code) || typeof value.error.message !== "string" || value.error.message.length > 300) {
    throw fail("PROTOCOL_ERROR", "Remote error fields are invalid", { routeAffecting: true });
  }
  const routeAffecting = ["PROTOCOL_ERROR", "REMOTE_UNSUPPORTED"].includes(value.error.code);
  throw fail(value.error.code, value.error.message, { routeAffecting });
}

export function validateCapabilities(value) {
  exactKeys(value, ["protocol", "python", "operations", "limits", "utilities", "authorization"], "Capabilities");
  if (value.protocol !== 2 || value.authorization !== "remote-account") throw fail("REMOTE_UNSUPPORTED", "Remote authorization or protocol capability is unsupported", { routeAffecting: true });
  if (!Array.isArray(value.python) || value.python.length !== 2 || !value.python.every(Number.isInteger)) throw fail("PROTOCOL_ERROR", "Python capability is invalid", { routeAffecting: true });
  if (!Array.isArray(value.operations) || value.operations.join(",") !== "read,ls,find,grep,access,readRaw,write,mkdir,rollback,exec") throw fail("REMOTE_UNSUPPORTED", "Remote operation capability set is incomplete", { routeAffecting: true });
  exactKeys(value.utilities, ["rg", "fd"], "Utility capabilities");
  if (typeof value.utilities.rg !== "string" || typeof value.utilities.fd !== "string") throw fail("REMOTE_UNSUPPORTED", "Remote rg and fd are required", { routeAffecting: true });
  exactKeys(value.limits, ["requestBytes", "responseBytes", "readBytes", "readLines", "textSourceBytes", "results", "scanBytes", "transferBytes", "execBytes"], "Capability limits");
  for (const [key, number] of Object.entries(value.limits)) if (!Number.isInteger(number) || number <= 0) throw fail("PROTOCOL_ERROR", `Capability limit ${key} is invalid`, { routeAffecting: true });
  return Object.freeze(value);
}
