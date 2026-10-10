import path from "node:path";
import { INSTANCES_DIR, parsePiOrigin, sameBrowserOwner, samePiOrigin, type BrowserOwner, type PiOrigin } from "pixel-store";
import { connectionInventory } from "./connections";
import { control } from "./control";
import { commandError } from "./errors";

/** Reuse only this ordinary launch's exact native owner and current provenance. Never relabel a browser. */
export async function reuseOriginBrowser(owner: BrowserOwner, origin: PiOrigin, url?: string) {
  const inventory = await connectionInventory();
  if (inventory.identity === null) return null;
  if (inventory.matchesCandidate !== true) throw commandError("RUNTIME_MISMATCH", "existing browser runtime differs from this CLI; inspect doctor and load the accepted runtime before reconnecting. No duplicate was opened.");
  const matches = inventory.sessions.filter(entry => sameBrowserOwner(entry.owner as BrowserOwner | null, owner));
  if (!matches.length) return null;
  if (matches.length !== 1) throw commandError("AMBIGUOUS_SESSION", "multiple browsers claim this ordinary owner; select an existing browser explicitly. No duplicate was opened.");
  const found = matches[0]!;
  const actual = found.owner as BrowserOwner;
  if (actual.sessionId !== owner.sessionId || actual.projectDir !== owner.projectDir || !samePiOrigin(found.origin ?? null, origin)) {
    throw commandError("STATE_CHANGED", "existing ordinary browser has different or absent origin or project metadata; select it explicitly in /browser. It was not relabeled and no duplicate was opened.");
  }
  if (!/^[1-9][0-9]*-[1-9][0-9]*$/u.test(found.key)) throw new Error("invalid native browser session key");
  const socket = path.join(INSTANCES_DIR, `${found.key}.sock`);
  const exact = { expectedBrowserSessionKey: found.key, expectedRuntimeInstanceId: inventory.identity.instanceId };
  const hello = await control(socket, { cmd: "hello", ...exact }, 2000) as { owner?: BrowserOwner; origin?: unknown; where?: { terminal?: string | null; pane?: string | null } };
  if (!sameBrowserOwner(hello.owner ?? null, owner) || hello.owner?.sessionId !== owner.sessionId || hello.owner?.projectDir !== owner.projectDir || !samePiOrigin(parsePiOrigin(hello.origin), origin)) {
    throw commandError("STATE_CHANGED", "ordinary browser identity or origin changed during reuse; reconnect explicitly. No duplicate was opened.");
  }
  if (url !== undefined) {
    const status = await control(socket, { cmd: "agent.status", ...exact }) as { state?: string; controlEpoch?: number };
    if (status.state !== "agent" && status.state !== "shared") throw commandError("CONTROL_NOT_AGENT", "browser control is with the user; select Agent or Shared explicitly before navigating. No duplicate was opened.");
    const targets = await control(socket, { cmd: "targets", ...exact }) as { tabs?: Array<{ id: number; active: boolean }> };
    const active = targets.tabs?.filter(tab => tab.active);
    if (active?.length !== 1 || !Number.isSafeInteger(active[0]!.id)) throw new Error("ordinary browser has no unique active context");
    await control(socket, { cmd: "agent.navigate", ...exact, tab: active[0]!.id, url, expectedControlEpoch: status.controlEpoch });
  }
  return { action: "reused" as const, key: found.key, owner, origin, runtimeInstanceId: inventory.identity.instanceId, terminal: hello.where?.terminal ?? null, pane: hello.where?.pane ?? null };
}
