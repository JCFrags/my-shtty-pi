import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { strictJsonParse, fail } from "./protocol.mjs";
import { STRICT_SSH_ARGS } from "./transport.mjs";

export const SESSION_PROVIDER_PROTOCOL_VERSION = 1;
export const SESSION_FILE_RESOURCE_PROTOCOL_VERSION = 1;
export const SESSION_PROVIDER_REGISTER_EVENT = "grounded:session-provider-register-v1";
export const SESSION_PROVIDER_READY_EVENT = "grounded:session-provider-registry-ready-v1";
export const SESSION_BOOTSTRAP_COMMAND = "exec python3 -c 'import sys,struct;r=sys.stdin.buffer;h=r.read(4);n=struct.unpack(\">I\",h)[0];c=r.read(n);exec(compile(c,\"<pi-session-helper>\",\"exec\"),{\"__name__\":\"__main__\"})'";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_HELPER_BYTES = 128 * 1024;
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_SESSION_OUTPUT_BYTES = 48 * 1024 * 1024;
const MAX_MEMORY_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const MAX_RESOURCE_FILE_BYTES = 2 * 1024 * 1024;
const LOG_ROOT = join(tmpdir(), "pi-native-ssh-sessions");

function sessionError(code, message, options = {}) {
  const error = new Error(message);
  error.name = "NativeSshSessionError";
  error.code = code;
  error.safeMessage = message;
  error.routeAffecting = options.routeAffecting === true;
  error.retryable = options.retryable === true;
  return error;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw sessionError("SESSION_PROTOCOL_ERROR", `${label} is not an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw sessionError("SESSION_PROTOCOL_ERROR", `${label} fields are invalid`);
  }
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw sessionError("SESSION_FRAME_LIMIT", "Session frame exceeds its limit");
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class SessionFrameDecoder {
  constructor() { this.buffer = Buffer.alloc(0); }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) throw sessionError("SESSION_FRAME_LIMIT", "Session frame declares excessive output");
      if (this.buffer.length < length + 4) break;
      frames.push(strictJsonParse(this.buffer.subarray(4, length + 4), MAX_FRAME_BYTES));
      this.buffer = this.buffer.subarray(length + 4);
    }
    return frames;
  }
  finish() {
    if (this.buffer.length) throw sessionError("SESSION_PROTOCOL_ERROR", "Session protocol ended with a truncated frame");
  }
}

function canonicalBase64(value, bytes, label) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw sessionError("SESSION_PROTOCOL_ERROR", `${label} base64 is invalid`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== bytes || decoded.toString("base64") !== value) throw sessionError("SESSION_PROTOCOL_ERROR", `${label} base64 is invalid`);
  return decoded;
}

function boundedAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || Buffer.byteLength(value, "utf8") > 4096) {
    throw sessionError("SESSION_PROTOCOL_ERROR", `${label} is invalid`);
  }
  return value;
}

function resourceOptions(options) {
  return options?.signal ? { signal: options.signal } : undefined;
}

export class NativeSshFileResource {
  constructor(handle, targetName) {
    this.protocolVersion = SESSION_FILE_RESOURCE_PROTOCOL_VERSION;
    this.queueIdentity = `native-ssh:${targetName}`;
    this.handle = handle;
  }

  async resolve(path, options) {
    const result = await this.handle.requestResource("resolve", { path }, resourceOptions(options));
    exactKeys(result, ["canonicalPath"], "File resolve result");
    return boundedAbsolutePath(result.canonicalPath, "Resolved remote path");
  }

  async read(path, options = {}) {
    const maxBytes = options.maxBytes ?? MAX_RESOURCE_FILE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESOURCE_FILE_BYTES) {
      throw sessionError("SESSION_RESOURCE_ARGUMENT_INVALID", "Remote file read byte limit is invalid");
    }
    const result = await this.handle.requestResource("read", {
      path,
      allowMissing: options.allowMissing === true,
      maxBytes,
    }, resourceOptions(options));
    const common = ["canonicalPath", "exists"];
    if (!result?.exists) {
      exactKeys(result, common, "File read result");
      return { canonicalPath: boundedAbsolutePath(result.canonicalPath, "Remote file path"), exists: false };
    }
    exactKeys(result, [...common, "dataBase64", "bytes", "rawDigest", "mode", "hardLinks"], "File read result");
    boundedAbsolutePath(result.canonicalPath, "Remote file path");
    if (!Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.bytes > maxBytes) throw sessionError("SESSION_PROTOCOL_ERROR", "Remote file byte count is invalid");
    canonicalBase64(result.dataBase64, result.bytes, "Remote file");
    if (typeof result.rawDigest !== "string" || !/^[0-9a-f]{64}$/.test(result.rawDigest)) throw sessionError("SESSION_PROTOCOL_ERROR", "Remote file digest is invalid");
    if (!Number.isSafeInteger(result.mode) || result.mode < 0 || result.mode > 0o7777 || !Number.isSafeInteger(result.hardLinks) || result.hardLinks < 1) {
      throw sessionError("SESSION_PROTOCOL_ERROR", "Remote file metadata is invalid");
    }
    return result;
  }

  async commit(request, options) {
    if (!request || typeof request !== "object") throw sessionError("SESSION_RESOURCE_ARGUMENT_INVALID", "Remote commit request is invalid");
    const data = Buffer.from(request.dataBase64 ?? "", "base64");
    if (data.length > MAX_RESOURCE_FILE_BYTES || data.toString("base64") !== request.dataBase64) {
      throw sessionError("SESSION_RESOURCE_ARGUMENT_INVALID", "Remote commit data is invalid or too large");
    }
    const result = await this.handle.requestResource("commit", {
      path: request.path,
      canonicalPath: request.canonicalPath,
      dataBase64: request.dataBase64,
      expectedExists: request.expectedExists,
      expectedRawDigest: request.expectedRawDigest ?? null,
      maxBytes: MAX_RESOURCE_FILE_BYTES,
    }, resourceOptions(options));
    exactKeys(result, ["canonicalPath", "bytes", "rawDigest", "created", "atomic", "preservedHardLinks", "hardLinksBefore", "rollbackAvailable"], "File commit result");
    boundedAbsolutePath(result.canonicalPath, "Committed remote path");
    if (!Number.isSafeInteger(result.bytes) || result.bytes !== data.length || typeof result.rawDigest !== "string" || !/^[0-9a-f]{64}$/.test(result.rawDigest)
      || typeof result.created !== "boolean" || typeof result.atomic !== "boolean" || typeof result.preservedHardLinks !== "boolean"
      || !Number.isSafeInteger(result.hardLinksBefore) || result.hardLinksBefore < 0 || typeof result.rollbackAvailable !== "boolean") {
      throw sessionError("SESSION_PROTOCOL_ERROR", "Remote commit result is invalid");
    }
    return result;
  }

  async searchText(request, options) {
    const result = await this.handle.requestResource("searchText", {
      query: request.query,
      path: request.path,
      fileGlob: request.fileGlob ?? null,
      ignoreCase: request.ignoreCase === true,
      literal: request.literal !== false,
      contextLines: request.contextLines ?? 2,
    }, resourceOptions(options));
    exactKeys(result, ["hits"], "Text search result");
    if (!Array.isArray(result.hits)) throw sessionError("SESSION_PROTOCOL_ERROR", "Remote text search hits are invalid");
    for (const hit of result.hits) {
      exactKeys(hit, ["path", "line", "byteColumn", "text", "snippet", "snippetStartLine", "snippetEndLine", "submatchCount"], "Text search hit");
      if (typeof hit.path !== "string" || typeof hit.text !== "string" || typeof hit.snippet !== "string"
        || !Number.isSafeInteger(hit.line) || hit.line < 1 || !Number.isSafeInteger(hit.byteColumn) || hit.byteColumn < 1
        || !Number.isSafeInteger(hit.snippetStartLine) || hit.snippetStartLine < 1 || !Number.isSafeInteger(hit.snippetEndLine) || hit.snippetEndLine < hit.snippetStartLine
        || !Number.isSafeInteger(hit.submatchCount) || hit.submatchCount < 1) throw sessionError("SESSION_PROTOCOL_ERROR", "Remote text search hit is invalid");
    }
    return result;
  }

  async searchFiles(request, options) {
    const result = await this.handle.requestResource("searchFiles", { path: request.path }, resourceOptions(options));
    exactKeys(result, ["hits"], "File search result");
    if (!Array.isArray(result.hits)) throw sessionError("SESSION_PROTOCOL_ERROR", "Remote file search hits are invalid");
    for (const hit of result.hits) {
      exactKeys(hit, ["path", "kind"], "File search hit");
      if (typeof hit.path !== "string" || !["file", "directory"].includes(hit.kind)) throw sessionError("SESSION_PROTOCOL_ERROR", "Remote file search hit is invalid");
    }
    return result;
  }
}

function signalProcessGroup(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function classifyOpenFailure(code, diagnostic) {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(diagnostic)) return sessionError("HOST_KEY_CHANGED", "Strict host-key verification found a changed key", { routeAffecting: true });
  if (/host key verification failed|no .*host key is known|No ED25519 host key is known/i.test(diagnostic)) return sessionError("HOST_KEY_REQUIRED", "Strict host-key verification requires an existing trusted key", { routeAffecting: true });
  if (/permission denied|authentication/i.test(diagnostic)) return sessionError("AUTH_REQUIRED", "Non-interactive SSH authentication failed", { routeAffecting: true });
  return sessionError("SESSION_OPEN_FAILED", `Persistent SSH process exited during open with status ${code ?? "unknown"}`, { routeAffecting: true, retryable: true });
}

class PrivateSessionLog {
  constructor(path) { this.path = path; this.pending = Promise.resolve(); this.closed = false; }
  static async create() {
    await mkdir(LOG_ROOT, { recursive: true, mode: 0o700 });
    const path = join(LOG_ROOT, `session-${Date.now()}-${randomBytes(8).toString("hex")}.jsonl`);
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    return new PrivateSessionLog(path);
  }
  append(requestId, sequence, stream, bytes) {
    if (this.closed) return;
    const line = `${JSON.stringify({ requestId, sequence, stream, bytes: bytes.length, dataBase64: bytes.toString("base64") })}\n`;
    this.pending = this.pending.then(async () => {
      const handle = await open(this.path, "a", 0o600);
      try { await handle.writeFile(line, "utf8"); } finally { await handle.close(); }
    });
  }
  flush() { return this.pending; }
  async close() { this.closed = true; await this.pending; }
}

export class NativeSshSessionHandle {
  constructor(request, generation, target, helper, options = {}) {
    this.providerId = "native-ssh-v1";
    this.backend = "ssh";
    this.pty = false;
    this.state = "opening";
    this.cwd = request.cwd;
    this.generation = generation;
    this.openedAt = Date.now();
    this.lastActivityAt = this.openedAt;
    this.taintReason = undefined;
    this.defaultCommandTimeoutMs = request.commandTimeoutMs;
    this.resourceTimeoutMs = options.resourceTimeoutMs ?? request.commandTimeoutMs;
    this.idleTimeoutMs = request.idleTimeoutMs;
    this.closeTimeoutMs = request.closeTimeoutMs;
    this.cancelGraceMs = options.cancelGraceMs ?? 2000;
    this.killGraceMs = options.killGraceMs ?? 500;
    this.decoder = new SessionFrameDecoder();
    this.diagnostic = [];
    this.diagnosticBytes = 0;
    this.commandSequence = 0;
    this.resourceSequence = 0;
    this.active = undefined;
    this.activeResource = undefined;
    this.fileResource = new NativeSshFileResource(this, target.name);
    this.idleTimer = undefined;
    this.closePromise = undefined;
    this.settledClosed = false;
    this.resolveClosed = () => {};
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.resolveOpen = () => {};
    this.rejectOpen = () => {};
    this.opened = new Promise((resolve, reject) => { this.resolveOpen = resolve; this.rejectOpen = reject; });
    this.log = undefined;

    const argv = [...STRICT_SSH_ARGS, ...(options.extraArgs ?? []), "--", target.destination, SESSION_BOOTSTRAP_COMMAND];
    this.spawnArgs = argv;
    this.child = (options.spawn ?? nodeSpawn)(options.sshBinary ?? "/usr/bin/ssh", argv, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout?.on("data", (chunk) => this.receiveProtocol(chunk));
    this.child.stderr?.on("data", (chunk) => this.receiveDiagnostic(chunk));
    this.child.stdin?.on("error", (error) => this.markTainted(`SSH session input failed: ${error.message}`));
    this.child.on("error", (error) => {
      const failure = error?.code === "ENOENT"
        ? sessionError("SSH_BINARY_MISSING", "OpenSSH binary is missing", { routeAffecting: true })
        : sessionError("SESSION_OPEN_FAILED", "Persistent SSH process could not start", { routeAffecting: true });
      if (this.state === "opening") this.rejectOpen(failure);
      this.markTainted(failure.safeMessage);
    });
    this.child.on("close", (code) => this.handleClose(code));

    this.openTimer = setTimeout(() => {
      if (this.state === "opening") this.markTainted("Persistent SSH session open handshake timed out");
    }, request.openTimeoutMs);
    this.openTimer.unref?.();

    const helperHeader = Buffer.allocUnsafe(4);
    helperHeader.writeUInt32BE(helper.length, 0);
    const openFrame = encodeFrame({ version: 1, type: "open", generation, cwd: request.cwd });
    this.child.stdin?.write(Buffer.concat([helperHeader, helper, openFrame]));
  }

  static async open(request, generation, target, helper, options = {}) {
    if (request.pty) throw sessionError("SESSION_PTY_UNAVAILABLE", "Native SSH persistent sessions do not support a PTY");
    if (!isAbsolute(request.cwd) || Buffer.byteLength(request.cwd, "utf8") > 4096 || request.cwd.includes("\0")) {
      throw sessionError("SESSION_CWD_INVALID", "Native SSH session cwd must be an absolute bounded path");
    }
    const log = await PrivateSessionLog.create();
    const handle = new NativeSshSessionHandle(request, generation, target, helper, options);
    handle.log = log;
    try {
      await handle.opened;
      handle.scheduleIdleClose();
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  status() {
    return {
      state: this.state,
      cwd: this.cwd,
      ...(this.child.pid !== undefined ? { pid: this.child.pid } : {}),
      generation: this.generation,
      openedAt: this.openedAt,
      lastActivityAt: this.lastActivityAt,
      ...(this.taintReason ? { taintReason: this.taintReason } : {}),
    };
  }

  async execute(command, options = {}) {
    if (typeof command !== "string" || command.includes("\0") || Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
      throw sessionError("SESSION_COMMAND_INVALID", "Native SSH session command is invalid or too large");
    }
    if (this.state !== "idle") throw sessionError("SESSION_NOT_IDLE", `Session is not idle: ${this.state}`);
    if (options.signal?.aborted) throw sessionError("SESSION_CANCELLED", "Session command was cancelled before start");
    this.clearIdleClose();
    this.state = "running";
    this.lastActivityAt = Date.now();
    const requestId = randomBytes(16).toString("hex");
    const sequence = ++this.commandSequence;
    const timeoutMs = options.timeoutMs ?? this.defaultCommandTimeoutMs;
    const result = new Promise((resolve, reject) => {
      const active = {
        requestId,
        sequence,
        nextOutputSequence: 0,
        chunks: [],
        retainedBytes: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
        totalBytes: 0,
        truncated: false,
        cancelled: false,
        timedOut: false,
        finishing: false,
        resolve,
        reject,
        signal: options.signal,
      };
      this.active = active;
      if (timeoutMs > 0) {
        active.timeout = setTimeout(() => this.requestCancellation(true), timeoutMs);
        active.timeout.unref?.();
      }
      if (options.signal) {
        active.abortListener = () => this.requestCancellation(false);
        options.signal.addEventListener("abort", active.abortListener, { once: true });
      }
    });
    this.writeFrame({
      version: 1,
      type: "execute",
      generation: this.generation,
      requestId,
      sequence,
      commandBase64: Buffer.from(command, "utf8").toString("base64"),
    });
    return result;
  }

  async requestResource(operation, args, options = {}) {
    if (!["resolve", "read", "commit", "searchText", "searchFiles"].includes(operation)) {
      throw sessionError("SESSION_RESOURCE_ARGUMENT_INVALID", "Remote file operation is unsupported");
    }
    if (this.state !== "idle") throw sessionError("SESSION_NOT_IDLE", `Session is not idle: ${this.state}`);
    if (options.signal?.aborted) throw sessionError("SESSION_CANCELLED", "Remote file operation was cancelled before start");
    this.clearIdleClose();
    this.state = "running";
    this.lastActivityAt = Date.now();
    const requestId = randomBytes(16).toString("hex");
    const sequence = ++this.resourceSequence;
    const result = new Promise((resolve, reject) => {
      const active = { requestId, sequence, operation, resolve, reject, signal: options.signal };
      if (this.resourceTimeoutMs > 0) {
        active.timeout = setTimeout(() => this.markTainted("Remote file operation timed out", "SESSION_RESOURCE_TIMEOUT"), this.resourceTimeoutMs);
        active.timeout.unref?.();
      }
      if (options.signal) {
        active.abortListener = () => this.markTainted("Remote file operation was aborted");
        options.signal.addEventListener("abort", active.abortListener, { once: true });
      }
      this.activeResource = active;
    });
    try {
      this.writeFrame({
        version: SESSION_FILE_RESOURCE_PROTOCOL_VERSION,
        type: "resource",
        generation: this.generation,
        requestId,
        sequence,
        operation,
        cwd: this.cwd,
        args,
      });
    } catch (error) {
      this.markTainted(error.message);
    }
    return result;
  }

  input() { throw sessionError("SESSION_INPUT_REQUIRES_PTY", "Native SSH persistent sessions do not support input"); }
  interrupt() {
    if (this.activeResource) this.markTainted("Remote file operation was interrupted");
    else if (this.state === "running") this.requestCancellation(false);
  }
  whenClosed() { return this.closed; }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.clearIdleClose();
      clearTimeout(this.openTimer);
      if (this.state === "closed") { await this.log?.close(); return; }
      const wasRunning = this.state === "running";
      this.state = "closing";
      this.rejectOpen(sessionError("SESSION_CLOSED", "Session closed during open"));
      this.rejectActive(sessionError("SESSION_CLOSED", "Session closed"));
      this.rejectResource(sessionError("SESSION_CLOSED", "Session closed"));
      if (!wasRunning && !this.child.stdin?.destroyed) {
        try { this.writeFrame({ version: 1, type: "close", generation: this.generation }); } catch {}
      }
      this.child.stdin?.end();
      await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, this.closeTimeoutMs))]);
      if (this.child.exitCode === null && this.child.signalCode === null) signalProcessGroup(this.child, "SIGTERM");
      await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, this.killGraceMs))]);
      if (this.child.exitCode === null && this.child.signalCode === null) signalProcessGroup(this.child, "SIGKILL");
      await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
      this.state = "closed";
      await this.log?.close();
      this.settleClosed();
    })();
    return this.closePromise;
  }

  writeFrame(value) {
    if (!this.child.stdin || this.child.stdin.destroyed) throw sessionError("SESSION_CLOSED", "SSH session input is closed");
    this.child.stdin.write(encodeFrame(value));
  }

  receiveDiagnostic(chunk) {
    if (this.diagnosticBytes >= MAX_DIAGNOSTIC_BYTES) return;
    const bytes = Buffer.from(chunk).subarray(0, MAX_DIAGNOSTIC_BYTES - this.diagnosticBytes);
    this.diagnostic.push(bytes);
    this.diagnosticBytes += bytes.length;
    if (this.state !== "opening" && bytes.length) this.markTainted("Persistent SSH process produced an unexpected diagnostic");
  }

  receiveProtocol(chunk) {
    let frames;
    try { frames = this.decoder.push(chunk); }
    catch (error) { this.markTainted(error.message); return; }
    for (const frame of frames) {
      try { this.receiveFrame(frame); }
      catch (error) { this.markTainted(error.message); return; }
    }
  }

  receiveFrame(frame) {
    if (frame?.type === "error") {
      exactKeys(frame, ["version", "type", "code", "message"], "Session error frame");
      if (frame.version !== 1 || typeof frame.code !== "string" || typeof frame.message !== "string") throw sessionError("SESSION_PROTOCOL_ERROR", "Session error frame is invalid");
      throw sessionError(frame.code, frame.message);
    }
    if (frame?.type === "ready") {
      exactKeys(frame, ["version", "type", "generation", "sequence", "cwd"], "Session ready frame");
      if (this.state !== "opening" || frame.version !== 1 || frame.generation !== this.generation || frame.sequence !== 0 || typeof frame.cwd !== "string" || !isAbsolute(frame.cwd)) {
        throw sessionError("SESSION_PROTOCOL_ERROR", "Session ready frame is invalid");
      }
      clearTimeout(this.openTimer);
      this.cwd = frame.cwd;
      this.state = "idle";
      this.lastActivityAt = Date.now();
      this.resolveOpen();
      return;
    }
    if (frame?.type === "resourceResult" || frame?.type === "resourceError") {
      const activeResource = this.activeResource;
      if (!activeResource) throw sessionError("SESSION_PROTOCOL_ERROR", "Resource frame arrived while no file operation is active");
      if (frame.type === "resourceResult") {
        exactKeys(frame, ["version", "type", "generation", "requestId", "sequence", "result"], "Resource result frame");
      } else {
        exactKeys(frame, ["version", "type", "generation", "requestId", "sequence", "code", "message"], "Resource error frame");
      }
      if (frame.version !== SESSION_FILE_RESOURCE_PROTOCOL_VERSION || frame.generation !== this.generation
        || frame.requestId !== activeResource.requestId || frame.sequence !== activeResource.sequence) {
        throw sessionError("SESSION_PROTOCOL_ERROR", "Resource frame does not match the active file operation");
      }
      this.clearResource(activeResource);
      this.activeResource = undefined;
      this.state = "idle";
      this.lastActivityAt = Date.now();
      this.scheduleIdleClose();
      if (frame.type === "resourceError") {
        if (typeof frame.code !== "string" || typeof frame.message !== "string") throw sessionError("SESSION_PROTOCOL_ERROR", "Resource error frame is invalid");
        activeResource.reject(sessionError(frame.code, frame.message));
      } else {
        activeResource.resolve(frame.result);
      }
      return;
    }
    const active = this.active;
    if (!active) throw sessionError("SESSION_PROTOCOL_ERROR", "Command frame arrived while no command is active");
    if (frame?.type === "output") {
      exactKeys(frame, ["version", "type", "generation", "requestId", "commandSequence", "sequence", "stream", "dataBase64", "bytes"], "Session output frame");
      if (frame.version !== 1 || frame.generation !== this.generation || frame.requestId !== active.requestId || frame.commandSequence !== active.sequence || frame.sequence !== active.nextOutputSequence || !["stdout", "stderr"].includes(frame.stream) || !Number.isSafeInteger(frame.bytes) || frame.bytes < 1) {
        throw sessionError("SESSION_PROTOCOL_ERROR", "Session output frame does not match the active command");
      }
      const bytes = canonicalBase64(frame.dataBase64, frame.bytes, "Session output");
      active.nextOutputSequence++;
      active.totalBytes += bytes.length;
      if (active.totalBytes > MAX_SESSION_OUTPUT_BYTES) throw sessionError("SESSION_OUTPUT_LIMIT", "Native SSH session output exceeded its limit");
      if (frame.stream === "stdout") active.stdoutBytes += bytes.length;
      else active.stderrBytes += bytes.length;
      const retained = { sequence: frame.sequence, stream: frame.stream, dataBase64: frame.dataBase64, bytes: frame.bytes };
      active.chunks.push(retained);
      active.retainedBytes += bytes.length;
      this.log?.append(active.requestId, frame.sequence, frame.stream, bytes);
      while (active.retainedBytes > MAX_MEMORY_OUTPUT_BYTES && active.chunks.length > 1) {
        const dropped = active.chunks.shift();
        active.retainedBytes -= dropped.bytes;
        active.truncated = true;
      }
      return;
    }
    if (frame?.type !== "complete") throw sessionError("SESSION_PROTOCOL_ERROR", "Session command frame type is invalid");
    exactKeys(frame, ["version", "type", "generation", "requestId", "sequence", "cwd", "exitCode", "signal"], "Session completion frame");
    if (frame.version !== 1 || frame.generation !== this.generation || frame.requestId !== active.requestId || frame.sequence !== active.sequence || typeof frame.cwd !== "string" || !isAbsolute(frame.cwd) || !Number.isSafeInteger(frame.exitCode) || frame.exitCode < -255 || frame.exitCode > 255 || frame.signal !== null) {
      throw sessionError("SESSION_PROTOCOL_ERROR", "Session completion frame does not match the active command");
    }
    if (active.finishing) throw sessionError("SESSION_PROTOCOL_ERROR", "Session command completed more than once");
    active.finishing = true;
    void this.completeActive(active, frame);
  }

  async completeActive(active, frame) {
    try { await this.log?.flush(); }
    catch (error) { this.markTainted(`Session log flush failed: ${error.message}`); return; }
    if (this.active !== active) return;
    this.clearActive(active);
    this.active = undefined;
    if (["tainted", "closing", "closed"].includes(this.state)) {
      active.reject(sessionError("SESSION_TAINTED", "Session became unavailable before command completion"));
      return;
    }
    this.cwd = frame.cwd;
    this.state = "idle";
    this.lastActivityAt = Date.now();
    this.scheduleIdleClose();
    active.resolve({
      requestId: active.requestId,
      exitCode: frame.exitCode,
      signal: null,
      cwd: this.cwd,
      cancelled: active.cancelled,
      timedOut: active.timedOut,
      stdoutBytes: active.stdoutBytes,
      stderrBytes: active.stderrBytes,
      terminalBytes: 0,
      truncated: active.truncated,
      chunks: active.chunks,
      logPath: this.log.path,
    });
  }

  requestCancellation(timedOut) {
    const active = this.active;
    if (!active || this.state !== "running") return;
    active.cancelled = true;
    active.timedOut ||= timedOut;
    if (!active.cancelSent) {
      active.cancelSent = true;
      try { this.writeFrame({ version: 1, type: "cancel", generation: this.generation, requestId: active.requestId, sequence: active.sequence }); }
      catch (error) { this.markTainted(error.message); return; }
    }
    if (!active.cancelTimer) {
      active.cancelTimer = setTimeout(() => {
        if (this.active === active) this.markTainted("Remote command did not settle after cancellation");
      }, this.cancelGraceMs);
      active.cancelTimer.unref?.();
    }
  }

  rejectActive(error) {
    const active = this.active;
    if (!active) return;
    this.clearActive(active);
    this.active = undefined;
    active.reject(error);
  }

  rejectResource(error) {
    const active = this.activeResource;
    if (!active) return;
    this.clearResource(active);
    this.activeResource = undefined;
    active.reject(error);
  }

  clearResource(active) {
    if (active.timeout) clearTimeout(active.timeout);
    if (active.signal && active.abortListener) active.signal.removeEventListener("abort", active.abortListener);
  }

  clearActive(active) {
    if (active.timeout) clearTimeout(active.timeout);
    if (active.cancelTimer) clearTimeout(active.cancelTimer);
    if (active.signal && active.abortListener) active.signal.removeEventListener("abort", active.abortListener);
  }

  markTainted(reason, code = "SESSION_TAINTED") {
    if (["closing", "closed"].includes(this.state)) return;
    this.taintReason = reason;
    this.state = "tainted";
    const error = sessionError(code, reason);
    this.rejectOpen(error);
    this.rejectActive(error);
    this.rejectResource(error);
    try { signalProcessGroup(this.child, "SIGTERM"); } catch {}
  }

  handleClose(code) {
    clearTimeout(this.openTimer);
    try { this.decoder.finish(); } catch (error) { if (this.state !== "closing") this.taintReason ??= error.message; }
    if (this.state === "opening") {
      const diagnostic = Buffer.concat(this.diagnostic).toString("utf8");
      this.rejectOpen(classifyOpenFailure(code, diagnostic));
    } else if (!["closing", "closed", "tainted"].includes(this.state)) {
      this.taintReason = "Persistent SSH process disconnected";
      this.state = "tainted";
      const disconnected = sessionError("SESSION_DISCONNECTED", "Persistent SSH process disconnected");
      this.rejectActive(disconnected);
      this.rejectResource(disconnected);
    }
    this.state = "closed";
    void this.log?.close();
    this.settleClosed();
  }

  settleClosed() {
    if (this.settledClosed) return;
    this.settledClosed = true;
    this.resolveClosed();
  }

  scheduleIdleClose() {
    this.clearIdleClose();
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => void this.close(), this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }
  clearIdleClose() { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = undefined; }
}

export class NativeSshSessionProvider {
  constructor(helperSource, config, options = {}) {
    this.id = "native-ssh-v1";
    this.backend = "ssh";
    this.protocolVersion = SESSION_PROVIDER_PROTOCOL_VERSION;
    this.helper = Buffer.from(helperSource, "utf8");
    if (this.helper.length === 0 || this.helper.length > MAX_HELPER_BYTES) throw fail("SSH_CONFIG_INVALID", "Native SSH session helper exceeds its bound", { routeAffecting: true });
    this.config = config;
    this.options = options;
    this.nextGeneration = 1;
    this.live = undefined;
    this.authorizedTargets = new Set();
  }
  capabilities() { return { backend: "ssh", providerId: this.id, protocolVersion: 1, pty: false, input: false }; }
  async open(request) {
    if (!request.target || typeof request.target !== "string" || !Object.hasOwn(this.config.targets, request.target)) {
      throw sessionError("SESSION_TARGET_INVALID", "Native SSH session target must exactly match a configured target");
    }
    if (request.pty) throw sessionError("SESSION_PTY_UNAVAILABLE", "Native SSH persistent sessions do not support a PTY");
    if (!isAbsolute(request.cwd) || Buffer.byteLength(request.cwd, "utf8") > 4096 || request.cwd.includes("\0")) {
      throw sessionError("SESSION_CWD_INVALID", "Native SSH session cwd must be an absolute bounded path");
    }
    if (this.live && this.live.status().state !== "closed") throw sessionError("SESSION_LIMIT", "This Native SSH provider permits one live session in this stage");
    const target = this.config.targets[request.target];
    if (this.options.authorize && !this.authorizedTargets.has(request.target)) {
      await this.options.authorize(target, request);
      this.authorizedTargets.add(request.target);
    }
    const handle = await NativeSshSessionHandle.open(request, this.nextGeneration++, target, this.helper, this.options);
    this.live = handle;
    void handle.whenClosed().then(() => { if (this.live === handle) this.live = undefined; });
    return handle;
  }
  async close() { if (this.live) await this.live.close(); }
}

export function registerNativeSshSessionProvider(pi, provider) {
  let registered = false;
  const acceptReady = (event) => {
    if (registered) return;
    if (event?.protocolVersion !== SESSION_PROVIDER_PROTOCOL_VERSION || typeof event.register !== "function") return;
    try { event.register(provider); }
    catch (error) {
      if (error?.code !== "SESSION_PROVIDER_DUPLICATE" || !String(error.message).includes(provider.id)) throw error;
    }
    registered = true;
  };
  pi.events.on(SESSION_PROVIDER_READY_EVENT, acceptReady);
  pi.events.emit(SESSION_PROVIDER_REGISTER_EVENT, { protocolVersion: SESSION_PROVIDER_PROTOCOL_VERSION, provider });
  return { isRegistered: () => registered };
}
