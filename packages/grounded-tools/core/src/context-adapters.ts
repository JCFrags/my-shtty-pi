import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  fitProviderPage, registerContextProvider, sameScope,
  type Category, type ContextCard, type ContextRequest, type ProviderId, type ProviderPage,
} from "@context-kit/protocol";
import type { Note, NotesState } from "./notes.ts";
import type { Task, TaskState } from "./tasks.ts";
import type { Workplan, WorkplanState } from "./workplan.ts";

const SCAN_RECORDS = 128;
const SCAN_CHARS = 4096;
const ARRAY_ITEMS = 8;
const TEXT_BYTES = 1536;
type Field = { name: string; text: string; category: Category };
type Relations = NonNullable<ContextCard["relations"]>;

/** Per-record limits apply before searching or copying text and nested collections. */
class Fields {
  values: Field[] = [];
  omitted = new Set<string>();
  complete = true;
  private remaining = SCAN_CHARS;

  omit(name: string): void { this.omitted.add(name); this.complete = false; }
  add(name: string, value: string | undefined, category: Category): void {
    if (!value) return;
    const text = value.slice(0, this.remaining);
    this.remaining -= text.length;
    if (text.length !== value.length) this.omit(name);
    if (text) this.values.push({ name, text, category });
  }
  array<T>(name: string, items: readonly T[], add: (item: T) => void, recent = false): void {
    if (items.length > ARRAY_ITEMS) this.omit(name);
    for (let i = 0; i < Math.min(ARRAY_ITEMS, items.length); i++) {
      add(items[recent ? items.length - 1 - i : i]!);
    }
  }
}

function prefix(value: string, bytes: number): string {
  // The input has already been bounded. Iteration preserves Unicode code points.
  let result = "", used = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > bytes) break;
    result += char;
    used += size;
  }
  return result;
}
function identifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && Buffer.byteLength(value, "utf8") <= 128;
}
function links(ids: readonly string[], type: Relations[number]["type"], fields: Fields, name: string): Relations {
  const result: Relations = [];
  if (ids.length > ARRAY_ITEMS) fields.omit(name);
  for (let i = 0; i < Math.min(ids.length, ARRAY_ITEMS); i++) {
    const id = ids[i]!;
    if (identifier(id)) result.push({ type, providerId: "todo", id });
    else fields.omit(name);
  }
  return result;
}

interface RecordView {
  id: string; revision: string; status: string; title: string;
  fields: Fields; relations?: Relations;
}
function taskView(task: Task, request: ContextRequest): RecordView {
  const fields = new Fields();
  const category = task.status === "blocked" && (!request.categories.length || request.categories.includes("blocker")) ? "blocker" : "task";
  fields.add("text", task.text, category);
  fields.add("waitReason", task.waitReason, category);
  fields.add("description", task.description, category);
  const relations = links(task.blockedBy, "blocked_by", fields, "blockedBy");
  // Todo has no revision counter. Preserve its native updatedAt value without inventing one.
  return { id: task.id, revision: String(task.updatedAt), status: task.status, title: task.text, fields, relations };
}
function noteView(note: Note): RecordView {
  const fields = new Fields();
  fields.add("title", note.title, "note");
  fields.add("body", note.body, "note");
  fields.array("tags", note.tags, (tag) => fields.add("tags", tag, "note"));
  return { id: note.id, revision: String(note.revision), status: note.status, title: note.title, fields };
}
function planView(plan: Workplan): RecordView {
  const fields = new Fields();
  fields.add("title", plan.title, "plan");
  fields.add("objective", plan.objective, "plan");
  fields.array("constraints", plan.constraints, (text) => fields.add("constraints", text, "constraint"));
  fields.array("decisions", plan.decisions, (decision) => {
    fields.add("decisions", decision.decision, "decision");
    fields.add("decisions", decision.rationale, "decision");
  }, true);
  const relations: Relations = [];
  fields.array("milestones", plan.milestones, (milestone) => {
    const category = milestone.status === "blocked" ? "blocker" : "plan";
    fields.add("milestones", milestone.title, category);
    fields.add("milestones", milestone.description, category);
    const linked = links(milestone.linkedTodoIds, "linked_todo", fields, "milestones.linkedTodoIds");
    for (const relation of linked) {
      if (relations.some((existing) => existing.id === relation.id)) continue;
      if (relations.length < ARRAY_ITEMS) relations.push(relation);
      else fields.omit("milestones.linkedTodoIds");
    }
    if (milestone.dependsOn.length || milestone.evidence.length || milestone.acceptanceCriteria.length) fields.omit("milestones");
  });
  fields.array("checkpoints", plan.checkpoints, (checkpoint) => {
    fields.add("checkpoints", checkpoint.summary, "plan");
    fields.add("checkpoints", checkpoint.currentFocus, "plan");
    fields.array("checkpoints", checkpoint.nextActions ?? [], (text) => fields.add("checkpoints", text, "plan"));
    if (checkpoint.criterionEvidence.length) fields.omit("checkpoints");
  }, true);
  fields.add("approach", plan.approach, "plan");
  fields.add("background", plan.background, "plan");
  for (const name of ["scope", "nonGoals", "verification"] as const) fields.array(name, plan[name], (text) => fields.add(name, text, "plan"));
  fields.array("acceptanceCriteria", plan.acceptanceCriteria, (item) => fields.add("acceptanceCriteria", item.text, "plan"));
  fields.array("risks", plan.risks, (risk) => {
    fields.add("risks", risk.description, "plan");
    fields.add("risks", risk.impact, "plan");
    fields.add("risks", risk.mitigation, "plan");
  });
  fields.array("openQuestions", plan.openQuestions, (question) => {
    fields.add("openQuestions", question.question, "plan");
    fields.add("openQuestions", question.answer, "plan");
  });
  // Revision history and internal counters are not current-state search fields.
  return { id: plan.id, revision: String(plan.revision), status: plan.status, title: plan.title, fields, relations };
}

