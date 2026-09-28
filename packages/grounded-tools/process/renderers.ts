import { createToolPresentation, type PresentationView } from "pi-tool-controls/presentation";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" ? value as RecordValue : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const savedText = (result: { content: readonly unknown[] }): string => result.content.map(record).map((block) => block.type === "text" ? text(block.text) : "").filter(Boolean).join("\n");

function commandLabel(value: unknown): string {
  const command = text(value).trim();
  // Identify the command, not its arguments, script, terminal input, or secrets.
  const first = command.match(/^[\w./-]+/)?.[0] ?? "command";
  return `${first}${/[\r\n]/.test(command) ? " [multiline]" : ""}`;
}

function failure(body: string, partial: boolean): PresentationView {
  return { summary: partial ? "Partial result · error" : "Error · action not confirmed", tone: "error", lines: body.split("\n") };
}

function processStatus(snapshot: RecordValue): string {
  if (snapshot.cancelled === true) return `Cancelled${snapshot.timedOut === true ? " · timeout" : ""}`;
  if (snapshot.running === true) return "Running";
  if (typeof snapshot.exitCode === "number") return `Exit ${snapshot.exitCode}${snapshot.signal ? ` · ${text(snapshot.signal)}` : ""}`;
  if (snapshot.signal) return `Signal ${text(snapshot.signal)} · exit unknown`;
  if (snapshot.running === false) return "Stopped · exit unknown";
  return "Status not recorded";
}

function outputLines(body: string, framed = false): string[] {
  const separator = body.indexOf("\n---\n");
  // A known final envelope without a separator has no stdout/stderr excerpt.
  return (separator >= 0 ? body.slice(separator + 5) : framed ? "" : body).split("\n").filter((line) => line.trim());
}

