import {
  createToolPresentation,
  type PresentationContext,
  type PresentationOptions,
  type PresentationResult,
  type PresentationView,
} from "pi-tool-controls/presentation";

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): string => Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : "?";
const shortId = (value: unknown): string => {
  const id = text(value);
  return /^[ar]-[0-9a-f-]{36}$/u.test(id) ? `${id.slice(0, 10)}…` : id;
};
const identity = (row: Row): string => text(row.label) || shortId(row.runId) || shortId(row.agentId) || "unknown ID";
const terminalStatus = (value: unknown): string =>
  ["completed", "failed", "cancelled"].includes(text(value)) ? text(value) : "";
const phase = (value: unknown): string =>
  ["starting", "running", "cancel_requested", "completed", "failed", "cancelled", "unknown"].includes(text(value))
    ? text(value).replace("cancel_requested", "cancel requested") : "unknown";
const runState = (row: Row): string => terminalStatus(record(row.terminal ?? row.explicitTerminal).status)
  || phase(row.phase ?? row.delegatedRunPhase);
const tone = (state: string): PresentationView["tone"] => state === "failed" ? "error"
  : state === "completed" ? "success" : "warning";

function view(summary: string, notices: string[] = [], lines: string[] = [], color: PresentationView["tone"] = "muted"): PresentationView {
  // IDs, timestamps, and other saved fields remain available in the raw export.
  return { summary, notices, lines, omitted: true, tone: color };
}

function unknown(result: PresentationResult, reason = "Missing or malformed saved details"): PresentationView {
  // Saved prose is only an excerpt. Never interpret it as an outcome or parse it as a new result.
  const saved = result.content.filter(item => item.type === "text" && typeof item.text === "string")
    .map(item => item.text).join("\n").slice(0, 4096);
  return view("Unknown outcome", [reason, "Saved-text preview only; no status inferred."], saved ? [saved] : [], "warning");
}

function callTitle(name: string, args: Row): string {
  const action = text(args.action) || "unknown action";
  const target = text(args.label) || (Array.isArray(args.runIds) ? `${args.runIds.length} runs`
    : shortId(args.runId) || shortId(args.agentId));
  const status = name === "subagent_channel" && action === "complete" ? ` ${text(args.status)}` : "";
  return `${name} ${action}${status}${target ? ` · ${target}` : ""}`;
}

function agentAlerts(row: Row): string[] {
  const notices: string[] = [];
  if (!["live", "starting", "closed"].includes(text(row.processState)))
    notices.push(`Process ${text(row.processState) === "missing" ? "missing" : text(row.processState) === "failed" ? "failed" : "unknown"}`);
  if (row.identityState !== undefined && row.identityState !== "present")
    notices.push(`Identity ${["absent", "mismatch"].includes(text(row.identityState)) ? text(row.identityState) : "unknown"}`);
  return notices;
}

function agentLine(row: Row): string {
  return `${identity(row)} · run ${runState(row)} · process ${text(row.processState) || "unknown"} · identity ${text(row.identityState) || "not returned"} · attention ${text(row.herdrAttention) || "unknown"} (not a result)`;
}

function runLines(row: Row): string[] {
  const terminal = text(record(row.terminal ?? row.explicitTerminal).summary);
  const progress = text(record(row.latestProgress).summary);
  return [terminal ? `Terminal summary: ${terminal}` : "", progress ? `Progress: ${progress}` : ""].filter(Boolean);
}

function totals(values: string[]): string {
  // Aggregate all supplied rows before the helper limits the visible excerpts.
  return ["failed", "cancelled", "unknown", "cancel requested", "completed", "running", "starting"]
    .map(state => [state, values.filter(value => value === state).length] as const)
    .filter(([, n]) => n > 0).map(([state, n]) => `${n} ${state}`).join(", ");
}

