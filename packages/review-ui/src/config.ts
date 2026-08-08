import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CONFIG_RELATIVE_PATH = ".pi/review-ui.json";
export const MAX_CONFIGURED_PREVIEW_BYTES = 64 * 1024 * 1024;

export type ReviewBashMode = "off";
export type NonInteractiveMode = "block" | "allow";
export type OutsideCwdMode = "double-confirm" | "block";

export interface ReviewUiConfig {
  reviewEdit: boolean;
  reviewWrite: boolean;
  reviewBash: ReviewBashMode;
  allowApproveAllForTurn: boolean;
  maxPreviewBytes: number;
  nonInteractive: NonInteractiveMode;
  outsideCwd: OutsideCwdMode;
}

export const DEFAULT_CONFIG: Readonly<ReviewUiConfig> = Object.freeze({
  reviewEdit: true,
  reviewWrite: true,
  reviewBash: "off",
  allowApproveAllForTurn: false,
  maxPreviewBytes: 1_048_576,
  nonInteractive: "block",
  outsideCwd: "double-confirm",
});

export type ConfigLoadResult =
  | { ok: true; path: string; config: ReviewUiConfig }
  | { ok: false; path: string; error: string };

export type ReadTextFile = (path: string, encoding: BufferEncoding) => Promise<string>;

const CONFIG_KEYS = new Set<keyof ReviewUiConfig>([
  "reviewEdit",
  "reviewWrite",
  "reviewBash",
  "allowApproveAllForTurn",
  "maxPreviewBytes",
  "nonInteractive",
  "outsideCwd",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function validateConfig(value: unknown): ReviewUiConfig {
  if (!isPlainObject(value)) {
    throw new Error("configuration must be a JSON object");
  }

  const errors: string[] = [];
  const unknownKeys = Object.keys(value).filter((key) => !CONFIG_KEYS.has(key as keyof ReviewUiConfig));
  if (unknownKeys.length > 0) {
    errors.push(`unknown key(s): ${unknownKeys.sort().join(", ")}`);
  }

  const result: ReviewUiConfig = { ...DEFAULT_CONFIG };

  const readBoolean = (key: "reviewEdit" | "reviewWrite" | "allowApproveAllForTurn"): void => {
    if (!(key in value)) return;
    const candidate = value[key];
    if (typeof candidate !== "boolean") {
      errors.push(`${key} must be boolean, received ${formatValue(candidate)}`);
      return;
    }
    result[key] = candidate;
  };

  readBoolean("reviewEdit");
  readBoolean("reviewWrite");
  readBoolean("allowApproveAllForTurn");

  if ("reviewBash" in value) {
    if (value.reviewBash !== "off") {
      errors.push(`reviewBash supports only \"off\" in version one, received ${formatValue(value.reviewBash)}`);
    } else {
      result.reviewBash = "off";
    }
  }

  if ("maxPreviewBytes" in value) {
    const candidate = value.maxPreviewBytes;
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 1 ||
      candidate > MAX_CONFIGURED_PREVIEW_BYTES
    ) {
      errors.push(
        `maxPreviewBytes must be an integer from 1 through ${MAX_CONFIGURED_PREVIEW_BYTES}, received ${formatValue(candidate)}`,
      );
    } else {
      result.maxPreviewBytes = candidate;
    }
  }

  if ("nonInteractive" in value) {
    const candidate = value.nonInteractive;
    if (candidate !== "block" && candidate !== "allow") {
      errors.push(`nonInteractive must be \"block\" or \"allow\", received ${formatValue(candidate)}`);
    } else {
      result.nonInteractive = candidate;
    }
  }

  if ("outsideCwd" in value) {
    const candidate = value.outsideCwd;
    if (candidate !== "double-confirm" && candidate !== "block") {
      errors.push(`outsideCwd must be \"double-confirm\" or \"block\", received ${formatValue(candidate)}`);
    } else {
      result.outsideCwd = candidate;
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return result;
}

export async function loadConfig(cwd: string, readTextFile: ReadTextFile = readFile): Promise<ConfigLoadResult> {
  const path = join(cwd, CONFIG_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await readTextFile(path, "utf8");
  } catch (error: unknown) {
    if (isErrorWithCode(error) && error.code === "ENOENT") {
      return { ok: true, path, config: { ...DEFAULT_CONFIG } };
    }
    return { ok: false, path, error: `cannot read configuration: ${conciseError(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    return { ok: false, path, error: `invalid JSON: ${conciseError(error)}` };
  }

  try {
    return { ok: true, path, config: validateConfig(parsed) };
  } catch (error: unknown) {
    return { ok: false, path, error: conciseError(error) };
  }
}

export function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown error";
}

function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string";
}
