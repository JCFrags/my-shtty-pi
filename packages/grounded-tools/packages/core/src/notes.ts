import {
  cloneJson,
  compareNumericIds,
  makeStateEvent,
  normalizeStateText,
  requireCodePoints,
  requireExactObject,
  requireNonBlank,
  requirePlainJson,
  requireSafeInteger,
  requireString,
  requireStringArray,
  requireUnique,
  requireUtf8,
  stateError,
  type StateEvent,
  validateStateEventEnvelope,
} from "./state.ts";

export type NoteStatus = "active" | "archived";

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  status: NoteStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotesState {
  notes: Note[];
  nextNoteNumber: number;
  stateRevision: number;
}

export type NotesAction =
  | "add"
  | "list"
  | "read"
  | "append"
  | "update"
  | "search"
  | "archive"
  | "remove"
  | "clear_archived";

export interface NotesInput {
  action: NotesAction;
  id?: string;
  title?: string;
  body?: string;
  tags?: string[];
  query?: string;
  cursor?: number;
  limit?: number;
  expectedRevision?: number;
}

export type NoteEvent = StateEvent<NotesAction, Record<string, unknown>>;

export interface NoteMetadata {
  id: string;
  title: string;
  tags: string[];
  status: NoteStatus;
  revision: number;
  updatedAt: string;
}

export interface NotesPage<T> {
  items: T[];
  cursor: number;
  limit: number;
  total: number;
  nextCursor?: number;
}

export interface NotesOperation {
  state: NotesState;
  event?: NoteEvent;
  result: unknown;
  page?: NotesPage<unknown>;
}

const NOTE_ID = /^N([1-9][0-9]*)$/;
const ACTIONS = new Set<NotesAction>([
  "add", "list", "read", "append", "update", "search", "archive", "remove", "clear_archived",
]);

export function emptyNotesState(): NotesState {
  return { notes: [], nextNoteNumber: 1, stateRevision: 0 };
}

export function cloneNotesState(state: NotesState): NotesState {
  return cloneJson(state);
}

function corrupt(condition: boolean, message: string): void {
  if (!condition) stateError("STATE_CORRUPT", message);
}

function validateNote(note: Note, code: "STATE_CORRUPT" | "STATE_LIMIT_EXCEEDED" = "STATE_CORRUPT"): void {
  if (!note || typeof note !== "object" || Array.isArray(note)) stateError(code, "A note has an invalid shape");
  const exact = Object.keys(note).sort().join(",") === [
    "body", "createdAt", "id", "revision", "status", "tags", "title", "updatedAt",
  ].sort().join(",");
  if (!exact) stateError(code, "A note has an invalid shape");
  if (!NOTE_ID.test(note.id)) stateError(code, "A note ID is invalid");
  if (typeof note.title !== "string" || typeof note.body !== "string") stateError(code, "A note text field is invalid");
  if (!Array.isArray(note.tags) || !note.tags.every((tag) => typeof tag === "string")) stateError(code, "A note tag is invalid");
  if (note.status !== "active" && note.status !== "archived") stateError(code, "A note status is invalid");
  if (!Number.isSafeInteger(note.revision) || note.revision < 1) stateError(code, "A note revision is invalid");
  if (typeof note.createdAt !== "string" || typeof note.updatedAt !== "string") stateError(code, "A note time is invalid");
  if (!/\S/u.test(note.body)) stateError(code, "A note body is blank");
  if ([...note.title].length > 200 || Buffer.byteLength(note.body, "utf8") > 32 * 1024) stateError(code, "A note text limit is exceeded");
  if (note.tags.length > 16 || new Set(note.tags).size !== note.tags.length) stateError(code, "A note tag limit is exceeded");
  for (const tag of note.tags) {
    if (!tag || tag !== tag.trim() || [...tag].length > 64) stateError(code, "A note tag is invalid");
  }
}

