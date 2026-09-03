import {
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
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
import { renderProjectGlance } from "./renderer.js";

class ProjectGlanceContent implements Component {
  readonly #model: ProjectGlancePaneModel;

  constructor(model: ProjectGlancePaneModel) {
    this.#model = model;
  }

  invalidate(): void {
    // The view is derived directly from the model on every render.
  }

  render(width: number): string[] {
    return renderProjectGlance(
      this.#model.snapshot,
      this.#model.state,
      width,
    );
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
  const content = new ProjectGlanceContent(model);
  const scrollView = new ScrollView(content, {
    follow: "none",
    primary: true,
    overscroll: "contain",
    scrollbar: "auto",
  });
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, {
    mouse: true,
    wheelScrollLines: 3,
  });
  tui.setLayoutRoot(scrollView);
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
    content.invalidate();
    tui.requestRender();
  };
  const client = new ProjectGlanceClient({
    descriptorPath,
    onState: (state: ProjectGlancePaneState) => {
      model.setConnectionState(state);
      requestRender();
    },
    onDescriptor: (descriptor) => {
      try {
        model.setExpectedSessionKey(descriptor.sessionKey);
      } catch {
        model.setConnectionState("disconnected");
      }
      requestRender();
    },
    onSnapshot: (snapshot) => {
      try {
        model.applySnapshot(snapshot);
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
