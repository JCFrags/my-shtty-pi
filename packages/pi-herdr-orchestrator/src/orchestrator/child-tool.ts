import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChannelStore, ChannelStoreError } from "./channel-store.js";
import { HerdrCli, HerdrCliError } from "./herdr-cli.js";
import { readRegistryByDomain, RegistryError } from "./store.js";
import type {
  AgentRecord,
  ChannelEvent,
  CompletionStatus,
  JsonObject,
  RunRecord,
} from "./types.js";
const MAX_SUMMARY = 2048,
  MAX_MESSAGE = 4096,
  MAX_RESULT = 16384;
const string = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const assignment = {
  runId: string(128),
  assignmentGeneration: { type: "integer", minimum: 1 },
};
const SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "runId", "assignmentGeneration", "summary"],
      properties: {
        action: { const: "progress" },
        ...assignment,
        summary: string(MAX_SUMMARY),
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "action",
        "runId",
        "assignmentGeneration",
        "target",
        "message",
      ],
      properties: {
        action: { const: "send" },
        ...assignment,
        target: string(128),
        message: string(MAX_MESSAGE),
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "runId", "assignmentGeneration", "summary"],
      properties: {
        action: { const: "acknowledge_cancel" },
        ...assignment,
        summary: string(4096),
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "action",
        "runId",
        "assignmentGeneration",
        "status",
        "summary",
      ],
      properties: {
        action: { const: "complete" },
        ...assignment,
        status: { enum: ["completed", "failed"] },
        summary: string(4096),
        finalResult: string(MAX_RESULT),
      },
    },
  ],
} as const;
type PiContext = { cwd: string };
type Tool = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
  execute(
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    update: unknown,
    context: PiContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: JsonObject;
  }>;
};
type Api = { registerTool(tool: Tool): void };
class ChildError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ChildError";
  }
}
const object = (v: unknown): JsonObject | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as JsonObject)
    : undefined;
function value(v: unknown, max: number): string {
  if (
    typeof v !== "string" ||
    !v.length ||
    Buffer.byteLength(v) > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)
  )
    throw new ChildError("INVALID_REQUEST");
  return v;
}
const id = (v: JsonObject, k: string): string | undefined =>
  typeof v[k] === "string" ? (v[k] as string) : undefined;
