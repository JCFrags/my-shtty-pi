import { randomUUID } from "node:crypto";
import { CHECKS } from "./audits.ts";
import type { Report } from "./types.ts";

export const MODEL_BYTES = 16 * 1024;
export function checkCatalog(offset = 0, limit = 25): Report {
  const time = new Date().toISOString();
  const checks = CHECKS.slice(offset, offset + limit);
  return { schemaVersion: 1, kind: "checks", reportId: randomUUID(), startedAt: time, endedAt: time,
    scope: "current Pi process/session", requestedTopics: [], requestedChecks: [], providers: [], findings: [], checks,
    complete: offset === 0 && checks.length === CHECKS.length,
    page: { offset, limit, total: CHECKS.length, nextOffset: offset + checks.length < CHECKS.length ? offset + checks.length : null,
      truncated: offset > 0 || offset + checks.length < CHECKS.length },
    limits: ["Catalog discovery does not run audits. Some checks require unavailable owner contracts."] };
}

/** Bound the shared report, not only its model text. Keep finding evidence before other fields. */
export function boundReport(input: Report): Report {
  const report: Report = structuredClone(input);
  const bytes = () => Buffer.byteLength(JSON.stringify(report));
  if (bytes() <= MODEL_BYTES) return report;
  const required = new Set(report.findings.flatMap(finding => finding.evidence));
  report.complete = false;
  report.limits.push("Output was bounded to 16 KiB. Omitted fields are not evidence of health. Request fewer topics or a smaller detail page.");
  // Remove the tail of the detail page first. nextOffset points to the first omitted row.
  const details = report.providers.find(provider => provider.provider === "details");
  while (details?.fields.length && bytes() > MODEL_BYTES) {
    details.fields.pop();
    report.page.nextOffset = report.page.offset + details.fields.length;
    report.page.truncated = true;
  }
  for (const provider of [...report.providers].reverse()) {
    for (let i = provider.fields.length - 1; i >= 0 && bytes() > MODEL_BYTES; i--) {
      if (!required.has(provider.fields[i].id)) provider.fields.splice(i, 1);
    }
  }
  if (bytes() > MODEL_BYTES) {
    // Fixed catalogs/check counts keep this fallback small. Do not emit partial JSON.
    report.providers = report.providers.map(provider => ({ ...provider, fields: [] }));
    report.findings = report.findings.map(finding => ({ ...finding, outcome: "unknown", severity: "info",
      explanation: "Supporting evidence exceeded the response bound. Inspect fewer topics.", evidence: [] }));
  }
  return report;
}
const escape = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/[\\`*_<>\[\]|]/g, char => `\\${char}`);
export function renderMarkdown(report: Report): string {
  const lines = ["# Pi diagnostics", "", `Report: ${report.reportId}. Schema: ${report.schemaVersion}.`,
    `Scope: ${report.scope}.`, `Collected: ${report.startedAt} to ${report.endedAt}.`,
    `Evidence completeness: ${report.complete ? "complete within this request" : "partial or unavailable"}.`, ""];
  for (const finding of report.findings) {
    lines.push(`## ${finding.checkId}: ${finding.outcome}`, finding.explanation,
      `Evidence: ${finding.evidence.join(", ") || "unavailable"}.`, `Next inspection: ${finding.nextInspection}`, "");
  }
  for (const provider of report.providers) {
    lines.push(`## ${provider.provider}: ${provider.availability}`, `Source: ${provider.source}.`, `Scope: ${provider.scope}.`,
      `Observed: ${provider.observedAt}${provider.errorCode ? `. Error code: ${provider.errorCode}` : ""}.`, "");
    for (const field of provider.fields) lines.push(`- ${escape(field.id)}: ${field.value === null ? "Unavailable" : escape(String(field.value))} (${escape(field.unit)}, ${field.basis})${field.note ? `. ${field.note}` : ""}`);
    for (const limit of provider.limits) lines.push(`- Limit: ${limit}`);
    lines.push("");
  }
  for (const check of report.checks) lines.push(`## ${check.id}`, check.purpose,
    `Evidence needs: ${check.evidenceNeeds.join(", ")}.`, `Limit: ${check.limits}`, "");
  if (report.page.total) lines.push(`Detail page: offset ${report.page.offset}, limit ${report.page.limit}, total ${report.page.total}. Next offset: ${report.page.nextOffset ?? "none"}.`, "");
  lines.push("## Limits", ...report.limits.map(limit => `- ${limit}`), "", "Private local report. Review the exact report before sharing.");
  return lines.join("\n");
}
