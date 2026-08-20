const DEFAULT_MAX_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
import { validateCapabilities, fail } from "./protocol.mjs";

export class RemoteRuntime {
  constructor(controller, transport, audit, imageProcessor = null, limits = { commandTimeoutMs: 30000, maxTransferBytes: 8 * 1024 * 1024 }) {
    this.controller = controller;
    this.transport = transport;
    this.audit = audit;
    this.imageProcessor = imageProcessor;
    this.limits = limits;
    this.capabilities = new Map();
  }
  async negotiate(configuredTarget, signal) {
    const reply = await this.transport.request(configuredTarget, "capabilities", {}, { signal, timeoutMs: 8_000 });
    const capabilities = validateCapabilities(reply.result);
    if (capabilities.limits.requestBytes !== 12 * 1024 * 1024 || capabilities.limits.responseBytes !== 48 * 1024 * 1024 || capabilities.limits.readBytes !== 50 * 1024 || capabilities.limits.readLines !== 2000 || capabilities.limits.textSourceBytes !== 128 * 1024 * 1024 || capabilities.limits.results < 1000 || capabilities.limits.scanBytes < 64 * 1024 * 1024 || capabilities.limits.transferBytes !== 8 * 1024 * 1024 || capabilities.limits.execBytes !== 64 * 1024) {
      throw fail("REMOTE_UNSUPPORTED", "Remote helper limit capabilities do not match this package", { routeAffecting: true });
    }
    this.capabilities.set(configuredTarget.destination, capabilities);
    return capabilities;
  }
  async execute(operation, args, signal, ctx) {
    const lease = this.controller.begin(operation, signal, ctx);
    let error = null;
    let meta = {};
    const started = Date.now();
    try {
      if (!this.capabilities.has(lease.target.destination)) throw fail("REMOTE_STATE_MISMATCH", "Remote capabilities are not negotiated; use /remote recover", { routeAffecting: true });
      const reply = await this.transport.request(lease.target, operation, { cwd: lease.target.cwd, ...args }, { signal: lease.controller.signal, timeoutMs: 10_000 });
      meta = reply.meta;
      if (operation === "read") return await this.#read(reply.result, args, ctx, signal);
      if (operation === "ls") return this.#ls(reply.result, args);
      if (operation === "find") return this.#find(reply.result, args);
      if (operation === "grep") return this.#grep(reply.result, args);
      throw fail("REMOTE_UNSUPPORTED", "Structured operation is unsupported", { routeAffecting: true });
    } catch (caught) {
      error = caught;
      throw caught;
    } finally {
      this.audit.record({ event: "operation", operation, target: lease.target.name, code: error?.code ?? "OK", durationMs: meta.durationMs ?? Date.now() - started, stdoutBytes: meta.stdoutBytes, stderrBytes: meta.stderrBytes });
      this.controller.end(lease, error);
    }
  }
  async request(operation, args, signal, ctx, timeoutMs = 10_000) {
    const lease = this.controller.begin(operation, signal, ctx);
    let error = null;
    const started = Date.now();
    let meta = {};
    try {
      if (!this.capabilities.has(lease.target.destination)) throw fail("REMOTE_STATE_MISMATCH", "Remote capabilities are not negotiated; use /remote recover", { routeAffecting: true });
      const reply = await this.transport.request(lease.target, operation, { cwd: lease.target.cwd, ...args }, { signal: lease.controller.signal, timeoutMs });
      meta = reply.meta;
      return reply.result;
    } catch (caught) { error = caught; throw caught; }
    finally {
      this.audit.record({ event: "operation", operation, target: lease.target.name, code: error?.code ?? "OK", durationMs: meta.durationMs ?? Date.now() - started, stdoutBytes: meta.stdoutBytes, stderrBytes: meta.stderrBytes });
      this.controller.end(lease, error);
    }
  }
  async rawRead(path, signal, ctx) {
    const result = await this.request("readRaw", { path, maxBytes: this.limits.maxTransferBytes }, signal, ctx);
    return Buffer.from(result.data, "base64");
  }
  async access(path, writable, signal, ctx) { await this.request("access", { path, writable }, signal, ctx); }
  async write(path, content, signal, ctx) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    if (data.length > this.limits.maxTransferBytes) throw fail("REMOTE_OUTPUT_LIMIT", "Write exceeds the configured transfer limit");
    return this.request("write", { path, data: data.toString("base64"), maxBytes: this.limits.maxTransferBytes }, signal, ctx, 30_000);
  }
  async mkdir(path, signal, ctx) { return this.request("mkdir", { path }, signal, ctx); }
  async rollback(path, signal, ctx) { return this.request("rollback", { path }, signal, ctx, 30_000); }
  async exec(command, timeoutMs, signal, ctx) {
    const bounded = Math.min(Math.max(1, timeoutMs ?? this.limits.commandTimeoutMs), this.limits.commandTimeoutMs);
    const result = await this.request("exec", { command, timeoutMs: bounded }, signal, ctx, bounded + 5_000);
    return { stdout: Buffer.from(result.stdout, "base64"), stderr: Buffer.from(result.stderr, "base64"), exitCode: result.exitCode, timedOut: result.timedOut };
  }
  async #read(result, args, ctx, signal) {
    if (result.kind === "image") {
      if (!this.imageProcessor) throw fail("REMOTE_UNSUPPORTED", "Native Pi image processing is unavailable", { routeAffecting: true });
      return this.imageProcessor(result, args, signal, ctx);
    }
    const truncation = result.truncation;
    const start = result.startLine;
    let output;
    let details;
    if (truncation.firstLineExceedsLimit) {
      output = `[Line ${start} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Remote read-only mode does not expose bash.]`;
      details = { truncation };
    } else if (truncation.truncated) {
      const end = start + truncation.outputLines - 1;
      const next = end + 1;
      output = result.data;
      output += truncation.truncatedBy === "lines"
        ? `\n\n[Showing lines ${start}-${end} of ${result.totalFileLines}. Use offset=${next} to continue.]`
        : `\n\n[Showing lines ${start}-${end} of ${result.totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${next} to continue.]`;
      details = { truncation };
    } else if (result.userLimitedLines !== null && result.hasMoreAfterUserLimit) {
      const remaining = result.totalFileLines - (start - 1 + result.userLimitedLines);
      output = `${result.data}\n\n[${remaining} more lines in file. Use offset=${start + result.userLimitedLines} to continue.]`;
    } else output = result.data;
    return { content: [{ type: "text", text: output }], details };
  }
  #ls(result, args) {
    if (result.empty) return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
    const effectiveLimit = args.limit ?? 500;
    const details = {};
    const notices = [];
    if (result.limitReached) { details.entryLimitReached = effectiveLimit; notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`); }
    if (result.truncation) { details.truncation = result.truncation; notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`); }
    let text = result.data;
    if (notices.length) text += `\n\n[${notices.join(". ")}]`;
    return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
  }
  #find(result, args) {
    if (result.empty) return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
    const effectiveLimit = args.limit ?? 1000;
    const details = {};
    const notices = [];
    if (result.limitReached) { details.resultLimitReached = effectiveLimit; notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`); }
    if (result.truncation) { details.truncation = result.truncation; notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`); }
    let text = result.data;
    if (notices.length) text += `\n\n[${notices.join(". ")}]`;
    return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
  }
  #grep(result, args) {
    if (!result.data && !result.matchLimitReached) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
    const effectiveLimit = Math.max(1, args.limit ?? 100);
    const details = {};
    const notices = [];
    if (result.matchLimitReached) { details.matchLimitReached = effectiveLimit; notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`); }
    if (result.truncation) { details.truncation = result.truncation; notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`); }
    if (result.linesTruncated) { details.linesTruncated = true; notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`); }
    let text = result.data;
    if (notices.length) text += `\n\n[${notices.join(". ")}]`;
    return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
  }
}
