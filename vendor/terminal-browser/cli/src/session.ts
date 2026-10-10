import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { nativeBrowserOwner, parseBrowserOwner, piOriginFromEnvironment, requireHerdrBrowserOwner } from "pixel-store";
import type { BrowserOwner } from "pixel-store";
import { commandError } from "./errors";

/** Parse the same explicit owner for launch, contexts, and native actions. */
export function takeSessionOwner(args: string[]): BrowserOwner | null {
  const session = takeValue(args, "--session");
  const project = takeValue(args, "--project");
  if (session === undefined && project === undefined) return null;
  if (!session || !project) throw new Error("native ownership requires both --session <id> and --project <directory>");
  return nativeBrowserOwner(session, path.resolve(project));
}

/** Ordinary browsers get an internal owner. App, embedding, and explicit interop routes keep their defaults. */
export function ordinaryLaunchOwner(args: string[], environment: NodeJS.ProcessEnv, projectDir: string): BrowserOwner | null {
  if (parseBrowserOwner(environment) || environment.TERMINAL_BROWSER_INTEROP_TARGET || args.some(arg =>
    ["--app-mode", "--no-toolbar", "--no-shortcuts", "--no-context-menu", "--no-overlays", "--no-frame"].includes(arg) ||
    ["--ssh=", "--ssh-bundle=", "--partition=", "--preload=", "--main-script=", "--app-name=", "--app-id="].some(flag => arg.startsWith(flag)))) return null;
  const origin = piOriginFromEnvironment(environment);
  const sessionId = origin ? `pi:${createHash("sha256").update(JSON.stringify(origin)).digest("hex")}` : `user:${randomUUID()}`;
  return nativeBrowserOwner(sessionId, projectDir);
}

export function environmentOwner(environment: NodeJS.ProcessEnv, projectDir: string): BrowserOwner | null {
  const explicit = parseBrowserOwner(environment);
  if (explicit) return explicit;
  return environment.HERDR_ENV === "1"
    ? requireHerdrBrowserOwner(environment, projectDir, environment.PI_SESSION_ID)
    : null;
}

export function requireSessionOwner(args: string[], environment: NodeJS.ProcessEnv, projectDir: string): BrowserOwner {
  const owner = takeSessionOwner(args) ?? environmentOwner(environment, projectDir);
  if (!owner) throw commandError("OWNER_REQUIRED", "browser session requires --session <id> and --project <directory>");
  return owner;
}

function takeValue(args: string[], name: string): string | undefined {
  const matches = args.flatMap((arg, index) => arg === name || arg.startsWith(`${name}=`) ? [index] : []);
  if (matches.length > 1) throw new Error(`duplicate ${name}`);
  if (!matches.length) return undefined;
  const at = matches[0]!;
  if (args[at]!.startsWith(`${name}=`)) return args.splice(at, 1)[0]!.slice(name.length + 1);
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(at, 2);
  return value;
}
