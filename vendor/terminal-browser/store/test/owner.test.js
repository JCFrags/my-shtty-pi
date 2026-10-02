const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  browserOwnerColumns,
  browserOwnerEnvironment,
  browserOwnerFromColumns,
  parseBrowserOwner,
  requireHerdrBrowserOwner,
  sameBrowserOwner,
  nativeBrowserOwner,
  isNativeBrowserOwner,
} = require("../dist/owner");

const owner = {
  workspaceId: "w1",
  tabId: "w1:t2",
  paneId: "w1:p3",
  sessionId: "session-a",
  projectDir: "/tmp/project-a",
};

test("owner metadata round-trips through environment and registry columns", () => {
  assert.deepEqual(parseBrowserOwner(browserOwnerEnvironment(owner)), owner);
  assert.deepEqual(browserOwnerFromColumns(browserOwnerColumns(owner)), owner);
  assert.equal(browserOwnerFromColumns(browserOwnerColumns(null)), null);
});

test("Herdr owner parsing requires complete exact metadata", () => {
  assert.deepEqual(requireHerdrBrowserOwner({
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_TAB_ID: "w1:t2",
    HERDR_PANE_ID: "w1:p3",
  }, "/tmp/project-a", "session-a"), owner);
  assert.throws(() => parseBrowserOwner({ TERMINAL_BROWSER_OWNER_PANE_ID: "w1:p3" }), /workspace id/);
  assert.throws(() => requireHerdrBrowserOwner({}, "/tmp/project-a"), /workspace id/);
});

test("native ownership binds the canonical project and exact session", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-owner-"));
  try {
    const project = path.join(directory, "project");
    const other = path.join(directory, "other");
    const alias = path.join(directory, "alias");
    fs.mkdirSync(project);
    fs.mkdirSync(other);
    fs.symlinkSync(project, alias);
    const first = nativeBrowserOwner("work", project);
    assert.equal(isNativeBrowserOwner(first), true);
    assert.equal(first.projectDir, fs.realpathSync(project));
    assert.deepEqual(nativeBrowserOwner("work", alias), first);
    assert.deepEqual(parseBrowserOwner(browserOwnerEnvironment(first)), first);
    assert.deepEqual(browserOwnerFromColumns(browserOwnerColumns(first)), first);
    assert.equal(sameBrowserOwner(first, nativeBrowserOwner("another", project)), false);
    assert.equal(sameBrowserOwner(first, nativeBrowserOwner("work", other)), false);
    assert.throws(() => parseBrowserOwner({ ...browserOwnerEnvironment(first), TERMINAL_BROWSER_OWNER_PROJECT_DIR: other }), /does not match/);
    assert.throws(() => nativeBrowserOwner("", project), /session id/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("owner matching uses workspace, tab, and Pi pane identity", () => {
  assert.equal(sameBrowserOwner(owner, { ...owner, sessionId: "session-b", projectDir: "/tmp/project-b" }), true);
  assert.equal(sameBrowserOwner(owner, { ...owner, paneId: "w1:p4" }), false);
  assert.equal(sameBrowserOwner(owner, { ...owner, tabId: "w1:t9" }), false);
  assert.equal(sameBrowserOwner(owner, null), false);
});
