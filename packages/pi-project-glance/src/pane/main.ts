import {
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  VStack,
  type Component,
} from "@earendil-works/pi-tui";
import {
  PROJECT_GLANCE_DESCRIPTOR_ENV,
  PROJECT_GLANCE_TITLE,
} from "../protocol/model.js";
import { ProjectGlanceClient } from "../protocol/client.js";
import {
  ProjectGlancePaneModel,
  type ProjectGlancePaneState,
} from "./model.js";
import {
  renderProjectGlanceFeed,
  renderProjectGlancePinned,
} from "./renderer.js";

export class ProjectGlancePinnedRegion implements Component {
  readonly #model: ProjectGlancePaneModel;

  constructor(model: ProjectGlancePaneModel) {
    this.#model = model;
  }

  invalidate(): void {
    // The region is derived directly from the model on every render.
  }

  render(width: number): string[] {
    return renderProjectGlancePinned(
      this.#model.snapshot,
      this.#model.state,
      width,
    );
  }
}

export class ProjectGlanceFeedRegion implements Component {
  readonly #model: ProjectGlancePaneModel;

  constructor(model: ProjectGlancePaneModel) {
    this.#model = model;
  }

  invalidate(): void {
    // The region is derived directly from the model on every render.
  }

  render(width: number): string[] {
    return renderProjectGlanceFeed(this.#model.snapshot, width);
  }
}

/**
 * The pinned region is outside the ScrollView. Only the feed region is a
 * scrollable layout child, so viewport input cannot move CURRENT or the title.
 */
export class ProjectGlancePaneView implements Component {
  readonly pinned: ProjectGlancePinnedRegion;
  readonly feed: ProjectGlanceFeedRegion;
  readonly scrollView: ScrollView;
  readonly root: VStack;

  constructor(model: ProjectGlancePaneModel) {
    this.pinned = new ProjectGlancePinnedRegion(model);
    this.feed = new ProjectGlanceFeedRegion(model);
    this.scrollView = new ScrollView(this.feed, {
      follow: "none",
      primary: true,
      overscroll: "contain",
      scrollbar: "auto",
    });
    this.root = new VStack([
      { component: this.pinned, shrink: 0 },
      { component: this.scrollView, grow: 1, shrink: 1, minSize: 0 },
    ]);
  }

  invalidate(): void {
    this.root.invalidate();
  }

  render(width: number): string[] {
    return this.root.render(width);
  }
}

function isQuitInput(data: string): boolean {
  return data === "q" || data === "Q" || data === "\u001b";
}

function conciseStartError(): void {
  process.stderr.write("Project Glance pane could not start.\n");
  process.exitCode = 1;
}

export async function main(): Promise<void> {
  if (process.platform !== "linux") {
    process.stderr.write("Project Glance supports Linux only.\n");
    process.exitCode = 1;
    return;
  }
  const descriptorPath = process.env[PROJECT_GLANCE_DESCRIPTOR_ENV];
  if (!descriptorPath) {
    process.stderr.write("Project Glance connection is unavailable.\n");
    process.exitCode = 2;
    return;
  }

  const model = new ProjectGlancePaneModel();
  const view = new ProjectGlancePaneView(model);
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, {
    mouse: true,
    wheelScrollLines: 3,
  });
  tui.setLayoutRoot(view.root);
  terminal.setTitle(PROJECT_GLANCE_TITLE);

  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onSignal = (): void => finish();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  const removeInput = tui.addInputListener((data) => {
    if (!isQuitInput(data)) return undefined;
    finish();
    return { consume: true };
  });
  const requestRender = (): void => {
    view.invalidate();
    tui.requestRender();
  };
  const client = new ProjectGlanceClient({
    descriptorPath,
    onState: (state) => {
      model.setConnectionState(state as ProjectGlancePaneState);
      requestRender();
    },
    onDescriptor: (descriptor) => {
      try {
        model.setExpectedRelay(descriptor);
      } catch {
        model.setConnectionState("disconnected");
      }
      requestRender();
    },
    onSnapshot: (snapshot, identity) => {
      try {
        model.applySnapshot(snapshot, identity);
      } catch {
        model.setConnectionState("reconnecting");
      }
      requestRender();
    },
    onError: () => requestRender(),
  });

  try {
    tui.start();
    client.start();
    await finished;
  } catch {
    conciseStartError();
  } finally {
    client.stop();
    removeInput();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
    tui.setLayoutRoot(undefined);
    tui.stop();
  }
}
