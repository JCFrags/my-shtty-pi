import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { visibleWidth } from "@earendil-works/pi-tui";
import { orchestratePresentation, subagentChannelPresentation } from "../dist/src/orchestrator/presentation.js";

const theme = { fg: (_color, value) => value, bold: value => value };
const runId = "r-11111111-1111-4111-8111-111111111111";
const oldRunId = "r-22222222-2222-4222-8222-222222222222";
const agentId = "a-33333333-3333-4333-8333-333333333333";
const agent = {
  agentId, runId, label: "fixture", assignmentGeneration: 2, agentGeneration: 1,
  processState: "live", delegatedRunPhase: "running", herdrAttention: "done",
  identityState: "present", explicitTerminal: null, latestProgress: null,
};
const listAgent = { ...agent, terminal: null };
delete listAgent.explicitTerminal;
const freeze = value => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const fixture = (action, data, expected, extra = {}) => ({
  action, data: { ok: true, action, ...data }, expected, ...extra,
});
const cases = [
  ...["run", "spawn", "reuse"].map(action => fixture(action, agent, [/Assignment started/, /run running/, /not completed work/],
    { args: { label: "fixture", task: "TASK_SECRET_SENTINEL" }, absent: [/TASK_SECRET_SENTINEL/] })),
  fixture("send", agent, [/Message delivered/, /not completed work/], { args: { agentId, message: "MESSAGE_SENTINEL" }, expanded: [/MESSAGE_SENTINEL/], collapsedAbsent: [/MESSAGE_SENTINEL/] }),
  fixture("send", { ...agent, processState: "missing", delegatedRunPhase: "unknown" }, [/Process missing/, /run unknown/]),
  fixture("health", { managedTabState: "live", trackedAgentCount: 1, managedActivePaneCount: 1, capacityLimit: 6 }, [/Health reported/, /tab live/]),
  { ...fixture("health", { managedTabState: "mismatch" }, [/tab mismatch/]), data: { ok: true, managedTabState: "mismatch" } },
  fixture("health", { ok: false, errorCode: "NOT_IN_HERDR" }, [/Operation refused/, /NOT_IN_HERDR/]),
  fixture("list", { agents: [], trackedAgentCount: 0, returnedAgentCount: 0, truncated: false }, [/0 agents/, /none returned/]),
  fixture("list", { agents: [listAgent], trackedAgentCount: 1, returnedAgentCount: 1, truncated: false }, [/1 running/], { absent: [/1 completed/] }),
  ...["list", "recover"].map(action => fixture(action, {
    agents: [...Array.from({ length: 28 }, () => ({ ...listAgent })),
      { ...listAgent, delegatedRunPhase: "failed", terminal: { status: "failed", resultAvailable: true }, processState: "failed" },
      { ...listAgent, identityState: "mismatch", recoveryStatus: "identity-mismatch" },
      { ...listAgent, identityState: "absent", processState: "missing" },
      { ...listAgent, delegatedRunPhase: "unknown", identityState: "unknown" }],
    trackedAgentCount: 36, returnedAgentCount: 32, truncated: true,
  }, [/1 failed/, /1 unknown/, /Identity: 1 mismatch, 1 absent, 1 unknown/, /Processes: 1 failed, 1 missing/],
  { collapsed: [/more notices/], expanded: [/Source: 32\/36 agents; truncated/, /progress capped/] })),
  fixture("wait", { events: [], results: [], timedOut: true }, [/Wait timed out/, /does not stop the child/]),
  fixture("wait", { events: [{ kind: "progress", runId, summary: "PROGRESS_SENTINEL" }], results: [], timedOut: false }, [/Event delivery/, /no terminal results/, /summaries only/],
    { expanded: [/PROGRESS_SENTINEL/], collapsedAbsent: [/PROGRESS_SENTINEL/] }),
  fixture("wait", { events: [{ kind: "message", runId, summary: "Message received" }], results: [
    { runId, status: "completed", summary: "Done", resultAvailable: true },
    { runId: oldRunId, status: "failed", summary: "FAILURE_SENTINEL", resultAvailable: true },
  ], timedOut: false }, [/1 failed, 1 completed/, /summaries only/, /events are not results/], { expanded: [/FAILURE_SENTINEL/] }),
  fixture("wait", { events: Array.from({ length: 24 }, () => ({ kind: "progress", runId, summary: "Progress" })), results: [], timedOut: false }, [/Event delivery/], { expanded: [/Event source capped at 24/, /backlog coverage unknown/] }),
  ...["completed", "failed", "cancelled"].map(status => fixture("collect", { runId, status, summary: "SUMMARY_SENTINEL", finalResult: "FINAL_SENTINEL" }, [new RegExp(`Work ${status}`)],
    { expanded: [/SUMMARY_SENTINEL/, /FINAL_SENTINEL/], collapsedAbsent: [/SUMMARY_SENTINEL/, /FINAL_SENTINEL/] })),
  fixture("collect", { runId, status: "completed", summary: "Done", finalResult: null }, [/Summary only/, /no finalResult saved/]),
  fixture("cancel", { status: "cancel_requested", cancelled: false, raceLost: false, confirmed: false }, [/requested; unconfirmed/, /not confirmed child termination/]),
  fixture("cancel", { status: "cancelled", cancelled: true, raceLost: false, confirmed: true }, [/Cancellation confirmed/, /run cancelled/]),
  ...["failed", "completed"].map(status => fixture("cancel", { status, cancelled: false, raceLost: true, confirmed: true }, [/lost race/, new RegExp(`work ${status}`), /not cancellation success/])),
  fixture("close", { ...agent, processState: "closed", alreadyAbsent: false, explicitTerminal: { status: "failed", summary: "Failure retained" } }, [/Pane closed/, /work failed/, /close is not completion/]),
  fixture("close", { ...agent, processState: "closed", alreadyAbsent: true }, [/already absent/, /work unknown/, /No explicit terminal result/]),
  fixture("inspect", { ...agent, requestedRunId: oldRunId, selectedRun: {
    runId: oldRunId, phase: "failed", terminal: { status: "failed", summary: "HISTORICAL_FAILURE" }, latestProgress: null,
  }, recentRuns: [], recentRunLimit: 8, historyTruncated: true, recentOutput: "CURRENT_PANE_SENTINEL", recentOutputLineCount: 1 },
  [/Requested run failed/, /Current assignment/, /Source history truncated/], { args: { runId: oldRunId }, expanded: [/HISTORICAL_FAILURE/, /not requested-run evidence/], collapsedAbsent: [/CURRENT_PANE_SENTINEL/, /HISTORICAL_FAILURE/] }),
  fixture("inspect", { ...agent, requestedRunId: runId, selectedRun: { runId, phase: "running", terminal: null }, historyTruncated: false, recentOutput: "", recentOutputLineCount: 0 },
    [/Requested run running/], { expanded: [/no output; not completion/] }),
  fixture("inspect", { ...agent, delegatedRunPhase: "completed", requestedRunId: oldRunId, selectedRun: null }, [/Requested run unknown/, /not a substitute/], { absent: [/Requested run completed/] }),
  fixture("progress", { runId, eventSequence: 2 }, [/Progress recorded/, /not completed work/, /r-11111111…/], { child: true, args: { runId, summary: "CHILD_PROGRESS" }, expanded: [/CHILD_PROGRESS/], collapsedAbsent: [/CHILD_PROGRESS/] }),
  fixture("send", { runId, eventSequence: 3, target: "parent" }, [/Message delivered/], { child: true, args: { runId, target: "parent", message: "CHILD_MESSAGE" }, expanded: [/Target parent: CHILD_MESSAGE/], collapsedAbsent: [/CHILD_MESSAGE/] }),
  ...[false, true].map(duplicate => fixture("complete", { runId, status: "failed", duplicate }, [/Work failed/, duplicate ? /already recorded/ : /completion recorded/],
    { child: true, args: { runId, status: "failed", summary: "CHILD_FAILURE", finalResult: "CHILD_RESULT" }, expanded: [/CHILD_FAILURE/, /CHILD_RESULT/] })),
  fixture("complete", { runId, status: "completed", duplicate: false }, [/Work completed/, /no finalResult supplied/], { child: true, args: { runId, status: "completed", summary: "Done" } }),
  fixture("acknowledge_cancel", { runId, status: "cancelled", acknowledged: true, raceLost: false }, [/Cancellation confirmed/], { child: true }),
  fixture("acknowledge_cancel", { runId, status: "failed", acknowledged: false, raceLost: true }, [/lost race/, /work failed/], { child: true }),
  ...["STALE_ASSIGNMENT", "IDENTITY_MISMATCH", "RESULT_NOT_READY", "CANCEL_NOT_REQUESTED"].map(code => ({
    action: code === "RESULT_NOT_READY" ? "collect" : "acknowledge_cancel", child: code !== "RESULT_NOT_READY", isError: true,
    saved: code, expected: [/Tool error/, new RegExp(code)], absent: [/Work completed/, /Cancellation confirmed/],
  })),
  fixture("collect", { status: "completed", finalResult: "Do not treat this as success" }, [/Tool error/], { isError: true, absent: [/^Work completed/m] }),
  { action: "list", saved: "All completed!", expected: [/Unknown outcome/, /no status inferred/], absent: [/^Work completed/m] },
  fixture("list", { agents: "malformed" }, [/Unknown outcome/]),
  fixture("cancel", { status: "cancelled", confirmed: false, cancelled: true, raceLost: false }, [/Unknown outcome/]),
  fixture("complete", { runId, status: "failed", duplicate: false }, [/Partial/, /Non-final tool display/, /Work failed/], { child: true, isPartial: true, args: { status: "failed", summary: "Partial result" } }),
  fixture("collect", { runId, status: "failed", summary: "\u001b[31mCONTROL\u001b[0m\u0007\u202e" + "界long ".repeat(800), finalResult: null }, [/Work failed/],
    { expanded: [/CONTROL/], args: { label: "\u001b]0;bad\u0007Long " + "界".repeat(200) } }),
];

