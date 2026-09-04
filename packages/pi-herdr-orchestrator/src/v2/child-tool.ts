import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChannelStore, ChannelStoreError } from "./channel-store.js";
import { HerdrCli, HerdrCliError } from "./herdr-cli.js";
import { readRegistryByDomain, RegistryError } from "./store.js";
import type { AgentRecord, ChannelEvent, CompletionStatus, JsonObject } from "./types.js";

const MAX_SUMMARY = 2048, MAX_MESSAGE = 4096, MAX_RESULT = 16384;
const string = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const SCHEMA = { oneOf: [
  { type: "object", additionalProperties: false, required: ["action", "summary"], properties: { action: { const: "progress" }, summary: string(MAX_SUMMARY) } },
  { type: "object", additionalProperties: false, required: ["action", "target", "message"], properties: { action: { const: "send" }, target: string(128), message: string(MAX_MESSAGE) } },
  { type: "object", additionalProperties: false, required: ["action", "status", "summary"], properties: { action: { const: "complete" }, status: { enum: ["completed", "failed"] }, summary: string(4096), finalResult: string(MAX_RESULT) } },
] } as const;

type PiContext = { cwd: string };
type Tool = { name: string; label: string; description: string; promptSnippet?: string; parameters: unknown;
  execute(id: string, params: unknown, signal: AbortSignal | undefined, update: unknown, context: PiContext): Promise<{content:Array<{type:"text";text:string}>;details:JsonObject}> };