function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new ChildError("CHILD_CONTEXT_INCOMPLETE");
  return v;
}
function publicError(e: unknown): ChildError {
  if (e instanceof ChildError) return e;
  if (
    e instanceof ChannelStoreError ||
    e instanceof RegistryError ||
    e instanceof HerdrCliError
  )
    return new ChildError(e.code);
  return new ChildError("CHILD_OPERATION_FAILED");
}
async function context(p: JsonObject): Promise<{
  agent: AgentRecord;
  run: RunRecord;
  cli: HerdrCli;
  store: ChannelStore;
}> {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH)
    throw new ChildError("NOT_IN_HERDR");
  const domainId = env("PI_HERDR_DOMAIN_ID"),
    agentId = env("PI_HERDR_AGENT_ID");
  if (env("PI_HERDR_AGENT_GENERATION") !== "1")
    throw new ChildError("GENERATION_MISMATCH");
  const runId = value(p.runId, 128),
    generation = p.assignmentGeneration;
  if (!Number.isSafeInteger(generation) || Number(generation) < 1)
    throw new ChildError("INVALID_REQUEST");
  const registry = await readRegistryByDomain(domainId),
    agent = registry.agents.find((a) => a.agentId === agentId);
  if (!agent || agent.agentGeneration !== 1)
    throw new ChildError("CHILD_IDENTITY_MISMATCH");
  if (agent.runId !== runId || agent.assignmentGeneration !== generation)
    throw new ChildError("STALE_ASSIGNMENT");
  const run = agent.runs.find(
    (r) => r.runId === runId && r.assignmentGeneration === generation,
  );
  if (!run) throw new ChildError("STALE_ASSIGNMENT");
  if (
    agent.workspaceId !== env("HERDR_WORKSPACE_ID") ||
    agent.tabId !== env("HERDR_TAB_ID") ||
    agent.paneId !== env("HERDR_PANE_ID")
  )
    throw new ChildError("CHILD_IDENTITY_MISMATCH");
  const cli = new HerdrCli(),
    [current, herdrAgent, pane] = await Promise.all([
      cli.paneCurrent(),
      cli.agentGet(agent.herdrAgentName),
      cli.paneGet(agent.paneId),
    ]);
  for (const candidate of [current, herdrAgent, pane])
    if (
      id(candidate, "workspace_id") !== agent.workspaceId ||
      id(candidate, "tab_id") !== agent.tabId ||
      id(candidate, "pane_id") !== agent.paneId
    )
      throw new ChildError("CHILD_IDENTITY_MISMATCH");
  if (id(herdrAgent, "name") !== agent.herdrAgentName)
    throw new ChildError("CHILD_IDENTITY_MISMATCH");
  return { agent, run, cli, store: new ChannelStore(domainId) };
}
async function validateTarget(cli: HerdrCli, target: AgentRecord) {
  const [a, p] = await Promise.all([
    cli.agentGet(target.herdrAgentName),
    cli.paneGet(target.paneId),
  ]);
  for (const v of [a, p])
    if (
      id(v, "workspace_id") !== target.workspaceId ||
      id(v, "tab_id") !== target.tabId ||
      id(v, "pane_id") !== target.paneId
    )
      throw new ChildError("TARGET_IDENTITY_MISMATCH");
  if (id(a, "name") !== target.herdrAgentName)
    throw new ChildError("TARGET_IDENTITY_MISMATCH");
}
async function append(
  c: Awaited<ReturnType<typeof context>>,
  kind: "progress" | "message",
  target: string,
  summary: string,
): Promise<ChannelEvent> {
  return c.store.appendEvent(
    {
      version: 2,
      kind,
      domainId: c.agent.domainId,
      agentId: c.agent.agentId,
      runId: c.run.runId,
      agentGeneration: c.agent.agentGeneration,
      assignmentGeneration: c.run.assignmentGeneration,
      target,
      summary,
      createdAt: new Date().toISOString(),
    },
    c.run.deliveredSequence,
  );
}
async function execute(raw: unknown): Promise<JsonObject> {
  const p = object(raw) ?? {},
    action = p.action;
  if (
    action !== "progress" &&
    action !== "send" &&
    action !== "acknowledge_cancel" &&
    action !== "complete"
  )
    throw new ChildError("INVALID_REQUEST");
  const c = await context(p);
  if (action === "progress") {
    if (c.run.phase === "cancel_requested")
      throw new ChildError("CANCEL_REQUESTED");
    if (await c.store.result(c.run.runId))
      throw new ChildError("RUN_ALREADY_TERMINAL");
    const e = await append(
      c,
      "progress",
      "parent",
      value(p.summary, MAX_SUMMARY),
    );
    return {
      ok: true,
      action,
      runId: e.runId,
      assignmentGeneration: e.assignmentGeneration,
      eventSequence: e.sequence,
      createdAt: e.createdAt,
    };
  }
  if (action === "send") {
    const target = value(p.target, 128),
      message = value(p.message, MAX_MESSAGE);
    if (target !== "parent") {
      const registry = await readRegistryByDomain(c.agent.domainId),
        recipient = registry.agents.find((a) => a.agentId === target);
      if (
        !recipient ||
        recipient.processState === "closed" ||
        recipient.processState === "failed"
      )
        throw new ChildError("TARGET_NOT_AVAILABLE");
      await validateTarget(c.cli, recipient);
      await c.cli.agentPrompt(
        recipient.herdrAgentName,
        `[subagent message from ${c.agent.agentId}; run ${c.run.runId}; assignment ${c.run.assignmentGeneration}] ${message}`,
      );
    }
    const e = await append(c, "message", target, message);
    return {
      ok: true,
      action,
      runId: e.runId,
      assignmentGeneration: e.assignmentGeneration,
      eventSequence: e.sequence,
      target,
      createdAt: e.createdAt,
    };
  }
  if (action === "acknowledge_cancel") {
    if (c.run.phase !== "cancel_requested" || !c.run.cancelRequestedAt)
      throw new ChildError("CANCEL_NOT_REQUESTED");
    const settled = await c.store.cancel({
      version: 2,
      domainId: c.agent.domainId,
      agentId: c.agent.agentId,
      runId: c.run.runId,
      agentGeneration: c.agent.agentGeneration,
      assignmentGeneration: c.run.assignmentGeneration,
      status: "cancelled",
      summary: value(p.summary, 4096),
      finalResult: null,
    });
    return {
      ok: true,
      action,
      status: settled.result.status,
      runId: c.run.runId,
      assignmentGeneration: c.run.assignmentGeneration,
      completedAt: settled.result.completedAt,
      acknowledged: settled.result.status === "cancelled",
      raceLost: settled.result.status !== "cancelled",
    };
  }
  const status = p.status as CompletionStatus;
  if (status !== "completed" && status !== "failed")
    throw new ChildError("INVALID_REQUEST");
  const completed = await c.store.complete({
    version: 2,
    domainId: c.agent.domainId,
    agentId: c.agent.agentId,
    runId: c.run.runId,
    agentGeneration: c.agent.agentGeneration,
    assignmentGeneration: c.run.assignmentGeneration,
    status,
    summary: value(p.summary, 4096),
    finalResult:
      p.finalResult === undefined ? null : value(p.finalResult, MAX_RESULT),
  });
  return {
    ok: true,
    action,
    status,
    runId: c.run.runId,
    assignmentGeneration: c.run.assignmentGeneration,
    completedAt: completed.result.completedAt,
    duplicate: completed.duplicate,
  };
}
export function registerSubagentChannel(api: ExtensionAPI): void {
  const tool: Tool = {
    name: "subagent_channel",
    label: "Subagent Channel",
    parameters: SCHEMA as unknown,
    description:
      "Report progress, send a message, acknowledge a requested cancellation, or explicitly complete the exact assigned run. Every call requires the current run ID and assignment generation; stale assignments are rejected.",
    promptSnippet:
      "Use subagent_channel with the exact runId and assignmentGeneration from the latest assignment prompt; acknowledge cancellation only after the parent requests it.",
    async execute(_id, params) {
      try {
        const result = await execute(params);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch (e) {
        throw publicError(e);
      }
    },
  };
  (api as unknown as Api).registerTool(tool);
}