function agentsView(data: Row, expanded: boolean): PresentationView | undefined {
  if (!Array.isArray(data.agents)) return undefined;
  const rows = data.agents.map(record);
  const states = rows.map(runState);
  const notices: string[] = [];
  const processCounts = ["failed", "missing", "closed", "unknown"].map(state => {
    const n = rows.filter(row => (["live", "starting", "closed", "failed", "missing"].includes(text(row.processState))
      ? row.processState : "unknown") === state).length;
    return n ? `${n} ${state}` : "";
  }).filter(Boolean);
  const identityCounts = ["mismatch", "absent", "unknown"].map(state => {
    const n = rows.filter(row => (row.recoveryStatus === "identity-mismatch" ? "mismatch"
      : ["present", "absent", "mismatch"].includes(text(row.identityState)) ? row.identityState : "unknown") === state).length;
    return n ? `${n} ${state}` : "";
  }).filter(Boolean);
  if (identityCounts.length) notices.push(`Identity: ${identityCounts.join(", ")}`);
  if (processCounts.length) notices.push(`Processes: ${processCounts.join(", ")}`);
  if (data.managedTabState && data.managedTabState !== "live") notices.push(`Managed tab: ${text(data.managedTabState)}`);
  notices.push(`Source: ${rows.length}/${count(data.trackedAgentCount)} agents${data.truncated === true ? "; truncated" : data.truncated !== false ? "; coverage unknown" : ""}`);
  notices.push("Returned summaries only; progress capped at 256 characters.");
  const alerts = states.some(state => ["failed", "unknown", "cancel requested", "cancelled"].includes(state))
    || identityCounts.length > 0 || processCounts.length > 0;
  return view(`${rows.length} agents · ${totals(states) || "none returned"}`, notices,
    expanded ? rows.flatMap(row => [agentLine(row), ...runLines(row)]) : [],
    states.includes("failed") ? "error" : alerts ? "warning" : "muted");
}

function waitView(data: Row, expanded: boolean): PresentationView | undefined {
  if (!Array.isArray(data.events) || !Array.isArray(data.results) || typeof data.timedOut !== "boolean") return undefined;
  const events = data.events.map(record), results = data.results.map(record);
  if (data.timedOut && (events.length || results.length)) return undefined;
  if (data.timedOut) return view("Wait timed out; no fresh delivery", ["Timeout does not stop the child."], [], "warning");
  const states = results.map(row => terminalStatus(row.status) || "unknown");
  const notices = [`${events.length} events, ${results.length} terminals; summaries only.`, "Use collect for saved final results; events are not results."];
  if (events.some(row => !["progress", "message"].includes(text(row.kind)))) notices.unshift("Unknown event records returned.");
  if (events.length >= 24) notices.push("Event source capped at 24; backlog coverage unknown.");
  return view(totals(states) || (events.length ? "Event delivery; no terminal results returned" : "No fresh delivery; outcome unknown"), notices,
    expanded ? [
      ...results.map(row => `Terminal ${terminalStatus(row.status) || "unknown"} ${shortId(row.runId)}: ${text(row.summary)}`),
      ...events.map(row => `Event ${text(row.kind) || "unknown"} ${shortId(row.runId)}: ${text(row.summary)}`),
    ] : [], states.includes("failed") ? "error" : states.some(state => state !== "completed") ? "warning" : "muted");
}

function inspectView(data: Row, args: Row, expanded: boolean): PresentationView {
  const requested = text(data.requestedRunId) || text(args.runId) || text(data.runId);
  const supplied = record(data.selectedRun);
  // The top-level agent and pane belong to the current assignment, not a historical request.
  const selected = requested && supplied.runId === requested ? supplied : {};
  const state = runState(selected);
  const notices = agentAlerts(data);
  if (!selected.runId) notices.unshift("Requested run data missing; current run is not a substitute.");
  if (requested !== data.runId) notices.push(`Current assignment ${shortId(data.runId) || "unknown"} is separate.`);
  if (data.historyTruncated === true) notices.push(`Source history truncated to ${count(data.recentRunLimit)} runs.`);
  notices.push("Run summaries only; use collect for finalResult.");
  notices.push("Current pane excerpt only; not requested-run evidence.");
  const pane = text(data.recentOutput);
  return view(`Requested run ${state} · ${shortId(requested) || "unknown ID"}`, notices,
    expanded ? [
      ...runLines(selected),
      `Current agent: ${agentLine(data)}`,
      `Current pane ${shortId(data.runId)} (bounded excerpt):\n${pane || "[no output; not completion]"}`,
    ] : [], tone(state));
}

function cancelView(data: Row, child: boolean): PresentationView | undefined {
  const status = terminalStatus(data.status);
  const confirmed = child ? data.acknowledged : data.confirmed;
  if (!child && data.status === "cancel_requested" && confirmed === false && data.cancelled === false && data.raceLost === false)
    return view("Cancellation requested; unconfirmed", ["Request is not confirmed child termination."], [], "warning");
  if (status === "cancelled" && confirmed === true && data.raceLost === false && (child || data.cancelled === true))
    return view("Cancellation confirmed · run cancelled", [], [], "warning");
  if (["completed", "failed"].includes(status) && data.raceLost === true && (child ? confirmed === false : confirmed === true && data.cancelled === false))
    return view(`Cancellation lost race · work ${status}`, ["Earlier terminal result preserved; not cancellation success."], [], tone(status));
  return undefined;
}

