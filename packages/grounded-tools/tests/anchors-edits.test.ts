import assert from "node:assert/strict";
import test from "node:test";
import { anchorDocument } from "@grounded/pi-core/anchors";
import { applyReplacements, strictReplacements } from "../packages/files/index.ts";

test("anchors are unique for repeated lines and stable across unrelated lines", () => {
  const first = anchorDocument("same\nalpha\nsame\nomega");
  const second = anchorDocument("same\nchanged\nsame\nomega");
  assert.notEqual(first.anchors[0], first.anchors[2]);
  assert.equal(first.anchors[0], second.anchors[0]);
  assert.equal(first.anchors[2], second.anchors[2]);
  assert.notEqual(first.digest, second.digest);
});

test("strict exact edits are literal and batched against one snapshot", () => {
  const source = "const price = '$&';\nconst name = 'old';\n";
  const replacements = strictReplacements(source, [
    { oldText: "'$&'", newText: "'$`-$&-$\''" },
    { oldText: "'old'", newText: "'new'" },
  ]);
  assert.equal(applyReplacements(source, replacements), "const price = '$`-$&-$\'';\nconst name = 'new';\n");
});

test("strict edits reject duplicate and overlapping targets", () => {
  assert.throws(() => strictReplacements("x\nx\n", [{ oldText: "x", newText: "y" }]), /matched 2/);
  assert.throws(() => strictReplacements("aaa", [{ oldText: "aa", newText: "y" }]), /matched 2/);
  assert.throws(
    () => strictReplacements("abcdef", [
      { oldText: "abcd", newText: "x" },
      { oldText: "cdef", newText: "y" },
    ]),
    /overlap/,
  );
});

test("anchored edits require and verify the snapshot digest", () => {
  const source = "one\ntwo\nthree\n";
  const document = anchorDocument(source);
  const edit = {
    startAnchor: document.anchors[1]!,
    endAnchor: document.anchors[1]!,
    contentLines: ["TWO", "2b"],
  };
  assert.throws(() => strictReplacements(source, [edit]), /requires expectedDigest/);
  assert.throws(() => strictReplacements(source, [edit], "bad"), /stale/);
  const replacements = strictReplacements(source, [edit], document.digest);
  assert.equal(applyReplacements(source, replacements), "one\nTWO\n2b\nthree\n");
});