export function validateNotesState(state: NotesState): void {
  requirePlainJson(state, "notes state");
  requireExactObject(state, ["notes", "nextNoteNumber", "stateRevision"], [], "notes state", "STATE_CORRUPT");
  if (!Array.isArray(state.notes)) stateError("STATE_CORRUPT", "The notes list is invalid");
  requireSafeInteger(state.nextNoteNumber, "nextNoteNumber", 1, "STATE_CORRUPT");
  requireSafeInteger(state.stateRevision, "stateRevision", 0, "STATE_CORRUPT");
  if (state.notes.length > 256) stateError("STATE_CORRUPT", "The live note count is too large");
  const ids = new Set<string>();
  let maximum = 0;
  let bytes = 0;
  for (const note of state.notes) {
    validateNote(note as Note);
    if (ids.has(note.id)) stateError("STATE_CORRUPT", "A note ID is duplicated");
    ids.add(note.id);
    maximum = Math.max(maximum, Number(NOTE_ID.exec(note.id)![1]));
    bytes += Buffer.byteLength(note.body, "utf8");
  }
  if (bytes > 1024 * 1024) stateError("STATE_CORRUPT", "The total note body limit is exceeded");
  if (state.nextNoteNumber <= maximum) stateError("STATE_CORRUPT", "The next note number is not monotonic");
}

function validateTitle(value: string): string {
  const normalized = normalizeStateText(value);
  requireCodePoints(normalized, 200, "title");
  return normalized;
}

function validateBody(value: string): string {
  const normalized = normalizeStateText(value);
  requireNonBlank(normalized, "body");
  requireUtf8(normalized, 32 * 1024, "body");
  return normalized;
}

function validateTags(value: string[]): string[] {
  if (value.length > 16) stateError("STATE_LIMIT_EXCEEDED", `tags has ${value.length} items; maximum is 16`);
  const tags = value.map((tag) => {
    const normalized = normalizeStateText(tag).trim();
    if (!normalized) stateError("STATE_INVALID_INPUT", "A tag must not be empty");
    requireCodePoints(normalized, 64, "tag");
    return normalized;
  });
  requireUnique(tags, "tags", "STATE_INVALID_INPUT");
  return tags;
}

function noteById(state: NotesState, id: string): Note {
  const note = state.notes.find((candidate) => candidate.id === id);
  if (!note) stateError("STATE_NOT_FOUND", `Note ${id} does not exist on the current branch`);
  return note;
}

function requireExpected(note: Note, expected: number): void {
  if (note.revision !== expected) {
    stateError("STATE_REVISION_MISMATCH", `Note ${note.id} is revision ${note.revision}; expected ${expected}`);
  }
}

function validateCompleteLimits(state: NotesState): void {
  if (state.notes.length > 256) stateError("STATE_LIMIT_EXCEEDED", "The branch can contain at most 256 live notes");
  const bytes = state.notes.reduce((total, note) => total + Buffer.byteLength(note.body, "utf8"), 0);
  if (bytes > 1024 * 1024) stateError("STATE_LIMIT_EXCEEDED", "The branch can contain at most 1 MiB of live note bodies");
  for (const note of state.notes) validateNote(note, "STATE_LIMIT_EXCEEDED");
}

function eventDataShape(action: NotesAction, data: unknown): asserts data is Record<string, unknown> {
  if (action === "add") requireExactObject(data, ["note"], [], "event data", "STATE_CORRUPT");
  else if (action === "append") requireExactObject(data, ["id", "baseRevision", "revision", "text"], [], "event data", "STATE_CORRUPT");
  else if (action === "update") requireExactObject(data, ["id", "baseRevision", "revision", "changes"], [], "event data", "STATE_CORRUPT");
  else if (action === "archive") requireExactObject(data, ["id", "baseRevision", "revision"], [], "event data", "STATE_CORRUPT");
  else if (action === "remove") requireExactObject(data, ["id", "baseRevision"], [], "event data", "STATE_CORRUPT");
  else if (action === "clear_archived") requireExactObject(data, ["ids"], [], "event data", "STATE_CORRUPT");
  else stateError("STATE_CORRUPT", "A read-only notes action has a state event");
}