function rootView(data: Row, args: Row, expanded: boolean): PresentationView | undefined {
  switch (data.action ?? args.action) {
    case "list":
    case "recover": return agentsView(data, expanded);
    case "wait": return waitView(data, expanded);
    case "inspect": return inspectView(data, args, expanded);
    case "collect": {
      const state = terminalStatus(data.status);
      if (!state) return undefined;
      const finalResult = text(data.finalResult);
      return view(`Work ${state} · ${identity(data)}`, finalResult ? [] : ["Summary only; no finalResult saved."],
        expanded ? [text(data.summary), finalResult].filter(Boolean) : [], tone(state));
    }
    case "cancel": return cancelView(data, false);
    case "close": {
      if (data.processState !== "closed" || typeof data.alreadyAbsent !== "boolean") return undefined;
      const state = terminalStatus(record(data.explicitTerminal).status);
      return view(`Pane ${data.alreadyAbsent ? "already absent" : "closed"} · work ${state || "unknown"}`,
        [state ? "Terminal outcome preserved; close is not completion." : "No explicit terminal result; work outcome unknown."],
        expanded ? runLines(data) : [], tone(state));
    }
    case "health": {
      const state = text(data.managedTabState);
      if (!["live", "absent", "missing", "mismatch"].includes(state)) return undefined;
      return view(`Health reported · managed tab ${state}`, [],
        expanded ? [`${count(data.trackedAgentCount)} tracked agents; ${count(data.managedActivePaneCount)}/${count(data.capacityLimit)} active panes`] : [],
        state === "mismatch" || state === "missing" ? "warning" : "muted");
    }
    case "run":
    case "spawn":
    case "reuse":
    case "send": {
      if (!text(data.runId) || !text(data.processState)) return undefined;
      const sending = (data.action ?? args.action) === "send";
      return view(`${sending ? "Message delivered" : "Assignment started"} · run ${runState(data)} · ${identity(data)}`,
        [...agentAlerts(data), "Delivery is not completed work."],
        expanded ? [agentLine(data), ...runLines(data), ...(sending && text(args.message) ? [`Sent message: ${text(args.message)}`] : [])] : [],
        data.processState === "failed" ? "error" : agentAlerts(data).length ? "warning" : "muted");
    }
  }
  return undefined;
}

function childView(data: Row, args: Row, expanded: boolean): PresentationView | undefined {
  switch (data.action ?? args.action) {
    case "progress":
    case "send": {
      if (!Number.isSafeInteger(data.eventSequence) || !text(data.runId)) return undefined;
      const sending = (data.action ?? args.action) === "send";
      return view(`${sending ? "Message delivered" : "Progress recorded"} · ${identity(data)}`,
        ["Recording or delivery is not completed work."], expanded
          ? [sending ? `Target ${shortId(data.target)}: ${text(args.message)}` : `Reported progress: ${text(args.summary)}`] : []);
    }
    case "acknowledge_cancel": {
      const cancellation = cancelView(data, true);
      return cancellation && expanded && text(args.summary)
        ? { ...cancellation, lines: [`Submitted cancellation summary: ${text(args.summary)}`] } : cancellation;
    }
    case "complete": {
      const state = terminalStatus(data.status);
      if (!["completed", "failed"].includes(state) || typeof data.duplicate !== "boolean") return undefined;
      const finalResult = text(args.finalResult);
      return view(`Work ${state} · ${data.duplicate ? "already recorded" : "completion recorded"}`,
        finalResult ? [] : ["Summary only; no finalResult supplied."],
        expanded ? [text(args.summary), finalResult].filter(Boolean) : [], tone(state));
    }
  }
  return undefined;
}

function project(result: PresentationResult, options: PresentationOptions, context: PresentationContext, child: boolean): PresentationView {
  const data = record(result.details);
  let projected: PresentationView;
  if (context.isError || data.ok === false) {
    projected = unknown(result, text(data.errorCode) || "Operation refused or failed; work outcome not established.");
    projected.summary = context.isError ? "Tool error" : "Operation refused";
    projected.tone = "error";
  } else if (data.ok !== true || (data.action !== undefined && data.action !== context.args.action)) {
    projected = unknown(result);
  } else {
    projected = (child ? childView(data, context.args, options.expanded) : rootView(data, context.args, options.expanded)) ?? unknown(result);
  }
  if (options.isPartial) return {
    ...projected,
    summary: `Partial · ${projected.summary}`,
    notices: ["Non-final tool display; do not infer a settled outcome.", ...projected.notices ?? []],
  };
  return projected;
}

export const orchestratePresentation = createToolPresentation({
  call: args => callTitle("orchestrate", args),
  result: (result, options, context) => project(result, options, context, false),
});
export const subagentChannelPresentation = createToolPresentation({
  call: args => callTitle("subagent_channel", args),
  result: (result, options, context) => project(result, options, context, true),
});
