import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ASSOCIATION_TYPE = "terminal-browser.owner-association";
export const PI_ORIGIN_ENV = "TERMINAL_BROWSER_PI_ORIGIN";
const ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export interface PiOrigin {
  schemaVersion: 1;
  generation: string;
  piSessionId: string;
  piSessionFile: string | null;
}

export interface BrowserOwnerMetadata {
  workspaceId: string;
  tabId: string;
  paneId: string;
  sessionId: string | null;
  projectDir: string;
}

export function parsePiOrigin(value: unknown): PiOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid browser launch origin.");
  const item = value as PiOrigin;
  if (Object.keys(item).length !== 4 || item.schemaVersion !== 1 || typeof item.generation !== "string" || !UUID.test(item.generation) ||
      typeof item.piSessionId !== "string" || !item.piSessionId.trim() || item.piSessionId.length > 512 || CONTROL.test(item.piSessionId) ||
      !(item.piSessionFile === null || (typeof item.piSessionFile === "string" && isAbsolute(item.piSessionFile) &&
        item.piSessionFile.length <= 4096 && !CONTROL.test(item.piSessionFile)))) throw new Error("Invalid browser launch origin.");
  const origin: PiOrigin = { schemaVersion: 1, generation: item.generation, piSessionId: item.piSessionId, piSessionFile: item.piSessionFile };
  if (Buffer.byteLength(JSON.stringify(origin), "utf8") > 8192) throw new Error("Browser launch origin exceeds its safe limit.");
  return origin;
}

export function samePiOrigin(left: PiOrigin | null, right: PiOrigin): boolean {
  return left?.generation === right.generation && left.piSessionId === right.piSessionId && left.piSessionFile === right.piSessionFile;
}

export type SelectedOwner =
  | { kind: "native"; sessionId: string; projectDir: string }
  | { kind: "herdr"; workspaceId: string; tabId: string; paneId: string; projectDir: string };

export interface OwnerAssociation {
  schemaVersion: 1;
  piSessionId: string;
  piSessionFile: string | null;
  owner: SelectedOwner | null;
}

export function sessionIdentity(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager;
  return JSON.stringify([manager.getSessionId(), manager.getSessionFile() ?? null, manager.getSessionDir()]);
}

function validOwner(value: unknown): value is SelectedOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as SelectedOwner;
  if (typeof owner.projectDir !== "string" || !isAbsolute(owner.projectDir) ||
      owner.projectDir.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(owner.projectDir)) return false;
  if (owner.kind === "native") return typeof owner.sessionId === "string" && ID.test(owner.sessionId);
  return owner.kind === "herdr" && [owner.workspaceId, owner.tabId, owner.paneId].every(id => typeof id === "string" && ID.test(id));
}

/** Read the latest branch association, including an explicit disconnect. Forks inherit no authority. */
export function readAssociationState(ctx: ExtensionContext): { association: OwnerAssociation; entryId: string } | null {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== ASSOCIATION_TYPE) continue;
    const value = entry.data as OwnerAssociation | undefined;
    if (value?.schemaVersion !== 1 || value.piSessionId !== ctx.sessionManager.getSessionId() ||
        value.piSessionFile !== (ctx.sessionManager.getSessionFile() ?? null) || !(value.owner === null || validOwner(value.owner))) return null;
    return { association: value, entryId: entry.id };
  }
  return null;
}

export function readAssociation(ctx: ExtensionContext): { association: OwnerAssociation; entryId: string } | null {
  const selected = readAssociationState(ctx);
  return selected?.association.owner ? selected : null;
}

export function associationEntry(ctx: ExtensionContext, owner: SelectedOwner | null): OwnerAssociation {
  return { schemaVersion: 1, piSessionId: ctx.sessionManager.getSessionId(),
    piSessionFile: ctx.sessionManager.getSessionFile() ?? null, owner };
}

export function launchProject(project: string): string {
  const root = realpathSync(project);
  if (!statSync(root).isDirectory() || root.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(root)) {
    throw new Error("The browser launch project must be an existing directory without control characters.");
  }
  return root;
}

export function nativeOwner(sessionId: string, project: string): SelectedOwner {
  if (!ID.test(sessionId)) throw new Error("Use 1 to 128 letters, digits, dots, underscores, colons, or hyphens for the native session ID.");
  // The native CLI constructs and validates nativeBrowserOwner from this canonical project.
  return { kind: "native", sessionId, projectDir: launchProject(project) };
}

/** Validate complete discovery metadata without deriving a task ID from an owner hash. */
export function selectedOwner(value: unknown): SelectedOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser returned no complete owner.");
  const item = value as BrowserOwnerMetadata;
  if (![item.workspaceId, item.tabId, item.paneId].every(id => typeof id === "string" && ID.test(id)) ||
      !(item.sessionId === null || (typeof item.sessionId === "string" && item.sessionId.length > 0 && item.sessionId.length <= 512 && !CONTROL.test(item.sessionId))) ||
      typeof item.projectDir !== "string" || !isAbsolute(item.projectDir) || item.projectDir.length > 4096 || CONTROL.test(item.projectDir)) {
    throw new Error("Browser returned no complete owner.");
  }
  const projectDir = launchProject(item.projectDir);
  if (projectDir !== item.projectDir) throw new Error("Browser launch project changed. Reconnect explicitly.");
  if (item.workspaceId === "terminal-browser:cli") {
    const owner = nativeOwner(item.sessionId ?? "", projectDir);
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    if (item.tabId !== `project:${digest(projectDir)}` || item.paneId !== `session:${digest(item.sessionId!)}`) {
      throw new Error("Native browser owner does not match its task and project.");
    }
    return owner;
  }
  return { kind: "herdr", workspaceId: item.workspaceId, tabId: item.tabId, paneId: item.paneId, projectDir };
}

export function sameOwner(left: SelectedOwner, right: SelectedOwner): boolean {
  return left.kind === right.kind && left.projectDir === right.projectDir && (left.kind === "native"
    ? right.kind === "native" && left.sessionId === right.sessionId
    : right.kind === "herdr" && left.workspaceId === right.workspaceId && left.tabId === right.tabId && left.paneId === right.paneId);
}

export function defaultOwner(ctx: ExtensionContext): SelectedOwner | null {
  return herdrOwner(ctx.cwd);
}

export function herdrOwner(project: string, environment: NodeJS.ProcessEnv = process.env): SelectedOwner | null {
  if (environment.HERDR_ENV !== "1") return null;
  const { HERDR_WORKSPACE_ID: workspaceId, HERDR_TAB_ID: tabId, HERDR_PANE_ID: paneId } = environment;
  if (![workspaceId, tabId, paneId].every(id => typeof id === "string" && ID.test(id))) return null;
  return { kind: "herdr", workspaceId: workspaceId!, tabId: tabId!, paneId: paneId!, projectDir: launchProject(project) };
}

export function ownerLabel(owner: SelectedOwner): string {
  return owner.kind === "native" ? `Native session ${owner.sessionId}` : `Herdr ${owner.workspaceId}/${owner.tabId}/${owner.paneId}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function launchInstruction(owner: SelectedOwner): string {
  if (owner.kind !== "native") return "Use /browser Open/focus to launch this exact Herdr owner.";
  return `terminal-browser open --session ${shellQuote(owner.sessionId)} --project ${shellQuote(owner.projectDir)}`;
}
