import { createToolPresentation } from "pi-tool-controls/presentation";

const object = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const mutations = ["create", "revise", "add_milestone", "update_milestone", "record_decision", "record_risk", "record_question", "checkpoint", "pause", "resume", "complete", "archive", "restore"];
const recoveryHeadings = ["Goal", "Scope", "Non-goals", "Constraints", "Approach", "Current position", "Current milestones", "Next actions", "Outstanding acceptance criteria", "Open or accepted risks", "Open questions", "Key decisions", "Verification"].map((name) => `## ${name}`);

// Select only the native, unique ordered sections. Never infer checkpoint currentness.
function recoverySections(saved: string, planId: string) {
  const lines = saved.split("\n");
  const headings = lines.filter((line) => line.startsWith("## "));
  if (!lines[0]?.startsWith(`# Recovery for ${planId}: `)
    || headings.length !== recoveryHeadings.length || headings.some((line, index) => line !== recoveryHeadings[index])
    || lines.at(-2) !== "Use workplan read for the complete immutable plan and revision history.") return;
  const section = (name: string, next: string) => lines.slice(lines.indexOf(`## ${name}`) + 1, lines.indexOf(`## ${next}`)).filter(Boolean);
  const position = section("Current position", "Current milestones");
  const checkpoint = position.filter((line) => line.startsWith("Latest checkpoint: "));
  const focus = position.filter((line) => line.startsWith("Current focus: "));
  if (checkpoint.length !== 1 || focus.length !== 1 || !/^Milestones completed: \d+\/\d+$/.test(position[0] ?? "")) return;
  if (checkpoint[0] !== "Latest checkpoint: None" && !/^Latest checkpoint: WP[1-9][0-9]*-K[1-9][0-9]* at revision (?:[1-9][0-9]*|unknown) \((?:current|plan changed afterward)\): /.test(checkpoint[0]!)) return;
  return { position, checkpoint: checkpoint[0]!, focus: focus[0]!, actions: section("Next actions", "Outstanding acceptance criteria") };
}

export const workplanPresentation = createToolPresentation({
  call: (args) => `workplan ${text(args.action)}${args.planId ? ` ${text(args.planId)}` : ""}${args.section ? ` · ${text(args.section)}` : ""}`,
  result(result, options, context) {
    const saved = result.content.filter((part) => part.type === "text").map((part) => text(part.text)).join("\n");
    const excerpt = saved.slice(0, 4096).split("\n").filter(Boolean).slice(0, 8);
    if (context.isError || options.isPartial) return {
      summary: context.isError ? "Workplan error" : "Workplan partial result",
      notices: context.isError && options.isPartial ? ["Partial result"] : [],
      lines: excerpt, omitted: true, tone: context.isError ? "error" : "warning",
    };
    const details = object(result.details);
    const fallback = (notices: string[] = []) => ({ summary: "Workplan saved text · format uncertain", notices, lines: excerpt, omitted: true });
    if (details?.protocol !== "grounded-state-result/v1") return fallback();
    const notices: string[] = [];
    if (typeof details.fullOutputPath === "string") notices.push(`Native text bounded; full output: ${details.fullOutputPath}`);
    if (Array.isArray(details.metadataOmissions) && details.metadataOmissions.length) notices.push(`Metadata omitted for ${details.metadataOmissions.length} plan(s); use workplan read`);
    const value = object(details.result);
    if (details.action === "recover") {
      const recovery = object(details.recovery);
      notices.push("Bounded recovery; full plan: workplan read");
      const sections = recovery && typeof recovery.planId === "string" && count(recovery.revision) && !details.fullOutputPath
        && typeof details.result === "string" && details.result === saved ? recoverySections(saved, recovery.planId) : undefined;
      if (!sections) return fallback(["Recovery sections ambiguous or incomplete", ...notices]);
      const stale = sections.checkpoint.match(/^(Latest checkpoint: WP[1-9][0-9]*-K[1-9][0-9]* at revision (?:[1-9][0-9]*|unknown) \(plan changed afterward\)):/);
      if (stale) notices.unshift("Checkpoint (plan changed afterward)");
      return { summary: `${recovery!.planId} r${recovery!.revision} recovery`, notices,
        lines: options.expanded ? [sections.focus, "Next actions:", ...sections.actions.slice(0, 4), sections.position[0]!] : [], omitted: true };
    }
    if (details.action === "list" && Array.isArray(details.result) && details.result.length <= 256
      && details.result.every((item) => object(item) && typeof item.id === "string" && typeof item.title === "string" && typeof item.status === "string" && count(item.revision))) {
      return { summary: `${details.result.length} workplan(s)`, notices,
        lines: options.expanded ? details.result.slice(0, 8).map((item) => `${item.id} r${item.revision} [${item.status}] ${item.title}`) : [], omitted: details.result.length > 0 };
    }
    if (details.action === "status" && value && typeof value.planId === "string" && count(value.revision)
      && typeof value.status === "string" && count(value.blocked) && object(value.milestones)
      && count(value.milestones.completed) && count(value.milestones.total)) {
      if (value.blocked) notices.push(`${value.blocked} blocked milestone(s)`);
      // The native cache omission warning is text-only and always at the end.
      if (saved.endsWith(`\n[Status cache omits complete fields; use workplan read for ${value.planId}]\n`)) notices.push("Status cache omits fields; use workplan read");
      return { summary: `${value.planId} r${value.revision} [${value.status}]`, notices,
        lines: options.expanded ? [`Milestones: ${value.milestones.completed}/${value.milestones.total} completed`, ...excerpt] : [], omitted: true };
    }
    if (mutations.includes(details.action) && value && value.action === details.action && typeof value.planId === "string" && count(value.revision)) {
      const lines = saved.split("\n");
      const changed = lines.indexOf("## What changed");
      const preview = changed >= 0 && lines.lastIndexOf("## What changed") === changed ? lines.slice(changed + 1, changed + 9) : excerpt;
      return { summary: `${details.action} ${value.planId} r${value.revision}`, notices, lines: options.expanded ? preview : [], omitted: true };
    }
    if (details.action === "read" && typeof details.result === "string") return { summary: excerpt[0] || "Workplan saved read", notices, lines: options.expanded ? excerpt.slice(1) : [], omitted: true };
    return fallback(notices);
  },
});