export function applyNoteEvent(current: NotesState, value: unknown): NotesState {
  validateNotesState(current);
  validateStateEventEnvelope(value, "notes", current.stateRevision);
  if (!ACTIONS.has(value.action as NotesAction)) stateError("STATE_CORRUPT", "The note event action is unknown");
  const action = value.action as NotesAction;
  eventDataShape(action, value.data);
  const data = value.data;
  const state = cloneNotesState(current);

  if (action === "add") {
    const note = data.note as Note;
    validateNote(note);
    const match = NOTE_ID.exec(note.id);
    corrupt(Boolean(match), "The added note ID is invalid");
    const expectedId = `N${state.nextNoteNumber}`;
    corrupt(note.id === expectedId, "The added note ID is not next");
    corrupt(note.revision === 1, "The added note revision is invalid");
    corrupt(note.createdAt === value.at && note.updatedAt === value.at, "The added note time is invalid");
    corrupt(note.status === "active", "The added note status is invalid");
    state.notes.push(cloneJson(note));
    state.nextNoteNumber++;
  } else if (action === "append") {
    requireString(data.id, "id", "STATE_CORRUPT");
    requireSafeInteger(data.baseRevision, "baseRevision", 1, "STATE_CORRUPT");
    requireSafeInteger(data.revision, "revision", 2, "STATE_CORRUPT");
    requireString(data.text, "text", "STATE_CORRUPT");
    const note = noteById(state, data.id);
    corrupt(note.revision === data.baseRevision && data.revision === data.baseRevision + 1, "The note revision chain is invalid");
    note.body += data.text;
    note.revision = data.revision;
    note.updatedAt = value.at;
  } else if (action === "update") {
    requireString(data.id, "id", "STATE_CORRUPT");
    requireSafeInteger(data.baseRevision, "baseRevision", 1, "STATE_CORRUPT");
    requireSafeInteger(data.revision, "revision", 2, "STATE_CORRUPT");
    requireExactObject(data.changes, [], ["title", "body", "tags"], "changes", "STATE_CORRUPT");
    corrupt(Object.keys(data.changes).length > 0, "The note changes are empty");
    const note = noteById(state, data.id);
    corrupt(note.revision === data.baseRevision && data.revision === data.baseRevision + 1, "The note revision chain is invalid");
    if (Object.hasOwn(data.changes, "title")) {
      requireString(data.changes.title, "title", "STATE_CORRUPT");
      note.title = data.changes.title;
    }
    if (Object.hasOwn(data.changes, "body")) {
      requireString(data.changes.body, "body", "STATE_CORRUPT");
      note.body = data.changes.body;
    }
    if (Object.hasOwn(data.changes, "tags")) {
      requireStringArray(data.changes.tags, "tags", "STATE_CORRUPT");
      note.tags = [...data.changes.tags];
    }
    note.revision = data.revision;
    note.updatedAt = value.at;
  } else if (action === "archive") {
    requireString(data.id, "id", "STATE_CORRUPT");
    requireSafeInteger(data.baseRevision, "baseRevision", 1, "STATE_CORRUPT");
    requireSafeInteger(data.revision, "revision", 2, "STATE_CORRUPT");
    const note = noteById(state, data.id);
    corrupt(note.status === "active", "The note archive transition is invalid");
    corrupt(note.revision === data.baseRevision && data.revision === data.baseRevision + 1, "The note revision chain is invalid");
    note.status = "archived";
    note.revision = data.revision;
    note.updatedAt = value.at;
  } else if (action === "remove") {
    requireString(data.id, "id", "STATE_CORRUPT");
    requireSafeInteger(data.baseRevision, "baseRevision", 1, "STATE_CORRUPT");
    const index = state.notes.findIndex((note) => note.id === data.id);
    if (index < 0) stateError("STATE_CORRUPT", "The removed note does not exist");
    corrupt(state.notes[index]!.revision === data.baseRevision, "The removed note revision is invalid");
    state.notes.splice(index, 1);
  } else {
    requireStringArray(data.ids, "ids", "STATE_CORRUPT");
    const archived = state.notes.filter((note) => note.status === "archived").sort((a, b) => compareNumericIds(a.id, b.id)).map((note) => note.id);
    corrupt(JSON.stringify(data.ids) === JSON.stringify(archived), "The archived note ID list is invalid");
    const removed = new Set(data.ids);
    state.notes = state.notes.filter((note) => !removed.has(note.id));
  }

  state.stateRevision = value.stateRevision;
  validateCompleteLimits(state);
  validateNotesState(state);
  return state;
}