function card(view: RecordView, request: ContextRequest, terms: string[]): { value?: ContextCard; score: number; matched: boolean } {
  const { fields } = view;
  const title = prefix(view.title.slice(0, 256), 256);
  if (title.length !== view.title.length) fields.omit(request.providerId === "todo" ? "text" : "title");
  const titleText = title.toLowerCase();
  const ranked = fields.values.filter((field) => !request.categories.length || request.categories.includes(field.category))
    .map((field, index) => ({ field, index, score: terms.reduce((n, term) => n + (field.text.toLowerCase().includes(term) ? 2 : titleText.includes(term) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (!ranked.length || (terms.length && !ranked[0]!.score)) return { score: 0, matched: false };
  if (!identifier(view.id) || !identifier(view.revision)) return { score: ranked[0]!.score, matched: true };
  const category = ranked[0]!.field.category;
  const selected = new Set<Field>();
  let text = "";
  for (const { field } of ranked) {
    if (field.category !== category || selected.size >= 3) continue;
    const lower = field.text.toLowerCase();
    const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
    const start = positions.length ? Math.max(0, Math.min(...positions) - 96) : 0;
    const label = `${text ? "\n" : ""}${field.name}: `;
    const available = TEXT_BYTES - Buffer.byteLength(text + label, "utf8");
    if (available <= 0) break;
    const excerpt = prefix(field.text.slice(start), available);
    if (!excerpt) break;
    if (start || excerpt.length !== field.text.length) fields.omit(field.name);
    text += label + excerpt;
    selected.add(field);
  }
  for (const field of fields.values) if (!selected.has(field) && field.name !== "title") fields.omit(field.name);
  const recovery: ContextCard["recovery"] = request.providerId === "todo" ? { tool: "todo", args: { action: "list" } }
    : request.providerId === "notes" ? { tool: "notes", args: { action: "read", id: view.id } }
      : { tool: "workplan", args: { action: "recover", planId: view.id } };
  return { score: ranked[0]!.score, matched: true, value: {
    id: view.id, revision: view.revision, status: view.status, category, title, text,
    omittedFields: [...fields.omitted], recovery,
    ...(view.relations?.length ? { relations: view.relations } : {}),
  } };
}

function page<T>(request: ContextRequest, records: readonly T[], project: (record: T) => RecordView): ProviderPage {
  const allTerms = [...new Set(request.query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  const terms = allTerms.slice(0, 16);
  const count = Math.min(records.length, request.limits.scan, SCAN_RECORDS);
  let complete = count === records.length && terms.length === allTerms.length;
  let matched = 0;
  const selected: { card: ContextCard; score: number; index: number }[] = [];
  for (let index = 0; index < count; index++) {
    const view = project(records[index]!);
    const result = card(view, request, terms);
    complete &&= view.fields.complete;
    if (!result.matched) continue;
    matched++;
    if (!result.value) { complete = false; continue; }
    selected.push({ card: result.value, score: result.score, index });
    selected.sort((a, b) => b.score - a.score || a.index - b.index);
    // Keep only bounded candidates. fitProviderPage accounts for complete wire bytes.
    if (selected.length > request.limits.records) selected.pop();
  }
  return fitProviderPage(request, { readiness: "ready", cards: selected.map((item) => item.card),
    coverage: { scanned: count, matched, excluded: matched - selected.length, scanComplete: complete } });
}

type States = { todo: TaskState; notes: NotesState; workplan: WorkplanState };
interface Snapshot<P extends ProviderId> {
  context: Pick<ExtensionContext, "sessionManager"> | undefined;
  state: States[P]; pending: boolean; corrupt: boolean;
}
function refusal(readiness: Exclude<ProviderPage["readiness"], "ready">): ProviderPage {
  return { readiness, cards: [], coverage: { scanned: 0, matched: 0, excluded: 0, scanComplete: false } };
}

/** Optional read-only adapter. It never restores, persists, or mutates native state. */
export function registerNativeContextProvider<P extends ProviderId>(
  pi: Pick<ExtensionAPI, "events" | "getActiveTools">, providerId: P, snapshot: () => Snapshot<P>,
): () => void {
  try {
    const remove = registerContextProvider(pi.events, providerId, (request) => {
      const current = snapshot();
      const manager = current.context?.sessionManager;
      if (!manager || !pi.getActiveTools().includes(providerId)) return refusal("unavailable");
      const scope = { sessionId: manager.getSessionId(), leafId: manager.getLeafId() };
      if (!sameScope(scope, request.scope)) return refusal("scope_changed");
      if (current.corrupt) return refusal("corrupt");
      if (current.pending) return refusal("pending");
      const result = providerId === "todo" ? page(request, (current.state as TaskState).tasks, (task) => taskView(task, request))
        : providerId === "notes" ? page(request, (current.state as NotesState).notes, noteView)
          : page(request, (current.state as WorkplanState).plans, planView);
      // Re-read the live getter. Do not answer for a view replaced during projection.
      const live = snapshot();
      if (!live.context || !sameScope(request.scope, {
        sessionId: live.context.sessionManager.getSessionId(), leafId: live.context.sessionManager.getLeafId(),
      })) return refusal("scope_changed");
      if (live.corrupt) return refusal("corrupt");
      if (live.pending) return refusal("pending");
      if (!pi.getActiveTools().includes(providerId)) return refusal("unavailable");
      return result;
    });
    return () => { try { remove(); } catch { /* Adapter cleanup cannot fail native shutdown. */ } };
  } catch {
    // Native tools remain usable if the optional transport cannot register.
    return () => {};
  }
}