type Api = { registerTool(tool: Tool): void };
class ChildError extends Error { constructor(readonly code: string) { super(code); this.name = "ChildError"; } }
function object(v: unknown): JsonObject | undefined { return v !== null && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : undefined; }
function value(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.length || Buffer.byteLength(v) > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) throw new ChildError("INVALID_REQUEST");
  return v;
}
function id(v: JsonObject, key: string): string | undefined { return typeof v[key] === "string" ? v[key] as string : undefined; }
function env(name: string): string { const v = process.env[name]; if (!v) throw new ChildError("CHILD_CONTEXT_INCOMPLETE"); return v; }
function publicError(e: unknown): ChildError {
  if (e instanceof ChildError) return e;
  if (e instanceof ChannelStoreError || e instanceof RegistryError || e instanceof HerdrCliError) return new ChildError(e.code);
  return new ChildError("CHILD_OPERATION_FAILED");
}
async function context(): Promise<{ agent: AgentRecord; cli: HerdrCli; store: ChannelStore }> {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH) throw new ChildError("NOT_IN_HERDR");
  const domainId = env("PI_HERDR_DOMAIN_ID"), agentId = env("PI_HERDR_AGENT_ID"), runId = env("PI_HERDR_RUN_ID");
  if (env("PI_HERDR_AGENT_GENERATION") !== "1" || env("PI_HERDR_ASSIGNMENT_GENERATION") !== "1") throw new ChildError("GENERATION_MISMATCH");
  const registry = await readRegistryByDomain(domainId);
  const agent = registry.agents.find((a) => a.agentId === agentId && a.runId === runId);
  if (!agent || agent.agentGeneration !== 1 || agent.assignmentGeneration !== 1) throw new ChildError("CHILD_IDENTITY_MISMATCH");
  if (agent.workspaceId !== env("HERDR_WORKSPACE_ID") || agent.tabId !== env("HERDR_TAB_ID") || agent.paneId !== env("HERDR_PANE_ID")) throw new ChildError("CHILD_IDENTITY_MISMATCH");
  const cli = new HerdrCli(); const [current, herdrAgent, pane] = await Promise.all([cli.paneCurrent(), cli.agentGet(agent.herdrAgentName), cli.paneGet(agent.paneId)]);
  for (const candidate of [current, herdrAgent, pane]) if (id(candidate,"workspace_id") !== agent.workspaceId || id(candidate,"tab_id") !== agent.tabId || id(candidate,"pane_id") !== agent.paneId) throw new ChildError("CHILD_IDENTITY_MISMATCH");
  if (id(herdrAgent, "name") !== agent.herdrAgentName) throw new ChildError("CHILD_IDENTITY_MISMATCH");
  return { agent, cli, store: new ChannelStore(domainId) };
}
function event(agent: AgentRecord, kind: "progress"|"message", target: string, summary: string): ChannelEvent {
  const createdAt = new Date().toISOString();
  return { version:1, eventId:`${Date.now().toString().padStart(13,"0")}-${randomUUID()}`, kind, domainId:agent.domainId,
    agentId:agent.agentId, runId:agent.runId, agentGeneration:1, assignmentGeneration:1, target, summary, createdAt };
}
async function validateTarget(cli: HerdrCli, target: AgentRecord): Promise<void> {
  const [a,p] = await Promise.all([cli.agentGet(target.herdrAgentName), cli.paneGet(target.paneId)]);
  for (const v of [a,p]) if (id(v,"workspace_id") !== target.workspaceId || id(v,"tab_id") !== target.tabId || id(v,"pane_id") !== target.paneId) throw new ChildError("TARGET_IDENTITY_MISMATCH");
  if (id(a,"name") !== target.herdrAgentName) throw new ChildError("TARGET_IDENTITY_MISMATCH");
}
async function execute(raw: unknown): Promise<JsonObject> {
  const p = object(raw) ?? {}; const action = p.action;
  if (action !== "progress" && action !== "send" && action !== "complete") throw new ChildError("INVALID_REQUEST");
  const c = await context();
  if (action === "progress") {
    if (await c.store.result(c.agent.runId)) throw new ChildError("RUN_ALREADY_TERMINAL");
    const e = event(c.agent,"progress","parent",value(p.summary,MAX_SUMMARY)); await c.store.appendEvent(e);
    return {ok:true,action,eventId:e.eventId,createdAt:e.createdAt};
  }
  if (action === "send") {
    const target = value(p.target,128), message = value(p.message,MAX_MESSAGE);
    if (target !== "parent") {
      const registry = await readRegistryByDomain(c.agent.domainId); const recipient = registry.agents.find((a) => a.agentId === target);
      if (!recipient || recipient.processState === "closed" || recipient.processState === "failed") throw new ChildError("TARGET_NOT_AVAILABLE");
      await validateTarget(c.cli, recipient);
      await c.cli.agentPrompt(recipient.herdrAgentName, `[subagent message from ${c.agent.agentId}] ${message}`);
    }
    const e = event(c.agent,"message",target,message); await c.store.appendEvent(e);
    return {ok:true,action,eventId:e.eventId,target,createdAt:e.createdAt};
  }
  const status = p.status as CompletionStatus;
  if (status !== "completed" && status !== "failed") throw new ChildError("INVALID_REQUEST");
  const completed = await c.store.complete({version:1,domainId:c.agent.domainId,agentId:c.agent.agentId,runId:c.agent.runId,
    agentGeneration:1,assignmentGeneration:1,status,summary:value(p.summary,4096),finalResult:p.finalResult === undefined ? null : value(p.finalResult,MAX_RESULT)});
  return {ok:true,action,status,completedAt:completed.result.completedAt,duplicate:completed.duplicate};
}
export function registerSubagentChannel(api: ExtensionAPI): void {
  const tool: Tool = { name:"subagent_channel", label:"Subagent Channel", parameters:SCHEMA as unknown,
    description:"Report explicit progress, message the parent or an exact sibling agent, and explicitly complete this delegated run. Herdr/Pi state never completes the run.",
    promptSnippet:"Use subagent_channel for progress, messages, and explicit completion.",
    async execute(_id,params){ try { const result=await execute(params); return {content:[{type:"text",text:JSON.stringify(result)}],details:result}; } catch(e){ throw publicError(e); } } };
  (api as unknown as Api).registerTool(tool);
}