function allowedFields(input: NotesInput, allowed: readonly (keyof NotesInput)[]): void {
  const set = new Set<keyof NotesInput>(["action", ...allowed]);
  const invalid = Object.keys(input).find((key) => !set.has(key as keyof NotesInput));
  if (invalid) stateError("STATE_INVALID_INPUT", `Field ${invalid} is not valid for action ${input.action}`);
}

function requireId(input: NotesInput): string {
  if (typeof input.id !== "string" || !NOTE_ID.test(input.id)) stateError("STATE_INVALID_INPUT", "id must be a note ID");
  return input.id;
}

function requireRevision(input: NotesInput): number {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 1) {
    stateError("STATE_INVALID_INPUT", "expectedRevision must be a positive safe integer");
  }
  return input.expectedRevision!;
}

function metadata(note: Note): NoteMetadata {
  return {
    id: note.id,
    title: note.title,
    tags: [...note.tags],
    status: note.status,
    revision: note.revision,
    updatedAt: note.updatedAt,
  };
}

function page<T>(items: T[], cursor: number, limit: number): NotesPage<T> {
  const selected = items.slice(cursor, cursor + limit);
  const next = cursor + selected.length;
  return {
    items: selected,
    cursor,
    limit,
    total: items.length,
    ...(next < items.length ? { nextCursor: next } : {}),
  };
}

function matchWindow(note: Note, query: string): string {
  const source = `${note.title}\n${note.body}\n${note.tags.join("\n")}`;
  const lowered = source.toLowerCase();
  const match = lowered.indexOf(query.toLowerCase());
  if (match < 0) return "";
  const beforePoints = [...source.slice(0, match)].length;
  const points = [...source];
  const start = Math.max(0, Math.min(beforePoints - 80, Math.max(0, points.length - 160)));
  return points.slice(start, start + 160).join("");
}

