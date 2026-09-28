import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChannelStore, ChannelStoreError } from "./channel-store.js";
import { ChildBinding, ChildBindingError, type ChildContext } from "./child-binding.js";
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
type PiContext = ChildContext & { cwd: string };
type Tool = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
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
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "ChildError";
  }
}
const BINDING_FAILURES = {
  NOT_IN_HERDR: "Herdr context is unavailable",
  CHILD_CONTEXT_INCOMPLETE: "Required session or Herdr context is incomplete",
  CHILD_IDENTITY_MISMATCH: "Expected and observed identities differ",
  CHILD_NATIVE_SESSION_UNAVAILABLE: "Herdr has not supplied native Pi session identity",
  CHILD_NATIVE_SESSION_MISMATCH: "Native Pi session identity does not match",
  CHILD_BINDING_MISSING: "No child-binding locator is available",
  CHILD_BINDING_MALFORMED: "The saved child-binding locator is invalid",
  CHILD_BINDING_MISMATCH: "Child-binding locators conflict",
  GENERATION_MISMATCH: "The child generation does not match",
} as const;
const HERDR_FAILURES = {
  HERDR_UNAVAILABLE: "The Herdr executable is unavailable",
  HERDR_COMMAND_FAILED: "A Herdr identity command failed",
  HERDR_INVALID_JSON: "The Herdr identity response was invalid",
} as const;
const FAILURE_MESSAGES = {
  ...BINDING_FAILURES,
  ...HERDR_FAILURES,
  REGISTRY_MALFORMED: "The exact registry is unavailable or invalid",
  ROLE_CHECK_FAILED: "The role check failed without a recognized safe reason",
  CHILD_OPERATION_FAILED: "Child validation failed without a recognized safe reason",
} as const;
export type ValidationFailureCode = keyof typeof FAILURE_MESSAGES;

/** External error text and arbitrary CLI codes must not enter diagnostics. */
export function classifyValidationFailure(
  error: unknown,
  stage: "role" | "binding",
): ValidationFailureCode {
  if (error instanceof ChildBindingError && Object.hasOwn(BINDING_FAILURES, error.code))
    return error.code as keyof typeof BINDING_FAILURES;
  if (error instanceof RegistryError && error.code === "REGISTRY_MALFORMED")
    return "REGISTRY_MALFORMED";
  if (error instanceof HerdrCliError)
    return Object.hasOwn(HERDR_FAILURES, error.code)
      ? error.code as keyof typeof HERDR_FAILURES
      : "HERDR_COMMAND_FAILED";
  return stage === "role" ? "ROLE_CHECK_FAILED" : "CHILD_OPERATION_FAILED";
}
function boundedDiagnostic(message: string, fallback: string): string {
  return Buffer.byteLength(message, "utf8") <= 768 ? message : fallback;
}
export function startupDiagnostic(
  roleFailure?: ValidationFailureCode,
  bindingFailure?: ValidationFailureCode,
): string | undefined {
  if (!roleFailure && !bindingFailure) return undefined;
  const role = roleFailure
    ? `Startup role resolution failed (${roleFailure}). ${FAILURE_MESSAGES[roleFailure]}.`
    : "Managed-child context was detected.";
  const binding = bindingFailure
    ? `Startup binding is unavailable (${bindingFailure}). ${FAILURE_MESSAGES[bindingFailure]}. ${roleFailure ? "This does not establish a managed child. " : ""}subagent_channel revalidates child binding, not root role selection.`
    : "A managed-child binding validated afterward. Only subagent_channel is available.";
  return boundedDiagnostic(`${role} Root tools remain unavailable. ${binding}`,
    "Startup validation failed. Root tools remain unavailable; child calls still require full validation.");
}
function startupGuidance(code: ValidationFailureCode): string {
  return boundedDiagnostic(
    `Startup role resolution failed (${code}). ${FAILURE_MESSAGES[code]}. Root tools were withheld at startup. Tool presence does not establish a valid child binding. Child calls revalidate binding, not root role selection. Use only the actual assigned run and generation; never invent them.`,
    "Startup role resolution failed. Root tools were withheld; use only an actual child assignment.",
  );
}
function bindingRefusal(error: unknown, roleFailure?: ValidationFailureCode): ChildError {
  const code = classifyValidationFailure(error, "binding");
  const startup = roleFailure
    ? ` Startup role resolution failed (${roleFailure}). ${FAILURE_MESSAGES[roleFailure]}. Root tools remain unavailable; this child call does not retry role selection.`
    : "";
  return new ChildError(code, boundedDiagnostic(`${code}: ${FAILURE_MESSAGES[code]}.${startup}`,
    `${code}: Child binding could not be validated.`));
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
function publicError(e: unknown): ChildError {
  if (e instanceof ChildError) return e;
  if (
    e instanceof ChildBindingError ||
    e instanceof ChannelStoreError ||
    e instanceof RegistryError ||
    e instanceof HerdrCliError
  )
    return new ChildError(e.code);
  return new ChildError("CHILD_OPERATION_FAILED");
}
async function context(p: JsonObject, piContext: PiContext, binding: ChildBinding, roleFailure?: ValidationFailureCode): Promise<{
  agent: AgentRecord;
  run: RunRecord;
  cli: HerdrCli;
  store: ChannelStore;
}> {
  const runId = value(p.runId, 128),
    generation = p.assignmentGeneration;
  if (!Number.isSafeInteger(generation) || Number(generation) < 1)
    throw new ChildError("INVALID_REQUEST");
  const { agent, cli } = await binding.resolve(piContext).catch((error: unknown) => {
    throw bindingRefusal(error, roleFailure);
  });
  if (agent.runId !== runId || agent.assignmentGeneration !== generation)
    throw new ChildError("STALE_ASSIGNMENT");
  const run = agent.runs.find(
    (r) => r.runId === runId && r.assignmentGeneration === generation,
  );
  if (!run) throw new ChildError("STALE_ASSIGNMENT");
  return { agent, run, cli, store: new ChannelStore(agent.domainId) };
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
async function execute(raw: unknown, piContext: PiContext, binding: ChildBinding, roleFailure?: ValidationFailureCode): Promise<JsonObject> {
  const p = object(raw) ?? {},
    action = p.action;
  if (
    action !== "progress" &&
    action !== "send" &&
    action !== "acknowledge_cancel" &&
    action !== "complete"
  )
    throw new ChildError("INVALID_REQUEST");
  const c = await context(p, piContext, binding, roleFailure);
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
export function registerSubagentChannel(
  api: ExtensionAPI,
  binding = new ChildBinding(api),
  startupRoleFailure?: ValidationFailureCode,
): void {
  const tool: Tool = {
    name: "subagent_channel",
    label: "Subagent Channel",
    parameters: SCHEMA as unknown,
    description:
      (startupRoleFailure ? `Startup role resolution failed (${startupRoleFailure}). ` : "") +
      "Report progress, send a message, acknowledge a requested cancellation, or explicitly complete the exact assigned run. Every call requires the current run ID and assignment generation; stale assignments are rejected.",
    ...(startupRoleFailure ? { promptGuidelines: [startupGuidance(startupRoleFailure)] } : {}),
    promptSnippet:
      "Use subagent_channel with the exact runId and assignmentGeneration from the latest assignment prompt; acknowledge cancellation only after the parent requests it.",
    async execute(_id, params, _signal, _update, piContext) {
      try {
        const result = await execute(params, piContext, binding, startupRoleFailure);
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
