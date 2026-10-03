import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const ASSOCIATION_TYPE = "terminal-browser.owner-association";
const ID = /^[A-Za-z0-9._:-]{1,128}$/u;

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

/** Read only the latest explicit association on the active branch. Forks inherit no authority. */
export function readAssociation(ctx: ExtensionContext): { association: OwnerAssociation; entryId: string } | null {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== ASSOCIATION_TYPE) continue;
    const value = entry.data as OwnerAssociation | undefined;
    if (value?.schemaVersion !== 1 || value.piSessionId !== ctx.sessionManager.getSessionId() ||
        value.piSessionFile !== (ctx.sessionManager.getSessionFile() ?? null) || !validOwner(value.owner)) return null;
    return { association: value, entryId: entry.id };
  }
  return null;
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