export function performNotesAction(current: NotesState, inputValue: unknown, now = Date.now()): NotesOperation {
  validateNotesState(current);
  requirePlainJson(inputValue, "input");
  requireExactObject(inputValue, ["action"], ["id", "title", "body", "tags", "query", "cursor", "limit", "expectedRevision"], "input");
  const input = inputValue as unknown as NotesInput;
  if (!ACTIONS.has(input.action)) stateError("STATE_INVALID_INPUT", "action is not a notes action");
  const at = new Date(now).toISOString();

  if (input.action === "list") {
    allowedFields(input, ["cursor", "limit"]);
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      stateError("STATE_INVALID_INPUT", "cursor or limit is invalid");
    }
    const result = page(current.notes.slice().sort((a, b) => compareNumericIds(a.id, b.id)).map(metadata), cursor, limit);
    return { state: current, result, page: result as NotesPage<unknown> };
  }

  if (input.action === "read") {
    allowedFields(input, ["id"]);
    const note = noteById(current, requireId(input));
    return { state: current, result: cloneJson(note) };
  }

  if (input.action === "search") {
    allowedFields(input, ["query", "cursor", "limit"]);
    if (typeof input.query !== "string") stateError("STATE_INVALID_INPUT", "query is required for search");
    const query = normalizeStateText(input.query);
    requireNonBlank(query, "query");
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      stateError("STATE_INVALID_INPUT", "cursor or limit is invalid");
    }
    const lowered = query.toLowerCase();
    const matches = current.notes
      .filter((note) => `${note.title}\n${note.body}\n${note.tags.join("\n")}`.toLowerCase().includes(lowered))
      .sort((a, b) => compareNumericIds(a.id, b.id))
      .map((note) => ({ ...metadata(note), match: matchWindow(note, query) }));
    const result = page(matches, cursor, limit);
    return { state: current, result, page: result as NotesPage<unknown> };
  }

  let data: Record<string, unknown>;
  if (input.action === "add") {
    allowedFields(input, ["title", "body", "tags"]);
    if (typeof input.body !== "string") stateError("STATE_INVALID_INPUT", "body is required for add");
    const note: Note = {
      id: `N${current.nextNoteNumber}`,
      title: validateTitle(input.title ?? ""),
      body: validateBody(input.body),
      tags: validateTags(input.tags ?? []),
      status: "active",
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    data = { note };
  } else if (input.action === "append") {
    allowedFields(input, ["id", "body", "expectedRevision"]);
    const note = noteById(current, requireId(input));
    const expected = requireRevision(input);
    requireExpected(note, expected);
    if (typeof input.body !== "string") stateError("STATE_INVALID_INPUT", "body is required for append");
    const text = normalizeStateText(input.body);
    const finalBody = validateBody(note.body + text);
    requireUtf8(finalBody, 32 * 1024, "body");
    data = { id: note.id, baseRevision: note.revision, revision: note.revision + 1, text };
  } else if (input.action === "update") {
    allowedFields(input, ["id", "title", "body", "tags", "expectedRevision"]);
    const note = noteById(current, requireId(input));
    requireExpected(note, requireRevision(input));
    const changes: Record<string, unknown> = {};
    if (input.title !== undefined) changes.title = validateTitle(input.title);
    if (input.body !== undefined) changes.body = validateBody(input.body);
    if (input.tags !== undefined) changes.tags = validateTags(input.tags);
    if (Object.keys(changes).length === 0) stateError("STATE_INVALID_INPUT", "update requires title, body, or tags");
    data = { id: note.id, baseRevision: note.revision, revision: note.revision + 1, changes };
  } else if (input.action === "archive") {
    allowedFields(input, ["id", "expectedRevision"]);
    const note = noteById(current, requireId(input));
    requireExpected(note, requireRevision(input));
    if (note.status !== "active") stateError("STATE_INVALID_TRANSITION", `Note ${note.id} is already archived`);
    data = { id: note.id, baseRevision: note.revision, revision: note.revision + 1 };
  } else if (input.action === "remove") {
    allowedFields(input, ["id", "expectedRevision"]);
    const note = noteById(current, requireId(input));
    requireExpected(note, requireRevision(input));
    data = { id: note.id, baseRevision: note.revision };
  } else {
    allowedFields(input, []);
    data = {
      ids: current.notes.filter((note) => note.status === "archived").sort((a, b) => compareNumericIds(a.id, b.id)).map((note) => note.id),
    };
  }

  const event = makeStateEvent("notes", input.action, current.stateRevision, at, data) as NoteEvent;
  const state = applyNoteEvent(current, event);
  const result = input.action === "add"
    ? { id: (data.note as Note).id, revision: 1 }
    : input.action === "clear_archived"
      ? { removedIds: cloneJson(data.ids) }
      : input.action === "remove"
        ? { id: data.id, removed: true }
        : { id: data.id, revision: data.revision };
  return { state, event, result };
}

export function renderNoteRead(note: Note): string {
  return [
    `# ${note.id}`,
    `Title: ${note.title}`,
    `Status: ${note.status}`,
    `Revision: ${note.revision}`,
    `Created: ${note.createdAt}`,
    `Updated: ${note.updatedAt}`,
    `Tags: ${note.tags.length ? note.tags.join(", ") : "None"}`,
    "",
    note.body,
    "",
  ].join("\n");
}
