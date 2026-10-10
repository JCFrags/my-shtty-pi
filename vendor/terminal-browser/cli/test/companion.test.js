const assert = require("node:assert/strict");
const test = require("node:test");

const {
  currentBrowserOwner,
  paneOpenArgs,
  parseOpenedPane,
} = require("../dist/companion");
const { ownerMatches } = require("../dist/instances");
const { ordinaryLaunchOwner } = require("../dist/session");
const { parseCompanionSessionArgs } = require("../dist/companion-session");
const { PI_ORIGIN_ENV, parsePiOrigin, piOriginEnvironment, piOriginFromEnvironment } = require("pixel-store");
const origin = { schemaVersion: 1, generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", piSessionId: "pi-a", piSessionFile: null };

const ownerA = {
  workspaceId: "w1",
  tabId: "w1:t1",
  paneId: "w1:p1",
  sessionId: "pi-a",
  projectDir: "/tmp/a",
};

function row(key, owner) {
  return {
    key,
    pid: 1,
    socket: `/tmp/${key}.sock`,
    ownerWorkspaceId: owner.workspaceId,
    ownerTabId: owner.tabId,
    ownerPaneId: owner.paneId,
    ownerSessionId: owner.sessionId,
    ownerProjectDir: owner.projectDir,
  };
}

test("current owner derives from the calling Herdr Pi pane", () => {
  assert.deepEqual(currentBrowserOwner({
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w1",
    HERDR_TAB_ID: "w1:t1",
    HERDR_PANE_ID: "w1:p1",
    PI_SESSION_ID: "pi-a",
  }, "/tmp/a"), ownerA);
});

test("exact owner selection prevents cross-agent routing", () => {
  const ownerB = { ...ownerA, paneId: "w1:p2", sessionId: "pi-b" };
  assert.deepEqual(ownerMatches([row("a", ownerA), row("b", ownerB)], ownerA).map((value) => value.key), ["a"]);
  assert.deepEqual(ownerMatches([row("a", ownerA), row("b", ownerB)], ownerB).map((value) => value.key), ["b"]);
});

test("pane launch passes complete owner metadata, startup correlation and exact placement", () => {
  const startup = { attempt: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", file: "/tmp/not-used" };
  const rawOrigin = JSON.stringify(origin, null, 1);
  const args = paneOpenArgs(ownerA, { url: "file:///tmp/a.html", focus: false }, startup, { [PI_ORIGIN_ENV]: rawOrigin });
  assert.deepEqual(args.slice(0, 12), [
    "plugin", "pane", "open", "--plugin", "zenbu-labs.terminal-browser",
    "--entrypoint", "companion", "--placement", "split",
    "--target-pane", "w1:p1", "--direction",
  ]);
  assert.equal(args.includes("--workspace"), false);
  assert.equal(args.includes("right"), true);
  assert.equal(args.includes("TERMINAL_BROWSER_OWNER_PANE_ID=w1:p1"), true);
  assert.equal(args.includes("TERMINAL_BROWSER_OWNER_PROJECT_DIR=/tmp/a"), true);
  assert.equal(args.includes("TERMINAL_BROWSER_COMPANION_URL=file:///tmp/a.html"), true);
  assert.equal(args.includes(`TERMINAL_BROWSER_STARTUP_ATTEMPT=${startup.attempt}`), true);
  assert.equal(args.at(-1), "--no-focus");
  assert.equal(args.includes(`${PI_ORIGIN_ENV}=${rawOrigin}`), true);
  assert.equal(paneOpenArgs(ownerA, {}, startup, { [PI_ORIGIN_ENV]: "invalid" }).some(arg => arg.startsWith(`${PI_ORIGIN_ENV}=`)), false);
  const bind = parseCompanionSessionArgs(["receiver", "bind", "--receiver-kind", "pi", "--receiver-session", "pi-a", "--receiver-generation", origin.generation, "--suspend-automatic"]);
  assert.equal(bind.request.suspendAutomatic, true);
});

test("ordinary launch ownership is exact to origin and project without changing app or explicit defaults", () => {
  const environment = { [PI_ORIGIN_ENV]: JSON.stringify(origin) };
  const owner = ordinaryLaunchOwner([], environment, process.cwd());
  assert.deepEqual(ordinaryLaunchOwner([], environment, process.cwd()), owner);
  assert.notEqual(ordinaryLaunchOwner([], { [PI_ORIGIN_ENV]: JSON.stringify({ ...origin, generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }) }, process.cwd()).paneId, owner.paneId);
  assert.notEqual(ordinaryLaunchOwner([], {}, process.cwd()).paneId, ordinaryLaunchOwner([], {}, process.cwd()).paneId);
  for (const args of [["--app-mode"], ["--preload=/tmp/app.cjs"], ["--main-script=/tmp/main.cjs"], ["--no-frame"], ["--ssh=user@host"]]) assert.equal(ordinaryLaunchOwner(args, environment, process.cwd()), null);
  assert.equal(ordinaryLaunchOwner([], { ...environment, TERMINAL_BROWSER_INTEROP_TARGET: "/tmp/host.sock" }, process.cwd()), null);
  assert.equal(ordinaryLaunchOwner([], { TERMINAL_BROWSER_OWNER_WORKSPACE_ID: "w1", TERMINAL_BROWSER_OWNER_TAB_ID: "w1:t1", TERMINAL_BROWSER_OWNER_PANE_ID: "w1:p1", TERMINAL_BROWSER_OWNER_PROJECT_DIR: "/tmp/a" }, process.cwd()), null);
  assert.deepEqual(piOriginEnvironment(environment), environment);
  const current = { ...environment, PI_SESSION_ID: origin.piSessionId };
  assert.deepEqual(piOriginFromEnvironment(current), origin);
  assert.deepEqual(piOriginEnvironment(current), environment);
  assert.deepEqual(ordinaryLaunchOwner([], current, process.cwd()), owner);
  const inherited = { ...environment, PI_SESSION_ID: "pi-other" };
  const before = JSON.stringify(inherited);
  for (const read of [() => piOriginFromEnvironment(inherited), () => piOriginEnvironment(inherited), () => ordinaryLaunchOwner([], inherited, process.cwd())]) assert.throws(read, error => error.code === "PI_ORIGIN_MISMATCH");
  assert.equal(JSON.stringify(inherited), before);
  for (const invalid of [{ ...origin, extra: true }, { ...origin, piSessionFile: "relative" }, { ...origin, piSessionId: "" }, { ...origin, generation: "not-a-uuid" }]) assert.equal(parsePiOrigin(invalid), null);
});

test("pane response accepts only the expected plugin entrypoint", () => {
  const valid = JSON.stringify({ result: { plugin_pane: {
    plugin_id: "zenbu-labs.terminal-browser",
    entrypoint: "companion",
    pane: { pane_id: "w1:p8" },
  } } });
  assert.equal(parseOpenedPane(valid), "w1:p8");
  assert.throws(() => parseOpenedPane(valid.replace("companion", "other")), /invalid Herdr/);
});

test('file operations preserve the accepted pane-owned companion matching across session and cwd changes', () => {
  for (const other of [{ ...ownerA, sessionId: 'pi-b' }, { ...ownerA, projectDir: '/tmp/b' }]) {
    assert.deepEqual(ownerMatches([row('a', ownerA)], other).map(value => value.key), ['a']);
  }
});
