import { isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrCli } from "./herdr-cli.js";
import { readRegistryByDomain } from "./store.js";
import type { AgentRecord, JsonObject } from "./types.js";

export const CHILD_BINDING_ENTRY = "pi-herdr-orchestrator:child-binding";
const CHILD_ENVIRONMENT = [
  "PI_HERDR_DOMAIN_ID", "PI_HERDR_AGENT_ID", "PI_HERDR_AGENT_GENERATION",
  "PI_HERDR_RUN_ID", "PI_HERDR_ASSIGNMENT_GENERATION",
  "PI_HERDR_ROOT_PARENT_PANE_ID", "PI_HERDR_PARENT_PANE_ID",
] as const;
export interface ChildContext {
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getBranch(): ReadonlyArray<{ type: string; customType?: string; data?: unknown }>;
  };
}
interface Locator {
  version: 1;
  domainId: string;
  agentId: string;
  agentGeneration: 1;
  sessionId: string;
  sessionFile: string;
}
export class ChildBindingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ChildBindingError";
  }
}
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : undefined;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 &&
  Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/u.test(value);
function env(name: string): string {
  const value = process.env[name];
  if (!text(value, 4096)) throw new ChildBindingError("CHILD_CONTEXT_INCOMPLETE");
  return value;
}
export function hasChildEnvironment(): boolean {
  return CHILD_ENVIRONMENT.some((name) => process.env[name] !== undefined);
}
function entries(context: ChildContext) {
  return context.sessionManager.getBranch().filter(
    (entry) => entry.type === "custom" && entry.customType === CHILD_BINDING_ENTRY,
  );
}
function same(left: Locator, right: Locator): boolean {
  return left.domainId === right.domainId && left.agentId === right.agentId &&
    left.agentGeneration === right.agentGeneration &&
    left.sessionId === right.sessionId && left.sessionFile === right.sessionFile;
}
function savedLocator(context: ChildContext): Locator | undefined {
  let saved: Locator | undefined;
  for (const entry of entries(context)) {
    if (entry.type !== "custom") continue;
    const value = object(entry.data);
    if (!value || Object.keys(value).length !== 6 || value.version !== 1 ||
      !text(value.domainId, 128) || !/^d-[a-f0-9]{24}$/u.test(value.domainId) ||
      !text(value.agentId, 128) || value.agentGeneration !== 1 ||
      !text(value.sessionId, 128) || !text(value.sessionFile, 4096) ||
      !isAbsolute(value.sessionFile))
      throw new ChildBindingError("CHILD_BINDING_MALFORMED");
    const locator = value as unknown as Locator;
    if (saved && !same(saved, locator))
      throw new ChildBindingError("CHILD_BINDING_MISMATCH");
    saved = locator;
  }
  return saved;
}
function nativeSession(context: ChildContext): Pick<Locator, "sessionId" | "sessionFile"> {
  const sessionId = context.sessionManager.getSessionId();
  const sessionFile = context.sessionManager.getSessionFile();
  if (!text(sessionId, 128) || !text(sessionFile, 4096) || !isAbsolute(sessionFile))
    throw new ChildBindingError("CHILD_CONTEXT_INCOMPLETE");
  return { sessionId, sessionFile };
}
function coordinates(value: JsonObject, expected: {
  workspaceId: string; tabId: string; paneId: string;
}): void {
  if (value.workspace_id !== expected.workspaceId ||
    value.tab_id !== expected.tabId || value.pane_id !== expected.paneId)
    throw new ChildBindingError("CHILD_IDENTITY_MISMATCH");
}
function currentCoordinates() {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH)
    throw new ChildBindingError("NOT_IN_HERDR");
  return {
    workspaceId: env("HERDR_WORKSPACE_ID"),
    tabId: env("HERDR_TAB_ID"),
    paneId: env("HERDR_PANE_ID"),
  };
}
function verifyNative(value: JsonObject, locator: Locator): void {
  const session = object(value.agent_session);
  if (!session) throw new ChildBindingError("CHILD_NATIVE_SESSION_UNAVAILABLE");
  if (session.source !== "herdr:pi" || session.agent !== "pi" ||
    !((session.kind === "path" && session.value === locator.sessionFile) ||
      (session.kind === "id" && session.value === locator.sessionId)))
    throw new ChildBindingError("CHILD_NATIVE_SESSION_MISMATCH");
}

/** A generated name can deny root access, but cannot locate or authorize a child. */
export async function isChildSession(context: ChildContext): Promise<boolean> {
  if (hasChildEnvironment() || entries(context).length > 0) return true;
  const expected = currentCoordinates();
  const cli = new HerdrCli();
  const [pane, agent] = await Promise.all([
    cli.paneCurrent(), cli.agentGet(expected.paneId),
  ]);
  coordinates(pane, expected);
  coordinates(agent, expected);
  return typeof agent.name === "string" && /^agent-[a-f0-9]{26}$/u.test(agent.name);
}

/** Revalidate on each call, including a startup attempt before Herdr publishes its session. */
export class ChildBinding {
  constructor(private readonly api: ExtensionAPI) {}

  async resolve(context: ChildContext): Promise<{ agent: AgentRecord; cli: HerdrCli }> {
    const native = nativeSession(context);
    const saved = savedLocator(context);
    let locator = saved;
    if (hasChildEnvironment()) {
      if (env("PI_HERDR_AGENT_GENERATION") !== "1")
        throw new ChildBindingError("GENERATION_MISMATCH");
      const candidate: Locator = {
        version: 1,
        domainId: env("PI_HERDR_DOMAIN_ID"),
        agentId: env("PI_HERDR_AGENT_ID"),
        agentGeneration: 1,
        ...native,
      };
      if (saved && !same(saved, candidate))
        throw new ChildBindingError("CHILD_BINDING_MISMATCH");
      locator = candidate;
    }
    if (!locator) throw new ChildBindingError("CHILD_BINDING_MISSING");
    if (locator.sessionId !== native.sessionId || locator.sessionFile !== native.sessionFile)
      throw new ChildBindingError("CHILD_NATIVE_SESSION_MISMATCH");

    const expected = currentCoordinates();
    const registry = await readRegistryByDomain(locator.domainId);
    const matches = registry.agents.filter((item) => item.agentId === locator.agentId);
    const agent = matches[0];
    if (matches.length !== 1 || !agent || agent.agentGeneration !== locator.agentGeneration ||
      agent.processState === "closed" || agent.processState === "failed")
      throw new ChildBindingError("CHILD_IDENTITY_MISMATCH");
    coordinates({ workspace_id: agent.workspaceId, tab_id: agent.tabId, pane_id: agent.paneId }, expected);
    const cli = new HerdrCli();
    const live = await Promise.all([
      cli.paneCurrent(), cli.agentGet(agent.herdrAgentName), cli.paneGet(agent.paneId),
    ]);
    for (const value of live) {
      coordinates(value, agent);
      verifyNative(value, locator);
    }
    if (live[1]!.name !== agent.herdrAgentName)
      throw new ChildBindingError("CHILD_IDENTITY_MISMATCH");

    // Another parallel call may already have appended the same locator.
    const latest = savedLocator(context);
    if (latest && !same(latest, locator))
      throw new ChildBindingError("CHILD_BINDING_MISMATCH");
    if (!latest) {
      // appendEntry follows Pi's native persistence lifecycle; it is not a disk receipt.
      (this.api as unknown as {
        appendEntry(customType: string, data: Locator): void;
      }).appendEntry(CHILD_BINDING_ENTRY, locator);
    }
    return { agent, cli };
  }
}