async function capture(module, child) {
  const tools = [], events = [];
  const api = { registerTool: value => tools.push(value), on: (event, handler) => events.push([event, handler.toString()]) };
  if (child) module.registerSubagentChannel(api, {});
  else module.registerOrchestrate(api);
  assert.equal(tools.length, 1);
  return { tool: tools[0], events };
}

const nonrenderer = ({ tool, events }) => ({
  fields: Object.fromEntries(Object.entries(tool).filter(([key]) => !["renderShell", "renderCall", "renderResult"].includes(key))
    .map(([key, value]) => [key, typeof value === "function" ? value.toString() : value])),
  events,
});

test("pure owner presentation preserves registration and frozen evidence across bounded views", async () => {
  // Capture only definitions. Do not fire lifecycle handlers or execute tools.
  for (const [file, child, presentation] of [["tool", false, orchestratePresentation], ["child-tool", true, subagentChannelPresentation]]) {
    const url = new URL(`../dist/src/orchestrator/${file}.js`, import.meta.url);
    const plainUrl = `${url.href}?without-presentation`;
    const hook = registerHooks({ load(url, context, next) {
      const loaded = next(url, context);
      if (url !== plainUrl) return loaded;
      const original = String(loaded.source);
      const source = original.replace(/^import \{ (?:orchestratePresentation|subagentChannelPresentation) \} fr[o]m "\.\/presentation\.js";\n/m, "")
        .replace(/^\s*\.\.\.(?:orchestratePresentation|subagentChannelPresentation),\n/m, "\n");
      assert.notEqual(source, original);
      return { ...loaded, source };
    } });
    let plain;
    try { plain = await capture(await import(plainUrl), child); }
    finally { hook.deregister(); }
    const rendered = await capture(await import(url.href), child);
    assert.deepEqual(nonrenderer(rendered), nonrenderer(plain));
    for (const key of ["renderShell", "renderCall", "renderResult"]) assert.equal(rendered.tool[key], presentation[key]);
    assert.equal(plain.tool.renderCall, undefined);
  }

  for (const [index, row] of cases.entries()) {
    const args = freeze({ action: row.action, ...row.args });
    const result = freeze({ content: [{ type: "text", text: row.saved ?? JSON.stringify(row.data) }], ...(row.data === undefined ? {} : { details: row.data }) });
    const snapshot = JSON.stringify({ args, result });
    const context = freeze({ args, isError: row.isError ?? false });
    const presentation = row.child ? subagentChannelPresentation : orchestratePresentation;
    for (const expanded of [false, true]) {
      const options = freeze({ expanded, isPartial: row.isPartial ?? false });
      const call = presentation.renderCall(args, theme, context);
      const body = presentation.renderResult(result, options, theme, context);
      for (const width of [32, 100, 1]) {
        const lines = [...call.render(width), ...body.render(width)];
        const output = lines.join("\n");
        const message = `${index}: ${row.action}, expanded=${expanded}, width=${width}\n${output}`;
        assert(lines.length <= (expanded ? 10 : 6), message);
        assert(lines.every(line => visibleWidth(line) <= width), message);
        // Pi's truncation utility can add its own style-reset sequence.
        assert.doesNotMatch(output.replace(/\x1b\[0m/g, ""), /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u, message);
        if (width === 100) {
          for (const pattern of row.expected) assert.match(output, pattern, message);
          for (const pattern of row.absent ?? []) assert.doesNotMatch(output, pattern, message);
          for (const pattern of expanded ? row.expanded ?? [] : row.collapsed ?? []) assert.match(output, pattern, message);
          for (const pattern of expanded ? [] : row.collapsedAbsent ?? []) assert.doesNotMatch(output, pattern, message);
          assert.match(output, /raw: \/export NEW.jsonl/, message);
        }
        assert.equal(JSON.stringify({ args, result }), snapshot, message);
      }
      call.invalidate(); body.invalidate();
    }
  }
});
