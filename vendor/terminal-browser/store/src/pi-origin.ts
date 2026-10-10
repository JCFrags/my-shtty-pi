import path from "node:path";

export const PI_ORIGIN_ENV = "TERMINAL_BROWSER_PI_ORIGIN";
export const PI_ORIGIN_LIMIT = 8192;

/** Launch provenance only. It does not replace the browser owner or receiver binding. */
export interface PiOrigin {
  schemaVersion: 1;
  generation: string;
  piSessionId: string;
  piSessionFile: string | null;
}

export function parsePiOrigin(value: unknown): PiOrigin | null {
  try {
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > PI_ORIGIN_LIMIT) return null;
      value = JSON.parse(value);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== 4 || item.schemaVersion !== 1 ||
        typeof item.generation !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(item.generation) ||
        typeof item.piSessionId !== "string" || !item.piSessionId.trim() || item.piSessionId.length > 512 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(item.piSessionId) ||
        !(item.piSessionFile === null || typeof item.piSessionFile === "string" && path.isAbsolute(item.piSessionFile) &&
          item.piSessionFile.length <= 4096 && !/[\u0000-\u001f\u007f-\u009f]/u.test(item.piSessionFile))) return null;
    const origin: PiOrigin = { schemaVersion: 1, generation: item.generation, piSessionId: item.piSessionId, piSessionFile: item.piSessionFile };
    return Buffer.byteLength(JSON.stringify(origin), "utf8") <= PI_ORIGIN_LIMIT ? origin : null;
  } catch { return null; }
}

export function piOriginFromEnvironment(environment: NodeJS.ProcessEnv): PiOrigin | null {
  const origin = parsePiOrigin(environment[PI_ORIGIN_ENV]);
  if (origin && environment.PI_SESSION_ID !== undefined && environment.PI_SESSION_ID !== origin.piSessionId) {
    throw Object.assign(new Error("Pi launch origin differs from the current PI_SESSION_ID; use the current conversation's origin. The inherited origin was not forwarded or rewritten."), { code: "PI_ORIGIN_MISMATCH" });
  }
  return origin;
}

/** Preserve the validated envelope bytes when crossing a terminal split or plugin launch. */
export function piOriginEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const value = environment[PI_ORIGIN_ENV];
  return value !== undefined && piOriginFromEnvironment(environment) ? { [PI_ORIGIN_ENV]: value } : {};
}

export function samePiOrigin(left: PiOrigin | null, right: PiOrigin | null): boolean {
  return left !== null && right !== null && left.generation === right.generation &&
    left.piSessionId === right.piSessionId && left.piSessionFile === right.piSessionFile;
}
