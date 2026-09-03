import { homedir } from "node:os";
import type { ProjectGlanceCurrent } from "../protocol/model.js";
import type { TodoCurrentTask, WorkplanCurrentPlan } from "./contracts.js";

const MAX_CURRENT_TEXT_BYTES = 512;

function clipUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(`${output}${character}…`, "utf8") > maximumBytes) break;
    output += character;
  }
  return `${output}…`;
}

function replaceHome(value: string): string {
  const home = homedir();
  if (!home || home === "/") return value;
  return value === home ? "$HOME" : value.startsWith(`${home}/`) ? `$HOME${value.slice(home.length)}` : value;
}

export function displayText(value: string, maximumBytes = MAX_CURRENT_TEXT_BYTES): string | undefined {
  if (/[\uD800-\uDFFF]/u.test(value)) return undefined;
  const normalized = replaceHome(value.normalize("NFC").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim());
  if (!normalized) return undefined;
  return clipUtf8(normalized, maximumBytes);
}

function displayId(value: string | undefined): string | undefined {
  return value === undefined ? undefined : displayText(value, 128);
}

export function formatStep(task: TodoCurrentTask | undefined): string | undefined {
  if (!task || task.status === "done") return undefined;
  const text = displayText(task.text);
  if (!text) return undefined;
  const id = displayId(task.id);
  const base = id ? `${id}  ${text}` : text;
  const waiting = task.waitReason && (task.status === "blocked" || task.status === "in_progress")
    ? displayText(task.waitReason, 384)
    : undefined;
  return clipUtf8(waiting ? `${base} — waiting: ${waiting}` : base, MAX_CURRENT_TEXT_BYTES);
}

export function formatToward(plan: WorkplanCurrentPlan | undefined): string | undefined {
  const milestone = plan?.currentMilestone;
  if (!milestone) return undefined;
  const id = displayId(milestone.id);
  const title = displayText(milestone.title);
  if (!title) return undefined;
  const base = id ? `${id}  ${title}` : title;
  return clipUtf8(milestone.status === "blocked" ? `${base} — blocked` : base, MAX_CURRENT_TEXT_BYTES);
}

export function formatFocus(plan: WorkplanCurrentPlan | undefined): string | undefined {
  return plan?.latestCheckpoint?.currentFocus ? displayText(plan.latestCheckpoint.currentFocus) : undefined;
}

export function formatCurrentProjection(
  todo: TodoCurrentTask | undefined,
  workplan: WorkplanCurrentPlan | undefined,
): ProjectGlanceCurrent {
  const step = formatStep(todo);
  const toward = formatToward(workplan);
  const focus = formatFocus(workplan);
  return {
    ...(step ? { step } : {}),
    ...(toward ? { toward } : {}),
    ...(focus ? { focus } : {}),
  };
}
