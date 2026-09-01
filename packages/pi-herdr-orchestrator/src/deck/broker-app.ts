import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@pi-herdr-deck/tui";
import { BrokerClient, type BrokerStatus } from "./broker-client.js";
import { DeckActions, type DeckAction } from "./actions.js";
import {
  currentBlockingQuestions,
  currentProviderProjection,
  getAgentModelChoices,
  getAgentThinkingChoices,
  renderNotifications,
} from "./views.js";
import {
  type HitBox,
  PressReleaseTracker,
  renderButton,
} from "./components/controls.js";
import type { Agent, Task } from "../state/types.js";
import type { DeckState } from "./types.js";
import { styleLines } from "./theme.js";
import type { PiCapabilitySnapshot } from "../pi/model-capabilities.js";
import type { ModelPolicyConfig } from "../broker/model-policy.js";
import type { DeckGroup, DeckQuestion } from "./types.js";
import type { AgentBoardPendingQuestion } from "../shared/provider-projections.js";
import {
  shellHeaderPresentation,
  visibleSurfaceSignature,
} from "./render-dependencies.js";
import {
  selectActivityPresentation,
  selectUnifiedBoardPresentation,
  type ActivityFilter,
  type ActivityItem,
  type AgentBoardTab,
  type BoardFilter,
  type BoardItem,
} from "./product-presentation.js";
import {
  selectAdoptedRootAgent,
  selectAdoptedScope,
  selectFilesPresentationAuthority,
} from "./scope.js";
import {
  effectiveSelection,
  moveAgentListSelection,
  selectAgentListPresentation,
} from "./selections.js";
import { selectBoardPresentation } from "./board-presentation.js";
import {
  handleFilesKey,
  handleFilesMouse,
  normalizeFilesPresentation,
  renderFilesScreen,
  type FilesActionRequest,
  type FilesScreenOptions,
  type FilesScreenSurface,
} from "./files-screen.js";
import {
  agentMoreGuard,
  agentMoreFocusFromMouse,
  activateAgentMore,
  handleAgentMoreKey,
  isAgentMoreGuardCurrent,
  openAgentMore as openAgentMoreSurface,
  renderAgents,
  type AgentActionContract,
  type AgentContractAction,
  type AgentMorePresentation,
} from "./agents.js";
import {
  applyActivityWheel,
  handleActivityKey,
  renderActivity,
  type ActivityAction,
} from "./activity.js";
import { renderBoardScreen } from "./board-screen.js";

export interface BrokerDeckAppOptions {
  client: BrokerClient;
  requestRender(): void;
  getHeight(): number;
  targetPaneId?: string;
  onClose?(): void;
  onRenderDecision?(decision: { rendered: boolean; tab: AgentBoardTab }): void;
  onActionTarget?(
    action: DeckAction,
    target: import("./actions.js").ActionTarget,
  ): void;
}

type DeckTab = AgentBoardTab;
interface ConfirmationState {
  action: "cancelTask" | "groupStop" | "groupClose" | "close" | "stop";
  targetId: string;
  summary: string;
  generation?: number;
}

type InputMode =
  | "prompt"
  | "ask"
  | "steer"
  | "followUp"
  | "answer"
  | "board-answer"
  | "create"
  | "default"
  | "files-filter"
  | "model-filter";

const NAV_TABS: readonly DeckTab[] = ["board", "files", "agents", "activity"];

