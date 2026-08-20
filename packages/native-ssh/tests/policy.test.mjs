import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../src/policy.mjs";

test("ordinary remote commands run without a confirmation classification", () => {
  for (const command of ["uname -a", "systemctl status nginx", "printf hello > note.txt", "rm one-disposable-file", "git status"]) assert.equal(classifyCommand(command), null);
});

test("clear destructive, trust, and credential actions are classified", () => {
  assert.equal(classifyCommand("rm -rf /tmp/example").kind, "destructive");
  assert.equal(classifyCommand("ssh-keygen -R host").kind, "trust");
  assert.equal(classifyCommand("cat ~/.ssh/id_ed25519").kind, "credential");
});
