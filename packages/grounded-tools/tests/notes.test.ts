import assert from "node:assert/strict";
import test from "node:test";
import {
  applyNoteEvent,
  emptyNotesState,
  performNotesAction,
  renderNoteRead,
  type NotesState,
} from "@grounded/pi-core/notes";
import { makeStateEvent } from "@grounded/pi-core/state";

function run(state: NotesState, input: Record<string, unknown>, now: number) {
  return performNotesAction(state, input, now);
}

test("notes add, exact read, literal append, update, archive, remove, and clear archived", () => {
  let state = emptyNotesState();
  let op = run(state, { action: "add", title: "  Title  ", body: "a\r\nb", tags: [" one ", "Two"] }, 0);
  state = op.state;
  assert.deepEqual(op.result, { id: "N1", revision: 1 });
  const read = run(state, { action: "read", id: "N1" }, 1).result as any;
  assert.equal(read.title, "  Title  ");
  assert.equal(read.body, "a\nb");
  assert.deepEqual(read.tags, ["one", "Two"]);
  assert.match(renderNoteRead(read), /a\nb\n$/);

  op = run(state, { action: "append", id: "N1", body: "X", expectedRevision: 1 }, 2); state = op.state;
  assert.equal((run(state, { action: "read", id: "N1" }, 3).result as any).body, "a\nbX");
  op = run(state, { action: "update", id: "N1", title: "", body: "new", tags: [], expectedRevision: 2 }, 4); state = op.state;
  assert.equal((op.result as any).revision, 3);
  op = run(state, { action: "archive", id: "N1", expectedRevision: 3 }, 5); state = op.state;
  assert.equal((run(state, { action: "read", id: "N1" }, 6).result as any).status, "archived");
  op = run(state, { action: "clear_archived" }, 7); state = op.state;
  assert.deepEqual(op.result, { removedIds: ["N1"] });
  op = run(state, { action: "add", body: "second" }, 8); state = op.state;
  assert.deepEqual(op.result, { id: "N2", revision: 1 });
  op = run(state, { action: "remove", id: "N2", expectedRevision: 1 }, 9); state = op.state;
  assert.equal(state.notes.length, 0);
  assert.equal(state.nextNoteNumber, 3);
});

test("notes failures are transactional and safe errors omit supplied and stored prose", () => {
  let state = run(emptyNotesState(), { action: "add", body: "stored-private-prose" }, 0).state;
  const before = structuredClone(state);
  for (const input of [
    { action: "append", id: "N1", body: "supplied-private-prose", expectedRevision: 9 },
    { action: "update", id: "N1", expectedRevision: 1 },
    { action: "update", id: "N1", body: "   ", expectedRevision: 1 },
    { action: "archive", id: "missing", expectedRevision: 1 },
    { action: "read", id: "N1", query: "unused" },
  ]) {
    let text = "";
    assert.throws(() => run(state, input, 1), (error: unknown) => {
      text = String(error);
      return true;
    });
    assert.equal(text.includes("stored-private-prose"), false);
    assert.equal(text.includes("supplied-private-prose"), false);
    assert.deepEqual(state, before);
  }
});

test("notes list omits bodies and search is deterministic, sorted, paged, and bounded", () => {
  let state = emptyNotesState();
  state = run(state, { action: "add", title: "z", body: `${"x".repeat(90)}Needle${"y".repeat(100)}`, tags: [] }, 0).state;
  state = run(state, { action: "add", title: "Needle title", body: "other body", tags: [] }, 1).state;
  const listed = run(state, { action: "list", cursor: 0, limit: 1 }, 2).result as any;
  assert.equal(listed.total, 2);
  assert.equal(listed.nextCursor, 1);
  assert.equal(Object.hasOwn(listed.items[0], "body"), false);
  assert.equal(JSON.stringify(listed).includes("other body"), false);
  const searched = run(state, { action: "search", query: "needle", cursor: 0, limit: 20 }, 3).result as any;
  assert.deepEqual(searched.items.map((item: any) => item.id), ["N1", "N2"]);
  assert.ok([...searched.items[0].match].length <= 160);
  assert.match(searched.items[0].match.toLowerCase(), /needle/);
});

test("notes enforce title, body, tag, count, and total byte limits", () => {
  assert.throws(() => run(emptyNotesState(), { action: "add", title: "x".repeat(201), body: "x" }, 0), /STATE_LIMIT_EXCEEDED/);
  assert.throws(() => run(emptyNotesState(), { action: "add", body: "😀".repeat(8193) }, 0), /STATE_LIMIT_EXCEEDED/);
  assert.throws(() => run(emptyNotesState(), { action: "add", body: "x", tags: ["a", "a"] }, 0), /STATE_INVALID_INPUT/);
  assert.throws(() => run(emptyNotesState(), { action: "add", body: "x", tags: Array.from({ length: 17 }, (_, index) => String(index)) }, 0), /STATE_LIMIT_EXCEEDED/);

  let state = emptyNotesState();
  for (let index = 0; index < 256; index++) state = run(state, { action: "add", body: "x" }, index).state;
  assert.throws(() => run(state, { action: "add", body: "x" }, 300), /STATE_LIMIT_EXCEEDED/);
});

test("notes enforce the total live note-body byte limit", () => {
  let state = emptyNotesState();
  const fullBody = "x".repeat(32 * 1024);
  for (let index = 0; index < 32; index++) {
    state = run(state, { action: "add", body: fullBody }, index).state;
  }
  const before = structuredClone(state);
  assert.throws(() => run(state, { action: "add", body: "x" }, 100), /STATE_LIMIT_EXCEEDED/);
  assert.deepEqual(state, before);
});

test("notes replay exact events, ignores no event itself, and stops on skipped or malformed current events", () => {
  const first = run(emptyNotesState(), { action: "add", body: "one" }, 0);
  const replayed = applyNoteEvent(emptyNotesState(), first.event);
  assert.deepEqual(replayed, first.state);
  const skipped = { ...first.event!, baseStateRevision: 1, stateRevision: 2 };
  assert.throws(() => applyNoteEvent(emptyNotesState(), skipped), /STATE_CORRUPT/);
  const unknownKey = { ...first.event!, data: { ...(first.event!.data as object), extra: true } };
  assert.throws(() => applyNoteEvent(emptyNotesState(), unknownKey), /STATE_CORRUPT/);
  const unsafe = makeStateEvent("notes", "clear_archived", 0, "2026-08-01T00:00:00.000Z", { ids: [], unsafe: Number.MAX_SAFE_INTEGER + 1 });
  assert.throws(() => applyNoteEvent(emptyNotesState(), unsafe), /STATE_CORRUPT/);
});

test("divergent notes branches can allocate the same next ID independently", () => {
  const root = run(emptyNotesState(), { action: "add", body: "root" }, 0).state;
  const left = run(structuredClone(root), { action: "add", body: "left" }, 1).state;
  const right = run(structuredClone(root), { action: "add", body: "right" }, 2).state;
  assert.equal(left.notes[1]!.id, "N2");
  assert.equal(right.notes[1]!.id, "N2");
  assert.notEqual(left.notes[1]!.body, right.notes[1]!.body);
});