export class BrokerDeckApp implements Component {
  readonly #client: BrokerClient;
  readonly #actions: DeckActions;
  readonly #requestRender: () => void;
  readonly #getHeight: () => number;
  readonly #targetPaneId: string | undefined;
  readonly #onClose: () => void;
  readonly #onRenderDecision: BrokerDeckAppOptions["onRenderDecision"];
  readonly #onActionTarget: BrokerDeckAppOptions["onActionTarget"];
  readonly #unsubscribers: Array<() => void> = [];
  readonly #tracker = new PressReleaseTracker();
  #status: BrokerStatus;
  #tab: DeckTab = "board";
  #hitBoxes: HitBox[] = [];
  #selectedAgent: string | undefined;
  #selectedGroup: string | undefined;
  #selectedTask: string | undefined;
  #selectedProviderTodo: string | undefined;
  #selectedQuestion: string | undefined;
  #agentFilter: import("./views.js").AgentViewFilter = "active";
  #agentPage = 0;
  #modelFilter = "";
  #providerPending = new Set<string>();
  #message = "";
  #inputMode: InputMode | undefined;
  #input = "";
  #confirmation: ConfirmationState | undefined;
  #capabilities: PiCapabilitySnapshot | undefined;
  #modelPolicy: ModelPolicyConfig | undefined;
  #autoCloseCompletedTemporary = false;
  #settingsScroll = 0;
  #filesScreen: import("./screen-types.js").FilesScreenState = {
    activePane: "tree",
    treeScroll: 0,
    previewScroll: 0,
    focusTarget: "tree",
    wheelDetached: false,
  };
  #filesSurface: FilesScreenSurface | undefined;
  #filesOptions: FilesScreenOptions | undefined;
  #filesSurfaceOffset = 0;
  #boardTab: "inbox" | "updates" | "decisions" | "history" = "inbox";
  #boardSelection: string | undefined;
  #unifiedBoardSelection: string | undefined;
  #boardFilter: BoardFilter = "all-current";
  #boardScroll = 0;
  #boardWheelDetached = false;
  #activitySelection: string | undefined;
  #activityFilter: ActivityFilter = "all";
  #activityScroll = 0;
  #activityDetailScroll = 0;
  #activitySurface: import("./screen-types.js").RenderedSurface | undefined;
  #activitySurfaceOffset = 0;
  #settingsOpen = false;
  #helpOpen = false;
  #agentMoreOpen = false;
  #agentMorePresentation: AgentMorePresentation | undefined;
  #renderSignature = "";

  constructor(options: BrokerDeckAppOptions) {
    this.#client = options.client;
    this.#actions = new DeckActions(options.client);
    this.#requestRender = options.requestRender;
    this.#getHeight = options.getHeight;
    this.#targetPaneId = options.targetPaneId;
    this.#onClose = options.onClose ?? (() => undefined);
    this.#onRenderDecision = options.onRenderDecision;
    this.#onActionTarget = options.onActionTarget;
    this.#status = options.client.status;
    this.#renderSignature = this.visibleSignature(options.client.store.state);
    this.#unsubscribers.push(
      options.client.onStatus((status) => {
        if (status === this.#status) return;
        this.#status = status;
        const signature = this.visibleSignature();
        if (signature === this.#renderSignature) return;
        this.#renderSignature = signature;
        this.#requestRender();
      }),
      options.client.store.onChange((state) => {
        if (
          this.#agentMorePresentation &&
          !isAgentMoreGuardCurrent(state, this.#agentMorePresentation.guard)
        ) {
          this.#agentMoreOpen = false;
          this.#agentMorePresentation = undefined;
        }
        const projection = currentProviderProjection(state, this.#targetPaneId);
        const previousMessage = this.#message;
        if (
          this.#message &&
          ((projection?.files?.available &&
            /Files provider|No active Files provider/i.test(this.#message)) ||
            (projection?.agentBoard.view &&
              /managed adapter|adapter is not connected|Provider owner/i.test(
                this.#message,
              )))
        )
          this.#message = "";
        const signature = this.visibleSignature(state);
        const rendered =
          signature !== this.#renderSignature ||
          previousMessage !== this.#message;
        this.#onRenderDecision?.({ rendered, tab: this.#tab });
        if (!rendered) return;
        this.#renderSignature = signature;
        this.#requestRender();
      }),
    );
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const state = this.#client.store.state;
    this.#hitBoxes = [];
    const shell = shellHeaderPresentation(state, {
      tab: this.#tab,
      ...(this.#targetPaneId ? { targetPaneId: this.#targetPaneId } : {}),
      online: this.#status === "connected",
    });
    const lines = [
      `${shell.productName}  ${shell.online ? "● ONLINE" : "○ OFFLINE"}  ${shell.scopeLabel}  attention ${shell.attentionCount}`,
    ];
    const tabNames: Record<DeckTab, string> = {
      board: "Board",
      files: "Files",
      agents: "Agents",
      activity: "Activity",
    };
    this.addControlRow(
      lines,
      [
        ...NAV_TABS.map((tab, index) => ({
          id: `tab:${tab}`,
          label: `${this.#tab === tab ? tabNames[tab].toUpperCase() : tabNames[tab]} ${index + 1}`,
          activate: () => this.selectTab(tab),
        })),
        {
          id: "header:settings",
          label: "Settings ,",
          activate: () => this.toggleSettings(),
        },
        {
          id: "header:help",
          label: "Help ?",
          activate: () => this.toggleHelp(),
        },
      ],
      safeWidth,
    );
    lines.push(
      "────────────────────────────────────────────────────────────────────────────────",
      "↑↓ move  •  click controls  •  r refresh  •  , settings  •  ? help  •  q close",
      ...(this.#message ? [`◆ ${this.#message}`] : []),
      "",
    );

    if (this.#confirmation) this.renderConfirmationSurface(lines, safeWidth);
    else if (this.#settingsOpen) this.renderSettingsSurface(lines, safeWidth);
    else if (this.#helpOpen) this.renderHelpSurface(lines);
    else if (this.#agentMoreOpen) this.renderAgentMoreSurface(lines, safeWidth);
    else if (this.#tab === "board")
      this.renderUnifiedBoard(lines, safeWidth, state);
    else if (this.#tab === "files")
      this.renderFilesProvider(lines, safeWidth, state);
    else if (this.#tab === "agents")
      this.renderAgentsSurface(lines, safeWidth, state);
    else this.renderActivitySurface(lines, safeWidth, state);

    if (this.#inputMode) {
      lines.push(`${this.#inputMode.toUpperCase()}: ${this.#input}█`);
      if (this.#inputMode === "create") {
        lines.push(
          "Format: title|objective|profile|provider|model|thinking|lifecycle.",
        );
        lines.push("Lifecycle is temporary, reusable, retained, or pinned.");
      } else if (this.#inputMode === "default")
        lines.push(
          "Format: global||provider|model|thinking, role|profile|provider|model|thinking, or project|cwd|provider|model|thinking.",
        );
      lines.push("Enter submits. Escape cancels. Backspace edits.");
    }
    if (this.#tab === "board" && this.#client.store.notifications.length > 0)
      lines.push(
        "",
        ...renderNotifications(
          this.#client.store.notifications.slice(0, 4),
          safeWidth,
        ),
      );
    const height = Math.max(1, this.#getHeight());
    while (lines.length < height) lines.push("");
    const laidOut = lines
      .slice(0, height)
      .map((line) =>
        visibleWidth(line) <= safeWidth
          ? line
          : `${truncateToWidth(line, Math.max(0, safeWidth - 1))}…`,
      );
    return styleLines(laidOut);
  }

  handleInput(data: string): void {
    if (this.#inputMode) {
      this.handleEditorInput(data);
      this.#requestRender();
      return;
    }
    if (this.#confirmation) {
      if (data === "\u001b" || data === "n") this.#confirmation = undefined;
      else if (data === "y" || data === "\r" || data === "\n")
        void this.submitConfirmation();
      this.syncVisibleSignature();
      this.#requestRender();
      return;
    }
    if (this.#settingsOpen || this.#helpOpen || this.#agentMoreOpen) {
      if (this.#agentMoreOpen && this.#agentMorePresentation) {
        if (data === "\u001b") {
          this.#agentMoreOpen = false;
          this.#agentMorePresentation = undefined;
        } else if (data === "\u001b[A" || data === "k") {
          const result = handleAgentMoreKey(
            this.#agentMorePresentation,
            "ArrowUp",
            this.#client.store.state,
            this.agentActionContract(),
          );
          this.#agentMorePresentation = result.presentation;
        } else if (data === "\u001b[B" || data === "j") {
          const result = handleAgentMoreKey(
            this.#agentMorePresentation,
            "ArrowDown",
            this.#client.store.state,
            this.agentActionContract(),
          );
          this.#agentMorePresentation = result.presentation;
        } else if (data === "\r" || data === "\n") {
          const result = handleAgentMoreKey(
            this.#agentMorePresentation,
            "Enter",
            this.#client.store.state,
            this.agentActionContract(),
          );
          if (result.activated) {
            this.#agentMoreOpen = false;
            this.#agentMorePresentation = undefined;
          }
        }
      } else if (
        data === "\u001b" ||
        (this.#settingsOpen && data === ",") ||
        (this.#helpOpen && data === "?")
      ) {
        this.#settingsOpen = false;
        this.#helpOpen = false;
        this.#agentMoreOpen = false;
        this.#agentMorePresentation = undefined;
      } else if (this.#settingsOpen && data === "/")
        this.beginInput("model-filter");
      else if (this.#settingsOpen && data === "d") this.beginInput("default");
      else if (this.#settingsOpen && data === "o") void this.toggleAutoClose();
      this.syncVisibleSignature();
      this.#requestRender();
      return;
    }
    if (data === "q" || data === "\u0003" || data === "\u001b") {
      this.#onClose();
      return;
    } else if (data >= "1" && data <= "4")
      this.selectTab(NAV_TABS[Number(data) - 1]!);
    else if (data === ",") this.toggleSettings();
    else if (data === "?") this.toggleHelp();
    else if (data === "r") void this.run("refresh");
    else if (data === "v" && this.#tab === "board") this.cycleBoardFilter();
    else if (data === "v" && this.#tab === "activity")
      this.cycleActivityFilter();
    else if (data === "n" && this.#tab === "agents") this.beginInput("create");
    else if (data === "/" && this.#tab === "files")
      this.beginInput("files-filter");
    else if (this.#tab === "files") {
      const key =
        data === "\u001b[A"
          ? "ArrowUp"
          : data === "\u001b[B"
            ? "ArrowDown"
            : data;
      if (!handleFilesKey(this.filesScreenOptions(), key) && data === "/")
        this.beginInput("files-filter");
    } else if (data === "f" && this.#tab === "agents") void this.run("focus");
    else if (data === "p" && this.#tab === "agents") this.beginInput("prompt");
    else if (data === "a" && this.#tab === "agents") this.beginInput("ask");
    else if (data === "a" && this.#tab === "board")
      this.beginInput(this.selectedBoardQuestion() ? "board-answer" : "answer");
    else if (data === "y" && this.#tab === "board")
      void this.runBoard("accept-recommendation");
    else if (data === "i" && this.#tab === "agents") void this.run("interrupt");
    else if (data === "s" && this.#tab === "agents") this.confirmAgentStop();
    else if (data === "x" && this.#tab === "agents") this.confirmClose();
    else if (data === "m" && this.#tab === "agents") this.openAgentMore();
    else if (data === "t" && this.#tab === "agents") this.cycleThinking();
    else if (
      this.#tab === "activity" &&
      (data === "\u001b[A" ||
        data === "\u001b[B" ||
        data === "k" ||
        data === "j")
    )
      this.handleActivityKey(
        data === "\u001b[A"
          ? "ArrowUp"
          : data === "\u001b[B"
            ? "ArrowDown"
            : data,
      );
    else if (data === "\u001b[A" || data === "k") this.move(-1);
    else if (data === "\u001b[B" || data === "j") this.move(1);
    this.syncVisibleSignature();
    this.#requestRender();
  }

  handleMouse(event: TuiMouseEvent): boolean {
    if (this.#confirmation) {
      if (event.type === "wheel") return true;
      const handled = this.#tracker.handle(
        event,
        this.#hitBoxes.filter((box) => box.id.startsWith("confirm:")),
      );
      if (handled) this.#requestRender();
      return true;
    }
    if (this.#settingsOpen || this.#helpOpen || this.#agentMoreOpen) {
      if (event.type === "wheel") {
        if (this.#settingsOpen)
          this.#settingsScroll = Math.max(
            0,
            this.#settingsScroll + (event.direction === "down" ? 1 : -1),
          );
        this.#requestRender();
        return true;
      }
      const prefix = this.#settingsOpen
        ? "settings:"
        : this.#helpOpen
          ? "help:"
          : "agent-more:";
      const overlayBoxes = this.#hitBoxes.filter((box) =>
        box.id.startsWith(prefix),
      );
      const handled = this.#tracker.handle(event, overlayBoxes);
      if (handled) this.#requestRender();
      return true;
    }
    if (this.#inputMode) return true;
    if (this.#tab === "files" && this.#filesSurface) {
      const localEvent =
        event.type === "wheel"
          ? { ...event, y: event.y - this.#filesSurfaceOffset }
          : { ...event, y: event.y - this.#filesSurfaceOffset };
      const handled = handleFilesMouse(
        this.#filesOptions ?? this.filesScreenOptions(),
        this.#filesSurface,
        localEvent,
      );
      if (handled) {
        this.syncVisibleSignature();
        this.#requestRender();
      }
      return handled;
    }
    if (event.type === "wheel") {
      const delta = event.direction === "down" ? 1 : -1;
      if (this.#tab === "board") {
        this.#boardWheelDetached = true;
        this.#boardScroll = Math.max(0, this.#boardScroll + delta);
      } else if (this.#tab === "activity") {
        const region = this.activityWheelRegion(event.x, event.y);
        const result = applyActivityWheel(
          this.activityScreenState(),
          region,
          event.direction === "down" ? "down" : "up",
        );
        this.#activityScroll = result.state.listScroll;
        this.#activityDetailScroll = result.state.detailScroll;
        if (result.handled) {
          this.syncVisibleSignature();
          this.#requestRender();
        }
        return result.handled;
      } else this.move(delta);
      this.syncVisibleSignature();
      this.#requestRender();
      return true;
    }
    const handled = this.#tracker.handle(event, this.#hitBoxes);
    if (handled) {
      this.syncVisibleSignature();
      this.#requestRender();
    }
    return handled;
  }

  invalidate(): void {
    this.#requestRender();
  }

  private visibleSignature(state = this.#client.store.state): string {
    return visibleSurfaceSignature(state, {
      tab: this.#tab,
      ...(this.#targetPaneId ? { targetPaneId: this.#targetPaneId } : {}),
      ...(this.#selectedAgent ? { selectedAgentId: this.#selectedAgent } : {}),
      agentFilter: this.#agentFilter,
      agentPage: this.#agentPage,
      online: this.#status === "connected",
      boardFilter: this.#boardFilter,
      activityFilter: this.#activityFilter,
      ...(this.#tab === "activity" && this.#activitySelection
        ? { boardSelectionId: this.#activitySelection }
        : this.#unifiedBoardSelection
          ? { boardSelectionId: this.#unifiedBoardSelection }
          : {}),
      notifications: this.#client.store.notifications,
      ...(this.#confirmation
        ? {
            overlay: "confirm" as const,
            overlayGuard: this.#confirmation,
          }
        : this.#inputMode
          ? {
              overlay:
                this.#inputMode === "answer" ||
                this.#inputMode === "board-answer"
                  ? ("question-response" as const)
                  : ("text-input" as const),
              overlayGuard: {
                mode: this.#inputMode,
                selectedQuestion: this.#selectedQuestion,
                selectedBoardQuestion: this.#boardSelection,
              },
            }
          : this.#settingsOpen
            ? { overlay: "settings" as const }
            : this.#helpOpen
              ? { overlay: "help" as const }
              : this.#agentMoreOpen
                ? {
                    overlay: "agent-more" as const,
                    overlayGuard: this.#agentMorePresentation?.guard,
                  }
                : {}),
    });
  }

  private syncVisibleSignature(): void {
    this.#renderSignature = this.visibleSignature();
  }

  private selectTab(tab: DeckTab): void {
    this.#inputMode = undefined;
    this.#input = "";
    this.#settingsOpen = false;
    this.#helpOpen = false;
    this.#agentMoreOpen = false;
    this.#tab = tab;
    this.#confirmation = undefined;
    this.#tracker.reset();
    this.syncVisibleSignature();
    this.#requestRender();
  }

  private toggleSettings(): void {
    this.#settingsOpen = !this.#settingsOpen;
    this.#helpOpen = false;
    this.#settingsScroll = 0;
    if (this.#settingsOpen) void this.loadSettings();
    this.syncVisibleSignature();
    this.#requestRender();
  }

  private toggleHelp(): void {
    this.#helpOpen = !this.#helpOpen;
    this.#settingsOpen = false;
    this.syncVisibleSignature();
    this.#requestRender();
  }

  private renderSettingsSurface(lines: string[], width: number): void {
    lines.push("SETTINGS  Escape or , closes", "");
    this.addControlRow(
      lines,
      [
        {
          id: "settings:default",
          label: "Set model default",
          activate: () => this.beginInput("default"),
        },
        {
          id: "settings:auto-close",
          label: "Toggle auto-close",
          activate: () => void this.toggleAutoClose(),
        },
        {
          id: "settings:close",
          label: "Close",
          activate: () => this.toggleSettings(),
        },
      ],
      width,
    );
    lines.push("", ...this.renderSettings(width));
  }

  private renderHelpSurface(lines: string[]): void {
    const y = lines.length;
    lines.push(
      "HELP  Escape or ? closes",
      "1 Board  2 Files  3 Agents  4 Activity",
      "Board combines current work, questions, Signals updates, and recommendations.",
      "Files: row previews; caret expands; checkbox selects; each pane scrolls independently.",
      "Agents: f focus, p prompt, a ask, i interrupt, s stop, x close.",
      "Activity contains results, decisions, updates, groups, tasks, and lifecycle history.",
    );
    this.addHitBox("help:close", y, 4, () => this.toggleHelp(), false, 0);
  }

  private renderConfirmationSurface(lines: string[], width: number): void {
    const confirmation = this.#confirmation;
    if (!confirmation) return;
    lines.push(
      "CONFIRMATION",
      confirmation.summary,
      "Target: " + confirmation.targetId,
      "",
    );
    this.addControlRow(
      lines,
      [
        {
          id: "confirm:cancel",
          label: "Cancel",
          activate: () => {
            this.#confirmation = undefined;
            this.#tracker.reset();
          },
        },
        {
          id: "confirm:accept",
          label: "Confirm",
          activate: () => void this.submitConfirmation(),
        },
      ],
      width,
    );
  }

  private async submitConfirmation(): Promise<void> {
    const confirmation = this.#confirmation;
    if (!confirmation) return;
    const state = this.scopedWorkState(this.#client.store.state);
    if (confirmation.action === "cancelTask") {
      const task = state.tasks.get(confirmation.targetId);
      if (
        !task ||
        ["succeeded", "failed", "cancelled", "timed_out"].includes(task.state)
      ) {
        this.#message = "The task changed or became terminal.";
        this.#confirmation = undefined;
        return;
      }
      this.#selectedTask = task.id;
    } else if (
      confirmation.action === "groupStop" ||
      confirmation.action === "groupClose"
    ) {
      const group = state.groups.get(confirmation.targetId);
      if (
        !group ||
        ["closed", "stopped", "completed", "failed", "cancelled"].includes(
          group.state,
        )
      ) {
        this.#message = "The group changed or became terminal.";
        this.#confirmation = undefined;
        return;
      }
      this.#selectedGroup = group.id;
    } else {
      const agent = state.agents.get(confirmation.targetId);
      if (
        !agent ||
        (confirmation.generation !== undefined &&
          agent.generation !== confirmation.generation)
      ) {
        this.#message = "The agent changed or disappeared.";
        this.#confirmation = undefined;
        return;
      }
      this.#selectedAgent = agent.id;
    }
    this.#confirmation = undefined;
    this.#tracker.reset();
    await this.run(confirmation.action);
  }

  private renderAgentMoreSurface(lines: string[], width: number): void {
    const presentation = this.#agentMorePresentation;
    if (
      !presentation ||
      !isAgentMoreGuardCurrent(this.#client.store.state, presentation.guard)
    ) {
      this.#agentMoreOpen = false;
      this.#agentMorePresentation = undefined;
      return;
    }
    const agent = this.#client.store.state.agents.get(
      presentation.guard.agentId,
    );
    lines.push(
      "AGENT MORE  Escape closes",
      agent
        ? `${agent.displayName ?? agent.herdrName ?? agent.id} · ${agent.state}`
        : "Agent is unavailable",
      "",
    );
    this.addControlRow(
      lines,
      presentation.actions.map((item, index) => ({
        id: `agent-more:${item.id}`,
        label: item.label,
        disabled: item.disabled,
        activate: () => {
          this.#agentMorePresentation = agentMoreFocusFromMouse(
            presentation,
            index,
          );
          const activated = activateAgentMore(
            this.#client.store.state,
            this.#agentMorePresentation,
            this.agentActionContract(),
          );
          if (activated) {
            this.#agentMoreOpen = false;
            this.#agentMorePresentation = undefined;
          }
        },
      })),
      width,
    );
    this.addControlRow(
      lines,
      [
        {
          id: "agent-more:close-drawer",
          label: "Close drawer",
          activate: () => {
            this.#agentMoreOpen = false;
            this.#agentMorePresentation = undefined;
          },
        },
      ],
      width,
    );
  }

  private selectBoardItem(item: BoardItem): void {
    this.#unifiedBoardSelection = item.id;
    if (item.kind === "todo") this.#selectedProviderTodo = item.source.id;
    else if (item.kind === "task") this.#selectedTask = item.source.id;
    else if (item.kind === "group") this.#selectedGroup = item.source.id;
    else if (item.kind === "broker-question")
      this.#selectedQuestion = item.source.id;
    else if (item.kind === "agent-alert") this.#selectedAgent = item.source.id;
    else {
      const separator = item.id.indexOf(":");
      this.#boardSelection = item.id.slice(separator + 1);
      this.#boardTab =
        item.kind === "signal-question"
          ? "inbox"
          : item.kind === "signal-update"
            ? "updates"
            : "decisions";
    }
  }

  private cycleBoardFilter(): void {
    const filters: BoardFilter[] = ["attention", "active", "all-current"];
    this.#boardFilter =
      filters[(filters.indexOf(this.#boardFilter) + 1) % filters.length]!;
    this.#boardScroll = 0;
  }

  private cycleActivityFilter(): void {
    const filters: ActivityFilter[] = [
      "all",
      "results",
      "signals",
      "agents",
      "errors",
    ];
    this.#activityFilter =
      filters[(filters.indexOf(this.#activityFilter) + 1) % filters.length]!;
    this.#activityScroll = 0;
  }

  private renderUnifiedBoard(
    lines: string[],
    width: number,
    state: DeckState,
  ): void {
    const model = selectUnifiedBoardPresentation(
      state,
      this.#targetPaneId,
      this.#unifiedBoardSelection,
      this.#boardFilter,
    );
    const surface = renderBoardScreen({
      width,
      height: Math.max(1, this.#getHeight() - lines.length),
      state: {
        filter: this.#boardFilter,
        ...(this.#unifiedBoardSelection
          ? { selectedId: this.#unifiedBoardSelection }
          : {}),
        listScroll: this.#boardScroll,
        detailScroll: 0,
        wheelDetached: this.#boardWheelDetached,
      },
      model,
      actions: {
        select: (item) => this.selectBoardItem(item),
        filter: (filter) => {
          this.#boardFilter = filter;
          this.#boardScroll = 0;
        },
        answer: (item) =>
          this.beginInput(
            item.kind === "signal-question" ? "board-answer" : "answer",
          ),
        run: (item, action) => {
          if (item.kind === "todo" && action === "start")
            void this.runProvider("todoStart", "todo-start");
          else if (item.kind === "todo" && action === "mark-done")
            void this.runProvider("todoDone", "todo-done");
          else if (item.kind === "task" && action === "cancel-task")
            this.confirmTaskCancel();
          else if (item.kind === "group" && action === "wait")
            void this.run("groupWait");
          else if (item.kind === "group" && action === "stop")
            this.confirmGroup("groupStop");
          else if (item.kind === "group" && action === "close")
            this.confirmGroup("groupClose");
          else if (item.kind === "task" && action === "focus-agent")
            void this.run("focus");
          else if (item.kind === "task" && action === "open-agents")
            this.selectTab("agents");
          else if (item.kind === "agent-alert" && action === "focus")
            void this.run("focus");
          else if (item.kind === "agent-alert" && action === "prompt")
            this.beginInput("prompt");
          else if (item.kind === "agent-alert" && action === "open-agents")
            this.selectTab("agents");
          else if (item.kind.startsWith("signal-")) void this.runBoard(action);
        },
      },
    });
    if (surface.correctedState)
      this.#boardScroll = surface.correctedState.listScroll;
    const offset = lines.length;
    lines.push(...surface.lines);
    this.#hitBoxes.push(
      ...surface.hitBoxes.map((box) => ({ ...box, y: box.y + offset })),
    );
    return;
  }

  private agentActionContract(): AgentActionContract {
    return {
      authorize: (action: AgentContractAction, target) =>
        action === "create-child-agent"
          ? target.agent?.cwd
            ? undefined
            : "Agent project is unavailable."
          : this.#actions.authorize(action, target),
      activate: (action: AgentContractAction, target) => {
        if (target.agent) this.#selectedAgent = target.agent.id;
        if (action === "create-child-agent") this.beginInput("create");
        else if (
          action === "prompt" ||
          action === "ask" ||
          action === "steer" ||
          action === "followUp"
        )
          this.beginInput(action);
        else if (action === "stop") this.confirmAgentStop();
        else if (action === "close") this.confirmClose();
        else if (action === "setModel") this.cycleModel();
        else if (action === "setThinking") this.cycleThinking();
        else void this.run(action);
      },
    };
  }

  private openAgentMore(guard = agentMoreGuard(this.selectedAgent())): void {
    if (!guard) return;
    const presentation = openAgentMoreSurface(
      this.#client.store.state,
      guard,
      0,
      this.agentActionContract(),
    );
    if (!presentation) return;
    this.#agentMorePresentation = presentation;
    this.#agentMoreOpen = true;
    this.#tracker.reset();
  }

  private renderAgentsSurface(
    lines: string[],
    width: number,
    state: DeckState,
  ): void {
    const scoped = this.scopedWorkState(state);
    const surface = renderAgents({
      state: scoped,
      screen: {
        filter: this.#agentFilter,
        requestedPage: this.#agentPage,
        ...(this.#selectedAgent ? { selectedId: this.#selectedAgent } : {}),
      },
      width,
      actions: this.agentActionContract(),
      onSelect: (id) => {
        if (id.startsWith("filter:")) {
          const filter = id.slice("filter:".length);
          if (
            filter === "active" ||
            filter === "idle" ||
            filter === "history"
          ) {
            this.#agentFilter = filter;
            this.#agentPage = 0;
            this.#selectedAgent = undefined;
          }
        } else this.#selectedAgent = id;
      },
      onOpenMore: (guard) => this.openAgentMore(guard),
    });
    if (surface.correctedState) {
      this.#agentPage = surface.correctedState.requestedPage;
      this.#selectedAgent = surface.correctedState.selectedId;
    }
    this.appendSurface(lines, surface);
  }

  private selectActivityItem(item: ActivityItem): void {
    this.#activitySelection = item.id;
    if (item.kind === "terminal-task") this.#selectedTask = item.source.id;
    else if (item.kind === "terminal-group")
      this.#selectedGroup = item.source.id;
    else if (item.kind === "terminal-agent")
      this.#selectedAgent = item.source.id;
  }

  private renderActivitySurface(
    lines: string[],
    width: number,
    state: DeckState,
  ): void {
    const surface = renderActivity(
      {
        state,
        ...(this.#targetPaneId ? { targetPaneId: this.#targetPaneId } : {}),
        notifications: this.#client.store.notifications,
        screen: this.activityScreenState(),
        width,
        height: Math.max(1, this.#getHeight() - lines.length),
        onSelect: (id) => {
          if (id.startsWith("filter:")) {
            const filter = id.slice("filter:".length);
            if (
              ["all", "results", "signals", "agents", "errors"].includes(filter)
            ) {
              this.#activityFilter = filter as ActivityFilter;
              this.#activityScroll = 0;
            }
          } else {
            const item = selectActivityPresentation(
              state,
              this.#targetPaneId,
              this.#activitySelection,
              this.#activityFilter,
              this.#client.store.notifications,
            ).items.find((candidate) => candidate.id === id);
            if (item) this.selectActivityItem(item);
          }
        },
        actions: {
          isAllowed: (item, action) =>
            this.isActivityActionAllowed(item, action),
          activate: (item, action) => this.activateActivityAction(item, action),
        },
      },
      width,
    );
    if (surface.correctedState)
      this.#activityScroll = surface.correctedState.listScroll;
    this.#activitySurface = surface;
    this.#activitySurfaceOffset = lines.length;
    this.appendSurface(lines, surface);
  }

  private isActivityActionAllowed(
    item: ActivityItem,
    action: ActivityAction,
  ): boolean {
    if (action === "archive-update" || action === "retry-delivery")
      return Boolean(this.adoptedRootAgent());
    if (action === "focus")
      return item.kind === "terminal-agent" && Boolean(item.source.paneId);
    return true;
  }

  private activateActivityAction(
    item: ActivityItem,
    action: ActivityAction,
  ): void {
    this.selectActivityItem(item);
    if (action === "archive-update" || action === "retry-delivery") {
      const source = this.providerRecord(item.source);
      const fields =
        action === "archive-update"
          ? {
              updateId: item.entityId,
              expectedRevision: Number(source.revision ?? 0),
            }
          : {
              questionId: String(
                source.questionId ?? source.id ?? item.entityId,
              ),
              ...(source.answerId ? { answerId: String(source.answerId) } : {}),
              expectedRevision: Number(source.revision ?? 0),
            };
      void this.runBoardAction(action, fields);
    } else if (action === "focus") void this.run("focus");
    else void this.run("copyId");
  }

  private async runBoardAction(
    action: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const agent = this.adoptedRootAgent();
    if (!agent) return;
    try {
      await this.#actions.run("boardAction", {
        agent,
        boardAction: { action, fields },
      });
      this.#message = `Signals ${action} succeeded.`;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private appendSurface(
    lines: string[],
    surface: { lines: string[]; hitBoxes: HitBox[] },
  ): void {
    const offset = lines.length;
    lines.push(...surface.lines);
    this.#hitBoxes.push(
      ...surface.hitBoxes.map((box) => ({ ...box, y: box.y + offset })),
    );
  }

  private activityWheelRegion(
    x: number,
    y: number,
  ): "list" | "detail" | "outside" {
    const surface = this.#activitySurface;
    if (!surface) return "outside";
    const localY = y - this.#activitySurfaceOffset;
    const region = surface.regions.find(
      (candidate) =>
        x >= candidate.x &&
        x < candidate.x + candidate.width &&
        localY >= candidate.y &&
        localY < candidate.y + candidate.height,
    );
    return region?.id === "activity:list"
      ? "list"
      : region?.id === "activity:detail"
        ? "detail"
        : "outside";
  }

  private handleActivityKey(key: string): void {
    const model = selectActivityPresentation(
      this.#client.store.state,
      this.#targetPaneId,
      this.#activitySelection,
      this.#activityFilter,
      this.#client.store.notifications,
    );
    const result = handleActivityKey(
      this.activityScreenState(),
      key,
      model.items.map((item) => item.id),
    );
    if (result.selectedId) {
      const item = model.items.find(
        (candidate) => candidate.id === result.selectedId,
      );
      if (item) this.selectActivityItem(item);
    }
  }

  private activityScreenState() {
    return {
      filter: this.#activityFilter,
      ...(this.#activitySelection
        ? { selectedId: this.#activitySelection }
        : {}),
      listScroll: this.#activityScroll,
      detailScroll: this.#activityDetailScroll,
      wheelDetached: false,
    } as const;
  }

  private addHitBox(
    id: string,
    y: number,
    width: number,
    activate: () => void,
    disabled = false,
    x = 0,
  ): void {
    this.#hitBoxes.push({ id, x, y, width, height: 1, disabled, activate });
  }

  private addControlRow(
    lines: string[],
    controls: Array<{
      id: string;
      label: string;
      disabled?: boolean;
      activate(): void;
    }>,
    width: number,
  ): void {
    let line = "";
    let y = lines.length;
    for (const control of controls) {
      const rendered = renderButton(control.label, {
        disabled: control.disabled === true,
      });
      if (line.length > 0 && line.length + 1 + rendered.length > width) {
        lines.push(line);
        line = "";
        y = lines.length;
      }
      if (line.length > 0) line += " ";
      const x = line.length;
      line += rendered;
      this.addHitBox(
        control.id,
        y,
        Math.min(rendered.length, width),
        control.activate,
        control.disabled === true,
        x,
      );
    }
    lines.push(line.slice(0, width));
  }

  private adoptedRootAgent(): Agent | undefined {
    return selectAdoptedRootAgent(this.#client.store.state, this.#targetPaneId);
  }

  private providerRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
  private filesScreenOptions(): FilesScreenOptions {
    const authority = selectFilesPresentationAuthority(
      this.#client.store.state,
      this.#targetPaneId,
    );
    return {
      presentation: normalizeFilesPresentation(
        authority.provider?.files,
        authority.canOpenStandalone,
      ),
      state: this.#filesScreen,
      onStateChange: (next) => {
        this.#filesScreen = next;
      },
      onAction: (request) => this.runFilesAction(request),
    };
  }

  private renderFilesProvider(
    lines: string[],
    width: number,
    _state: DeckState,
  ): void {
    this.#filesOptions = this.filesScreenOptions();
    const surface = renderFilesScreen(
      this.#filesOptions,
      width,
      Math.max(1, this.#getHeight() - lines.length),
    );
    if (surface.correctedState) this.#filesScreen = surface.correctedState;
    this.#filesSurface = surface;
    this.#filesSurfaceOffset = lines.length;
    this.appendSurface(lines, surface);
  }

  private runFilesAction(request: FilesActionRequest): void {
    switch (request.action) {
      case "open-standalone":
        this.runProvider("filesOpen", "files-open");
        return;
      case "set-filter":
        void this.runFiles("filter", request.filter ?? "");
        return;
      case "expand":
      case "toggle-selection":
      case "preview":
        if (request.actionPath !== undefined)
          void this.runFiles(
            request.action,
            request.actionPath,
            request.expanded,
          );
        return;
      case "insert-paths":
      case "insert-contents":
      case "clear-selection":
      case "refresh":
      case "toggle-hidden":
        void this.runFiles(request.action);
        return;
    }
  }

  private async runFiles(
    action: string,
    value?: string,
    expanded?: boolean,
  ): Promise<void> {
    const agent = this.adoptedRootAgent();
    if (!agent) {
      this.#message = "Files provider owner is unavailable.";
      return;
    }
    try {
      await this.#actions.run("filesAction", {
        agent,
        filesAction: {
          action,
          ...(value !== undefined
            ? action === "filter"
              ? { query: value }
              : { path: value }
            : {}),
          ...(expanded !== undefined ? { expanded } : {}),
        },
      } as never);
      this.#message = `Files ${action} succeeded.`;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }
  private async runBoard(action: string): Promise<void> {
    const agent = this.adoptedRootAgent();
    const projection = currentProviderProjection(
      this.#client.store.state,
      this.#targetPaneId,
    )?.agentBoard;
    const presentation = selectBoardPresentation(
      projection,
      this.#boardTab,
      this.#boardSelection,
    );
    if (!agent || !presentation.selectedId) return;
    const id = presentation.selectedId;
    const detail = presentation.detail;
    const detailProjection = this.providerRecord(detail.projection ?? detail);
    const item = this.providerRecord(
      detailProjection.item ?? detailProjection.decision ?? detailProjection,
    );
    const answer = this.providerRecord(
      detailProjection.answer ??
        this.providerRecord(detailProjection.decision).answer,
    );
    const questionId = String(item.id ?? item.questionId ?? id);
    const answerId = String(
      answer.id ?? answer.answerId ?? detailProjection.answerId ?? id,
    );
    const fields =
      action === "archive-update"
        ? { updateId: id, expectedRevision: presentation.selectedRevision }
        : action === "acknowledge-answer"
          ? {
              answerId,
              outcome: "applied",
              summary: "Acknowledged from Agent Board.",
            }
          : action === "retry-delivery"
            ? {
                questionId,
                answerId,
                expectedRevision: presentation.selectedRevision,
              }
            : {
                questionId,
                expectedRevision: presentation.selectedRevision,
              };
    try {
      await this.#actions.run("boardAction", {
        agent,
        boardAction: { action, fields },
      } as never);
      this.#message = `Signals ${action} succeeded.`;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private scopedWorkState(state: DeckState): DeckState {
    return selectAdoptedScope(state, this.#targetPaneId).state;
  }

  private agentPresentation(state: DeckState = this.#client.store.state) {
    const scoped = this.scopedWorkState(state);
    return selectAgentListPresentation(
      scoped.agents.values(),
      this.#agentFilter,
      this.#agentPage,
      this.#selectedAgent,
    );
  }

  private selectedAgent(): Agent | undefined {
    return this.agentPresentation().selected;
  }
  private selected<T extends { id: string }>(
    items: T[],
    id: string | undefined,
  ): T | undefined {
    return effectiveSelection(items, id);
  }

  private selectedGroup(
    state: DeckState = this.#client.store.state,
  ): DeckGroup | undefined {
    return this.selected([...state.groups.values()], this.#selectedGroup);
  }
  private selectedTask(
    state: DeckState = this.#client.store.state,
  ): Task | undefined {
    return this.selected([...state.tasks.values()], this.#selectedTask);
  }
  private selectedProviderTodo(
    items = currentProviderProjection(
      this.#client.store.state,
      this.#targetPaneId,
    )?.todo.items ?? [],
  ) {
    return this.selected(items, this.#selectedProviderTodo);
  }
  private selectedQuestion(): DeckQuestion | undefined {
    return this.selected(
      currentBlockingQuestions(this.#client.store.state, this.#targetPaneId),
      this.#selectedQuestion,
    );
  }

  private selectedBoardQuestion(): AgentBoardPendingQuestion | undefined {
    if (this.#boardTab !== "inbox") return undefined;
    const projection = currentProviderProjection(
      this.#client.store.state,
      this.#targetPaneId,
    )?.agentBoard;
    const questions = projection?.pendingQuestions ?? [];
    const presentation = selectBoardPresentation(
      projection,
      "inbox",
      this.#boardSelection,
    );
    if (presentation.pendingQuestion) return presentation.pendingQuestion;
    const detail = presentation.detail;
    const detailProjection = this.providerRecord(detail.projection);
    const item = this.providerRecord(
      detailProjection.item ?? detailProjection.question ?? detailProjection,
    );
    const response = this.providerRecord(
      detailProjection.response ?? item.response,
    );
    const questionId = String(item.id ?? item.questionId ?? "");
    const question = String(
      item.question ??
        item.prompt ??
        item.title ??
        detailProjection.question ??
        "",
    );
    const revision = Number(item.revision ?? detailProjection.revision ?? 0);
    const kind = response.kind;
    if (
      !questionId ||
      !question ||
      !Number.isSafeInteger(revision) ||
      ![
        "single",
        "multiple",
        "text",
        "single_or_text",
        "multiple_or_text",
      ].includes(String(kind))
    ) {
      return (
        (presentation.selectedId
          ? questions.find(
              (entry) => entry.questionId === presentation.selectedId,
            )
          : undefined) ?? questions[0]
      );
    }
    const options = Array.isArray(response.options)
      ? response.options.flatMap((value) => {
          const option = this.providerRecord(value);
          const id = typeof option.id === "string" ? option.id : "";
          const label = typeof option.label === "string" ? option.label : "";
          return id && label
            ? [
                {
                  id,
                  label,
                  ...(typeof option.description === "string"
                    ? { description: option.description }
                    : {}),
                },
              ]
            : [];
        })
      : [];
    const recommendedOptionIds =
      item.recommendedOptionIds ?? detailProjection.recommendedOptionIds;
    const recommendedText =
      item.recommendedText ?? detailProjection.recommendedText;
    return {
      questionId,
      revision,
      question,
      response: {
        kind: kind as AgentBoardPendingQuestion["response"]["kind"],
        options,
      },
      recommendedOptionIds: Array.isArray(recommendedOptionIds)
        ? recommendedOptionIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      ...(typeof recommendedText === "string" ? { recommendedText } : {}),
    };
  }

  private move(delta: number): void {
    const state = this.#client.store.state;
    if (this.#settingsOpen) {
      this.#settingsScroll = Math.max(
        0,
        Math.min(
          Math.max(0, (this.#capabilities?.models.length ?? 0) - 1),
          this.#settingsScroll + delta,
        ),
      );
    } else if (this.#tab === "agents") {
      const moved = moveAgentListSelection(
        this.agentPresentation(state),
        delta,
      );
      this.#selectedAgent = moved.selectedId;
      this.#agentPage = moved.page;
    } else if (this.#tab === "board") {
      const model = selectUnifiedBoardPresentation(
        state,
        this.#targetPaneId,
        this.#unifiedBoardSelection,
        this.#boardFilter,
      );
      const items = model.visible;
      if (items.length > 0) {
        const index = Math.max(
          0,
          items.findIndex((item) => item.id === model.selected?.id),
        );
        this.selectBoardItem(
          items[(index + delta + items.length) % items.length]!,
        );
      }
    } else if (this.#tab === "activity") {
      const model = selectActivityPresentation(
        state,
        this.#targetPaneId,
        this.#activitySelection,
        this.#activityFilter,
        this.#client.store.notifications,
      );
      if (model.items.length > 0) {
        const index = Math.max(
          0,
          model.items.findIndex((item) => item.id === model.selected?.id),
        );
        this.selectActivityItem(
          model.items[
            (index + delta + model.items.length) % model.items.length
          ]!,
        );
      }
    }
    this.#confirmation = undefined;
  }

  private target() {
    const scoped = this.scopedWorkState(this.#client.store.state);
    const task =
      this.#tab === "board" ? this.selectedTask(scoped) : this.selectedTask();
    const boardSelected =
      this.#tab === "board"
        ? selectUnifiedBoardPresentation(
            this.#client.store.state,
            this.#targetPaneId,
            this.#unifiedBoardSelection,
            this.#boardFilter,
          ).selected
        : undefined;
    const boardOwner =
      boardSelected?.kind === "task" && boardSelected.source.assignedAgentId
        ? scoped.agents.get(boardSelected.source.assignedAgentId)
        : boardSelected?.kind === "agent-alert"
          ? boardSelected.source
          : undefined;
    const agent =
      boardOwner ??
      (this.#tab === "board" || this.#tab === "files"
        ? this.adoptedRootAgent()
        : (this.selectedAgent() ?? this.adoptedRootAgent()));
    const question = this.selectedQuestion();
    const group =
      this.#tab === "board" ? this.selectedGroup(scoped) : this.selectedGroup();
    return {
      ...(agent
        ? {
            agent,
            ...(agent.paneId ? { paneId: agent.paneId } : {}),
            ...(agent.terminalId ? { terminalId: agent.terminalId } : {}),
            generation: agent.generation,
            ...(agent.currentRunId ? { runId: agent.currentRunId } : {}),
          }
        : {}),
      ...(task ? { task } : {}),
      ...(group ? { group } : {}),
      ...(this.selectedProviderTodo()
        ? {
            todoTaskId: this.selectedProviderTodo()!.id,
            todoHasWait: Boolean(this.selectedProviderTodo()!.waitReason),
          }
        : {}),
      ...(question ? { question, questionId: question.id } : {}),
      ...(this.selectedBoardQuestion()
        ? {
            boardQuestion: this.selectedBoardQuestion(),
            questionId: this.selectedBoardQuestion()!.questionId,
          }
        : {}),
    };
  }

  private runProvider(action: DeckAction, key: string, value?: unknown): void {
    if (this.#providerPending.has(key)) return;
    this.#providerPending.add(key);
    this.#message = `${action} pending…`;
    this.#requestRender();
    void this.#actions
      .run(
        action,
        this.target() as import("./actions.js").ActionTarget,
        value as never,
      )
      .then(
        () => {
          this.#message = `${action} succeeded.`;
        },
        (error) => {
          this.#message =
            error instanceof Error ? error.message : String(error);
        },
      )
      .finally(() => {
        this.#providerPending.delete(key);
        this.#requestRender();
      });
  }
  private async run(action: DeckAction, value?: string): Promise<void> {
    try {
      const target = this.target() as import("./actions.js").ActionTarget;
      this.#onActionTarget?.(action, target);
      const result = await this.#actions.run(action, target, value);
      this.#message =
        action === "copyId"
          ? `Copied ID: ${String(result)}`
          : `${action} accepted.`;
      this.#confirmation = undefined;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private beginInput(mode: InputMode): void {
    const target = this.target() as import("./actions.js").ActionTarget;
    if (mode === "board-answer" && !this.selectedBoardQuestion()) {
      this.#message = "Select a Signals question first.";
      return;
    }
    if (mode === "create" && !target.agent) {
      this.#message = "Select a parent agent first.";
      return;
    }
    const action: DeckAction =
      mode === "answer" ? "answer" : (mode as DeckAction);
    const denied =
      mode === "create" || mode === "default" || mode === "board-answer"
        ? undefined
        : this.#actions.authorize(action, target);
    if (denied) {
      this.#message = denied;
      return;
    }
    if (mode === "answer" && target.question?.answered) {
      this.#message = "The selected question is terminal.";
      return;
    }
    this.#inputMode = mode;
    this.#input = "";
    this.#message = "";
  }

  private handleEditorInput(data: string): void {
    if (data === "\u001b") {
      this.#inputMode = undefined;
      this.#input = "";
      this.#message = "Input cancelled.";
    } else if (data === "\u007f" || data === "\b")
      this.#input = this.#input.slice(0, -1);
    else if (data === "\r" || data === "\n") {
      const mode = this.#inputMode;
      if (!mode) return;
      const value = this.#input.trim();
      if (!value) {
        this.#message = "Text is required.";
        return;
      }
      this.#inputMode = undefined;
      this.#input = "";
      if (mode === "create") void this.createAgent(value);
      else if (mode === "files-filter") {
        this.#filesScreen = { ...this.#filesScreen, treeScroll: 0 };
        void this.runFiles("filter", value);
      } else if (mode === "model-filter") {
        this.#modelFilter = value;
        this.#settingsScroll = 0;
        this.#inputMode = undefined;
        this.#input = "";
      } else if (mode === "default") void this.setDefault(value);
      else if (mode === "board-answer") {
        const question = this.selectedBoardQuestion();
        if (question)
          this.runProvider("agentBoardAnswer", "board-answer", {
            kind: "text",
            text: value,
          });
      } else void this.run(mode === "answer" ? "answer" : mode, value);
    } else if (
      data.length > 0 &&
      !data.includes("\u001b") &&
      [...data].every((character) => character.codePointAt(0)! >= 0x20)
    )
      this.#input = `${this.#input}${data}`.slice(0, 16_384);
  }

  private renderSettings(_width: number): string[] {
    const defaults = this.#modelPolicy?.defaults;
    const lines = [
      "DEFAULTS FOR NEW AGENTS",
      `Global  ${defaults?.global ? `${defaults.global.provider}/${defaults.global.modelId}  ·  ${defaults.global.thinkingLevel}` : "Not set"}`,
      ...Object.entries(defaults?.roles ?? {}).map(
        ([key, model]) =>
          `Role ${key}  ${model.provider}/${model.modelId}  ·  ${model.thinkingLevel}`,
      ),
      ...Object.entries(defaults?.projects ?? {}).map(
        ([key, model]) =>
          `Project ${key}  ${model.provider}/${model.modelId}  ·  ${model.thinkingLevel}`,
      ),
      "",
      "LIFECYCLE",
      `Automatic close after collected temporary work  ${this.#autoCloseCompletedTemporary ? "● ON" : "○ OFF"}`,
      "Completed work is collected before safe automatic closure.",
      "",
      "MODEL CATALOG",
      `${this.#modelFilter ? `Search: ${this.#modelFilter}` : "Press / to search by provider or model"}`,
    ];
    if (!this.#capabilities) {
      lines.push("Loading installed Pi capabilities…");
      return lines;
    }
    const filtered = this.#capabilities.models.filter(
      (model) =>
        !this.#modelFilter ||
        `${model.provider}/${model.modelId}`
          .toLowerCase()
          .includes(this.#modelFilter.toLowerCase()),
    );
    const providerCounts = new Map<string, number>();
    for (const model of filtered)
      providerCounts.set(
        model.provider,
        (providerCounts.get(model.provider) ?? 0) + 1,
      );
    lines.push(
      `${filtered.length} models from ${providerCounts.size} providers`,
    );
    if (!this.#modelFilter) {
      for (const [provider, count] of [...providerCounts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8))
        lines.push(`  ${provider}  ${count} models`);
      lines.push(
        "",
        "Search to choose an exact model. The full catalog stays out of the main view.",
      );
    } else {
      const pageSize = Math.max(3, this.#getHeight() - lines.length - 4);
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.min(
        Math.floor(this.#settingsScroll / pageSize),
        pages - 1,
      );
      const start = page * pageSize;
      for (const model of filtered.slice(start, start + pageSize))
        lines.push(
          `  ${model.provider}/${model.modelId}  ·  ${model.thinkingLevels.join(" ")}`,
        );
      lines.push(
        `Page ${page + 1}/${pages}  ·  ↑↓ browse  ·  d set scoped default`,
      );
    }
    return lines;
  }

  private async loadSettings(): Promise<void> {
    try {
      const [capabilities, settings] = await Promise.all([
        this.#client.request("model.capabilities", {}),
        this.#client.request("model.policy.get", {}),
      ]);
      this.#capabilities = capabilities as PiCapabilitySnapshot;
      const loaded = settings as {
        policy?: ModelPolicyConfig;
        lifecyclePolicy?: { autoCloseCompletedTemporary?: boolean };
      };
      this.#modelPolicy = loaded.policy;
      this.#autoCloseCompletedTemporary =
        loaded.lifecyclePolicy?.autoCloseCompletedTemporary === true;
      this.#message = "Installed model choices loaded.";
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private async toggleAutoClose(): Promise<void> {
    try {
      const enabled = !this.#autoCloseCompletedTemporary;
      await this.#client.request("lifecycle.policy.set", {
        autoCloseCompletedTemporary: enabled,
      });
      this.#autoCloseCompletedTemporary = enabled;
      this.#message = `Safe automatic closure is ${enabled ? "on" : "off"}. Protected and uncollected agents stay open.`;
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private async setDefault(value: string): Promise<void> {
    const [scope, key, provider, modelId, thinkingLevel, ...extra] = value
      .split("|")
      .map((part) => part.trim());
    if (
      extra.length ||
      !scope ||
      !provider ||
      !modelId ||
      !thinkingLevel ||
      !["global", "role", "project"].includes(scope)
    ) {
      this.#message =
        "Use scope|key|provider|model|thinking. The global key is empty.";
      this.#requestRender();
      return;
    }
    try {
      await this.#client.request("model.policy.set", {
        scope,
        key: key ?? "",
        model: { provider, modelId, thinkingLevel },
      });
      await this.loadSettings();
      this.#message =
        "The scoped default was accepted for new agents. Running agents were not changed.";
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private async createAgent(value: string): Promise<void> {
    const [
      title,
      objective,
      profileId,
      provider,
      modelId,
      thinkingLevel,
      lifecycleClass,
      ...extra
    ] = value.split("|").map((part) => part.trim());
    const parent = this.selectedAgent();
    if (
      extra.length ||
      !parent?.cwd ||
      !title ||
      !objective ||
      !profileId ||
      !provider ||
      !modelId ||
      !thinkingLevel ||
      !["temporary", "reusable", "retained", "pinned"].includes(
        lifecycleClass ?? "",
      )
    ) {
      this.#message =
        "Use title|objective|profile|provider|model|thinking|lifecycle with a parent that has a project.";
      this.#requestRender();
      return;
    }
    try {
      await this.#client.request("agent.spawn", {
        parentAgentId: parent.id,
        task: { title, objective },
        profileId,
        model: { provider, modelId, thinkingLevel },
        lifecycleClass,
        keepForReuse: lifecycleClass === "reusable",
        project: { cwd: parent.cwd },
        isolation: {
          mode: ["scout", "reviewer"].includes(profileId)
            ? "shared-readonly"
            : "worktree",
        },
        budget: { wallTimeMs: 1_800_000 },
        wait: false,
      });
      this.#message = `Creation accepted with explicit ${provider}/${modelId} and ${thinkingLevel} thinking.`;
      await this.#client.refresh();
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    }
    this.#requestRender();
  }

  private confirmTaskCancel(): void {
    const task = this.selectedTask(
      this.scopedWorkState(this.#client.store.state),
    );
    if (!task) {
      this.#message = "Select a task first.";
      return;
    }
    this.#confirmation = {
      action: "cancelTask",
      targetId: task.id,
      summary: `Cancel ${task.title}?`,
    };
    this.#tracker.reset();
  }

  private confirmGroup(action: "groupStop" | "groupClose"): void {
    const group = this.selectedGroup(
      this.scopedWorkState(this.#client.store.state),
    );
    if (!group) {
      this.#message = "Select a group first.";
      return;
    }
    this.#confirmation = {
      action,
      targetId: group.id,
      summary: `${action === "groupStop" ? "Stop" : "Close"} ${group.name ?? group.id}?`,
    };
    this.#tracker.reset();
  }

  private confirmAgentStop(): void {
    const agent = this.selectedAgent();
    if (!agent) return;
    this.#confirmation = {
      action: "stop",
      targetId: agent.id,
      generation: agent.generation,
      summary: `Stop ${agent.displayName ?? agent.id}?`,
    };
    this.#tracker.reset();
  }

  private confirmClose(): void {
    const agent = this.selectedAgent();
    if (!agent) {
      this.#message = "Select an agent first.";
      return;
    }
    this.#confirmation = {
      action: "close",
      targetId: agent.id,
      generation: agent.generation,
      summary: `Close ${agent.displayName ?? agent.id}?`,
    };
    this.#tracker.reset();
  }

  private cycleModel(): void {
    const agent = this.selectedAgent();
    const choices = getAgentModelChoices(agent);
    if (choices.length === 0) {
      this.#message =
        "The broker did not advertise model choices for this agent.";
      return;
    }
    const current =
      (
        agent as unknown as {
          actualModel?: { provider?: string; id?: string };
          model?: { provider?: string; id?: string };
        }
      ).actualModel ??
      (agent as unknown as { model?: { provider?: string; id?: string } })
        .model;
    const index = choices.findIndex(
      (choice) =>
        choice.provider === current?.provider && choice.id === current?.id,
    );
    const next = choices[(index + 1) % choices.length]!;
    void this.run("setModel", `${next.provider}/${next.id}`);
  }

  private cycleThinking(): void {
    const agent = this.selectedAgent();
    const choices = getAgentThinkingChoices(agent);
    if (choices.length === 0) {
      this.#message =
        "The broker did not advertise thinking choices for this agent.";
      return;
    }
    const current =
      (agent as unknown as { actualThinking?: string; thinkingLevel?: string })
        .actualThinking ??
      (agent as unknown as { thinkingLevel?: string }).thinkingLevel;
    const index = choices.indexOf(current ?? "");
    void this.run("setThinking", choices[(index + 1) % choices.length]!);
  }
}
