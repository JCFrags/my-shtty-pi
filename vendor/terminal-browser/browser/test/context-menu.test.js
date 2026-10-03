const assert = require("node:assert/strict");
const { test, mock } = require("node:test");
const React = require("react");
const { PageContextMenu } = require("../dist/ui/context-menu.js");

function menu() {
  const calls = [];
  const hooks = [
    mock.method(React, "useRef", (current) => ({ current })),
    mock.method(React, "useEffect", () => {}),
  ];
  try {
    const tree = PageContextMenu({
      view: { x: 20, y: 20, items: [
        { id: "info", label: "Receiver: Not associated", enabled: false, shortcut: "" },
        { id: "settings", label: "Settings", enabled: true, shortcut: "" },
      ] },
      actions: {
        pageMenuClose: () => calls.push("close"),
        pageMenuAction: (id) => calls.push(id),
      },
      layout: { width: 800, height: 600, rem: 16 },
      theme: { field: "black", fieldBorder: "gray", fg: "white", disabled: "gray", hover: "blue" },
    });
    const [backdrop, panel] = tree.props.children;
    return { backdrop, panel, calls };
  } finally {
    for (const hook of hooks) hook.mock.restore();
  }
}

test("menu panel absorbs inactive-row and padding clicks without dismissing", () => {
  const { panel, calls } = menu();
  const inactive = panel.props.children[0];
  const row = inactive.type(inactive.props);
  assert.equal(row.props.onClick, undefined, "inactive text has no action");
  assert.equal(row.props.style.hoverBackground, undefined);
  assert.equal(typeof panel.props.onClick, "function", "the panel is a native click target behind inactive rows");
  panel.props.onClick({ x: 30, y: 30 });
  assert.deepEqual(calls, []);
});

test("enabled rows still dispatch and the outside backdrop still dismisses", () => {
  const { backdrop, panel, calls } = menu();
  const enabled = panel.props.children[1];
  enabled.type(enabled.props).props.onClick({ x: 30, y: 55 });
  assert.deepEqual(calls, ["settings"]);
  backdrop.props.onClick({ x: 790, y: 590 });
  assert.deepEqual(calls, ["settings", "close"]);
});
