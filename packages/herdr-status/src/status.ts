import { SOURCE_ID, TOKEN_NAMES, type TokenSnapshot } from "./constants.ts";
import type { ActivationState } from "./herdr-client.ts";
import type { ReporterStatus } from "./reporter.ts";
import { redactCredentials, redactHomePathPrefixes, sanitizeVisible } from "./sanitize.ts";

export const OFFICIAL_INTEGRATION_NOTE =
  "Semantic lifecycle state and session identity remain owned by Herdr's official Pi integration.";

function formatTimestamp(timestamp: number | undefined): string {
  return timestamp === undefined ? "never" : new Date(timestamp).toISOString();
}

function formatTokens(snapshot: TokenSnapshot): string {
  const entries = TOKEN_NAMES.flatMap((name) => {
    const value = snapshot[name];
    if (value === undefined) return [];
    const safeValue = sanitizeStatusValue(value, name === "summary" ? 60 : 80);
    return safeValue ? [`${name}=${JSON.stringify(safeValue)}`] : [];
  });
  return entries.length > 0 ? entries.join(", ") : "(none)";
}

function sanitizeStatusValue(value: unknown, maxChars: number): string {
  return sanitizeVisible(
    redactHomePathPrefixes(redactCredentials(String(value ?? ""))),
    maxChars,
  );
}

export function renderHerdrStatus(
  activation: ActivationState,
  reporterStatus?: ReporterStatus,
): string {
  const snapshot = reporterStatus?.snapshot ?? {};
  const lines = [
    `Herdr status: ${activation.active ? "active" : "inactive"}`,
    `target pane: ${sanitizeStatusValue(activation.paneId ?? "(none)", 80)}`,
    `source: ${SOURCE_ID}`,
    `last successful report: ${formatTimestamp(reporterStatus?.lastSuccessfulReportAt)}`,
    `last error: ${sanitizeStatusValue(reporterStatus?.lastError ?? "none", 160)}`,
    `tokens: ${formatTokens(snapshot)}`,
  ];
  if (!activation.active) {
    lines.splice(1, 0, `inactive reason: ${sanitizeStatusValue(activation.reason ?? "unknown", 120)}`);
  }
  lines.push(OFFICIAL_INTEGRATION_NOTE);
  return lines.join("\n");
}
