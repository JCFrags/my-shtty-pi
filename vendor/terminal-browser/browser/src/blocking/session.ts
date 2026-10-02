import path from "node:path";
import type { Session, WebContents } from "electron";
import { BlockingProfile } from "./profile";
import type { BlockingRequest, BlockingStatus } from "./types";

const profiles = new WeakMap<Session, BlockingProfile>();

export function blockingProfile(target: Session): BlockingProfile {
  let profile = profiles.get(target);
  if (!profile) {
    if (!target.storagePath) throw new Error("Blocking settings require a persistent browser profile.");
    profile = new BlockingProfile(path.join(target.storagePath, "terminal-browser-blocking"));
    profiles.set(target, profile);
  }
  return profile;
}

export function controlBlocking(contents: WebContents, request: BlockingRequest): BlockingStatus {
  if (contents.isDestroyed()) throw new Error("Browser context is closed.");
  return blockingProfile(contents.session).command(contents, request);
}
