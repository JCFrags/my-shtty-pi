import { createHash } from "node:crypto";

export const HISTORY_HELPER_CONFIG_VERSION = 1 as const;
export const HISTORY_HELPER_ROLES = ["activePrefix", "event", "archive"] as const;
export const HISTORY_HELPER_IDENTIFIER_LIMITS = { providerBytes: 128, modelBytes: 512 } as const;

export type HistoryHelperRole = (typeof HISTORY_HELPER_ROLES)[number];

export interface HistoryModelSelection {
  readonly provider: string;
  readonly model: string;
}

export interface HistoryHelperConsent {
  /** Set only after the user accepts history disclosure and possible provider charges. */
  readonly selectedForHistory: true;
}

export interface HistoryHelperSelection extends HistoryModelSelection, HistoryHelperConsent {}

export interface HistoryHelperConfig {
  readonly schemaVersion: typeof HISTORY_HELPER_CONFIG_VERSION;
  readonly activePrefix?: HistoryHelperSelection;
  readonly event?: HistoryHelperSelection;
  readonly archive?: HistoryHelperSelection;
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "chrono-history-helper-config-invalid" });
}

function record(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("History helper configuration and selections must be JSON objects.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid("History helper configuration and selections must be plain JSON objects.");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !allowedKeys.includes(key))) {
    invalid("History helper configuration contains an unsupported field.");
  }
  return input;
}

function identifier(value: unknown, field: "provider" | "model", maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes
    || Buffer.byteLength(value, "utf8") > maxBytes || /[\s\p{Cc}\p{Cf}]/u.test(value)) {
    invalid(`History helper ${field} must be a nonempty identifier of at most ${maxBytes} UTF-8 bytes, without whitespace or control characters.`);
  }
  return value;
}

export function validateHistoryHelperRole(value: unknown): HistoryHelperRole {
  if (HISTORY_HELPER_ROLES.includes(value as HistoryHelperRole)) return value as HistoryHelperRole;
  return invalid("History helper role must be activePrefix, event, or archive.");
}

export function validateHistoryModelSelection(value: unknown): HistoryModelSelection {
  const input = record(value, ["provider", "model"]);
  return {
    provider: identifier(Object.hasOwn(input, "provider") ? input.provider : undefined, "provider", HISTORY_HELPER_IDENTIFIER_LIMITS.providerBytes),
    model: identifier(Object.hasOwn(input, "model") ? input.model : undefined, "model", HISTORY_HELPER_IDENTIFIER_LIMITS.modelBytes),
  };
}

export function validateHistoryHelperConfig(value: unknown): HistoryHelperConfig {
  // An absent configuration has no selected roles. Legacy model settings are not inputs.
  if (value === undefined) return { schemaVersion: HISTORY_HELPER_CONFIG_VERSION };
  const input = record(value, ["schemaVersion", ...HISTORY_HELPER_ROLES]);
  if (!Object.hasOwn(input, "schemaVersion") || input.schemaVersion !== HISTORY_HELPER_CONFIG_VERSION) {
    invalid("History helper configuration requires schemaVersion 1.");
  }
  const checked: { schemaVersion: 1 } & Partial<Record<HistoryHelperRole, HistoryHelperSelection>> = { schemaVersion: HISTORY_HELPER_CONFIG_VERSION };
  for (const role of HISTORY_HELPER_ROLES) {
    if (!Object.hasOwn(input, role) || input[role] === undefined) continue;
    const selection = record(input[role], ["provider", "model", "selectedForHistory"]);
    if (!Object.hasOwn(selection, "selectedForHistory") || selection.selectedForHistory !== true) {
      invalid("Each selected history helper requires explicit selectedForHistory: true consent.");
    }
    checked[role] = {
      ...validateHistoryModelSelection({
        provider: Object.hasOwn(selection, "provider") ? selection.provider : undefined,
        model: Object.hasOwn(selection, "model") ? selection.model : undefined,
      }),
      selectedForHistory: true,
    };
  }
  return checked;
}

/** Select one exact route after UI confirmation. This does not call or authenticate a model. */
export function selectHistoryHelperRole(
  config: unknown,
  role: HistoryHelperRole,
  selection: HistoryModelSelection,
  consent: HistoryHelperConsent,
): HistoryHelperConfig {
  const checkedRole = validateHistoryHelperRole(role);
  const permission = record(consent, ["selectedForHistory"]);
  if (!Object.hasOwn(permission, "selectedForHistory") || permission.selectedForHistory !== true) {
    invalid("Selecting a history helper requires explicit selectedForHistory: true consent.");
  }
  return {
    ...validateHistoryHelperConfig(config),
    [checkedRole]: { ...validateHistoryModelSelection(selection), selectedForHistory: true },
  };
}

export function clearHistoryHelperRole(config: unknown, role: HistoryHelperRole): HistoryHelperConfig {
  const checkedRole = validateHistoryHelperRole(role);
  const checked = { ...validateHistoryHelperConfig(config) };
  delete checked[checkedRole];
  return checked;
}

/** Resolve only consented configuration. The caller must check availability and enforce no tools. */
export function resolveHistoryHelperRole(config: unknown, role: HistoryHelperRole): HistoryModelSelection | undefined {
  const selection = validateHistoryHelperConfig(config)[validateHistoryHelperRole(role)];
  return selection ? { provider: selection.provider, model: selection.model } : undefined;
}

/** Model-role identity only. Derivation keys must also bind sources, projection, prompt, and reducer. */
export function historyHelperDerivationIdentity(config: unknown, role: HistoryHelperRole): string | undefined {
  const checkedRole = validateHistoryHelperRole(role);
  const selection = resolveHistoryHelperRole(config, checkedRole);
  if (!selection) return undefined;
  const identity = JSON.stringify([HISTORY_HELPER_CONFIG_VERSION, checkedRole, selection.provider, selection.model, "no-tools"]);
  return `history-helper-v1:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}