function shellNotices(details: RecordValue, snapshot: RecordValue, body: string): string[] {
  const notices: string[] = [];
  if (snapshot.timedOut === true) notices.push("Timeout reported");
  if (snapshot.logError) notices.push(`Log error: ${text(snapshot.logError)}`);
  if (details.visibleOutputTruncated === true || snapshot.truncated === true) notices.push("Returned output truncated");
  notices.push(...body.split("\n").filter((line) => /^log_error:|unread in-memory bytes were dropped|Earlier output omitted/.test(line) || /^\[.*(?:unread in-memory bytes were dropped|Earlier output omitted)/.test(line)));
  // Only explicit diagnostic lines. Arbitrary stdout is not a reliable warning protocol.
  notices.push(...outputLines(body).filter((line) => /^\s*(?:warning\b|error\b|fatal\b|\[stderr\])/i.test(line)).map((line) => `Output: ${line}`));
  return [...new Set(notices)];
}

function shellResult(result: { content: readonly unknown[]; details?: unknown }, options: { expanded: boolean; isPartial: boolean }, isError: boolean, processTool: boolean): PresentationView {
  const body = savedText(result);
  if (isError) return failure(body, options.isPartial);
  const details = record(result.details);
  const snapshot = processTool ? record(details.snapshot) : details.result ? record(details.result) : details;
  const notices = shellNotices(details, snapshot, body);
  const failed = typeof snapshot.exitCode === "number" && snapshot.exitCode !== 0;
  const id = text(snapshot.id) || text(details.processId) || text(details.sessionId);
  const summary = `${options.isPartial ? "Running · partial output" : processStatus(snapshot)}${id ? ` · ${id}` : ""}`;
  const output = outputLines(body, Boolean(details.result || details.processId || details.snapshot));
  const excerpt = options.expanded ? output : output.filter((line) => !notices.includes(`Output: ${line}`));
  const lines = options.expanded || options.isPartial || failed || snapshot.cancelled === true ? excerpt.slice(-6) : [];
  if (options.expanded && snapshot.cwd) lines.unshift(`cwd: ${text(snapshot.cwd)}`);
  return {
    summary,
    tone: failed ? "error" : snapshot.cancelled === true ? "warning" : "muted",
    notices,
    lines,
    omitted: output.length > lines.length || Boolean(details.fullOutputPath) || notices.length > 0,
  };
}

export const bashPresentation = createToolPresentation({
  call: (args) => `bash ${commandLabel(args.command)}${args.sessionId ? ` [session ${text(args.sessionId)}]` : ""}${args.background === true ? " [background]" : args.yieldMs !== undefined ? " [yield]" : ""}`,
  result: (result, options, context) => shellResult(result, options, context.isError, false),
});

export const processPresentation = createToolPresentation({
  call: (args) => `process ${text(args.action)}${args.id ? ` ${text(args.id)}` : ""}`,
  result(result, options, context) {
    if (context.isError) return failure(savedText(result), options.isPartial);
    const details = record(result.details);
    if (context.args?.action === "list" && Array.isArray(details.sessions)) {
      const entries = details.sessions.map(record);
      const failed = entries.filter((entry) => typeof entry.exitCode === "number" && entry.exitCode !== 0).length;
      const cancelled = entries.filter((entry) => entry.cancelled === true).length;
      const unknown = entries.filter((entry) => entry.running !== true && entry.cancelled !== true && typeof entry.exitCode !== "number").length;
      return {
        summary: `${entries.length} processes · ${entries.filter((entry) => entry.running === true).length} running`,
        notices: [
          ...(failed ? [`${failed} failed exits`] : []),
          ...(cancelled ? [`${cancelled} cancelled`] : []),
          ...(unknown ? [`${unknown} unknown status`] : []),
          ...entries.filter((entry) => entry.logError).map((entry) => `Log error (${text(entry.id)}): ${text(entry.logError)}`),
        ],
        lines: entries.map((entry) => `${text(entry.id)} · ${processStatus(entry)}`),
        omitted: entries.length > 0,
      };
    }
    return shellResult(result, options, context.isError, true);
  },
});

export const sessionPresentation = createToolPresentation({
  call: (args) => `session ${text(args.action)}${args.sessionId ? ` ${text(args.sessionId)}` : args.backend ? ` ${text(args.backend)}` : ""}`,
  result(result, options, context) {
    const body = savedText(result);
    if (context.isError) return failure(body, options.isPartial);
    const details = record(result.details);
    const snapshot = record(details.snapshot);
    const action = text(context.args?.action);
    const entries = Array.isArray(details.sessions) ? details.sessions.map(record) : [];
    const notices: string[] = [];
    if (options.isPartial) notices.push("Partial action · not confirmed");
    for (const entry of [snapshot, ...entries]) {
      if (entry.state === "tainted" || entry.taintReason) notices.push(`Tainted ${text(entry.id)}: ${text(entry.taintReason) || "reason not recorded"}`);
    }
    let summary = "Returned session result";
    let lines: string[] = [];
    if (action === "capabilities" && Array.isArray(details.capabilities)) {
      summary = "Session capabilities";
      lines = details.capabilities.map(record).map((entry) => `${text(entry.backend)}: PTY ${entry.pty === true ? "yes" : "no"}, input ${entry.input === true ? "yes" : "no"}`);
    } else if (snapshot.id) {
      const actionState = action === "input" ? "Input queued" : action === "interrupt" ? "Interrupt requested" : action === "open" ? "Opened" : "State";
      summary = `${actionState} · ${text(snapshot.state) || "unknown"}`;
      lines = [`${text(snapshot.id)} · ${text(snapshot.backend)}`, `cwd: ${text(snapshot.cwd) || "not recorded"}`];
      if (options.expanded && snapshot.generation !== undefined) lines.push(`generation: ${snapshot.generation}`);
    } else if (action === "list" && Array.isArray(details.sessions)) {
      summary = `${entries.length} live sessions`;
      lines = entries.map((entry) => `${text(entry.id)} · ${text(entry.backend)} · ${text(entry.state)}`);
    } else if (action === "close" && /^Closed session /m.test(body)) {
      summary = "Session closed";
    } else {
      lines = body.split("\n");
    }
    return { summary, notices, lines, omitted: Object.keys(details).length > 0 };
  },
});
