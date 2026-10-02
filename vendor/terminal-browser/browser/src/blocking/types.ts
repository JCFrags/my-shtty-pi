export const BLOCKING_ACTIONS = [
  "status", "enable", "disable", "allow-site", "block-site", "clear-diagnostics", "reload",
] as const;

export type BlockingAction = typeof BLOCKING_ACTIONS[number];

export interface BlockingRequest {
  action: BlockingAction;
  site?: string;
}

export interface BlockingStatus {
  enabled: boolean;
  effective: boolean;
  site: string | null;
  siteAllowed: boolean;
  exceptions: string[];
  exceptionScope: "exact-host";
  engine: { name: "@ghostery/adblocker"; version: string; ready: boolean };
  filters: {
    name: "EasyList";
    version: string;
    sha256: string;
    updatePolicy: "bundled-reviewed-releases";
    networkOnly: true;
    cache: "hit" | "rebuilt" | "unavailable";
  };
  warning: string | null;
  diagnostics: {
    scope: "context";
    blocked: number;
    recent: { host: string; type: string }[];
    limit: number;
  };
}

export function parseBlockingRequest(action: unknown, site: unknown): BlockingRequest {
  const selected = action ?? "status";
  if (typeof selected !== "string" || !BLOCKING_ACTIONS.includes(selected as BlockingAction)) {
    throw new Error("invalid blocking action");
  }
  if (site !== undefined && (typeof site !== "string" || site.length > 2048 || !site.trim())) {
    throw new Error("blocking site must be a hostname or HTTP(S) URL of at most 2048 characters");
  }
  if (site !== undefined && selected !== "allow-site" && selected !== "block-site") {
    throw new Error("blocking site is only valid for allow-site or block-site");
  }
  return { action: selected as BlockingAction, ...(site === undefined ? {} : { site: site as string }) };
}
