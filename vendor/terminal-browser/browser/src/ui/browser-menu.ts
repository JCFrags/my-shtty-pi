import { controlLabel } from "./control-strip";
import type { PageMenuItem } from "./types";

export type BrowserMenuEntryPage = "main" | "control" | "blocking";
export type BrowserMenuPage = BrowserMenuEntryPage | "settings" | "send" | "send-link" | "send-visual" | "close" | "disconnect" | "tools";

export interface BrowserMenuState {
  mode: string;
  receiverLabel: string | null;
  receiverOnline: boolean;
  pendingShare: boolean;
  updatesEnabled: boolean;
  updatesActive: boolean;
  page?: { title: string; url: string };
  close?: {
    contexts: { contextId: number; contextKind: string; title: string }[];
    transfers: { id: string; contextId: number; state: string }[];
  };
}

const item = (id: string, label: string, enabled = true, shortcut = ""): PageMenuItem =>
  ({ id: `browser:${id}`, label, enabled, shortcut });
const back = () => item("back", "Back", true, "Esc");
const bounded = (value: string, max = 76) => value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);

/** Menu labels only. BrowserSession executes each explicit native operation. */
export function browserMenuItems(page: BrowserMenuPage, state: BrowserMenuState): PageMenuItem[] {
  const receiver = state.receiverLabel ? bounded(state.receiverLabel, 44) : "Not associated";
  const canSend = state.receiverOnline && !state.pendingShare;
  switch (page) {
    case "main":
      return [
        item("open", "Open/focus current browser"),
        item("mode-agent", "Return control to agent"),
        item("control", `Control mode: ${controlLabel(state.mode)}`),
        item("send", state.pendingShare ? "Send current page: pending" : state.receiverOnline
          ? "Send current page" : "Send current page: receiver offline", canSend),
        item("settings", "Settings"),
        item("close", "Close this owned browser"),
      ];
    case "control":
      return [
        ...["agent", "human", "shared"].map(mode => item(`mode-${mode}`, controlLabel(mode), true, state.mode === mode ? "current" : "")),
        item("info", "Human mode stops agent input and page updates", false),
        item("info-updates", "Shared can send page images without a reply", false),
        back(),
      ];
    case "settings":
      return [
        item("receiver-info", `Receiver: ${receiver}`, false),
        item("updates", `Shared page updates: ${state.updatesEnabled ? "On" : "Off"}${state.updatesActive ? " (active)" : ""}`, state.receiverLabel !== null),
        item("updates-info", "Page screenshots can contain private data", false),
        item("blocking", "Ad blocking (shared profile)"),
        item("tools", "Tools"),
        item("disconnect", "Disconnect this receiver", state.receiverLabel !== null),
        back(),
      ];
    case "send":
      return [
        item("receiver-info", `Send to: ${receiver}`, false),
        item("send-link-preview", "Link and title", canSend),
        item("send-visual-preview", "Viewport screenshot, link and title", canSend),
        back(),
      ];
    case "send-link":
    case "send-visual":
      return [
        item("receiver-info", `Send to: ${receiver}`, false),
        item("page-title", `Page: ${bounded(state.page?.title || "Untitled")}`, false),
        item("page-url", bounded(state.page?.url || "No page"), false),
        ...(page === "send-visual" ? [item("image-warning", "The screenshot can contain private page data", false)] : []),
        item("reply-info", "Requests a reply. A busy receiver can queue it", false),
        item(page === "send-visual" ? "send-visual-confirm" : "send-link-confirm", "Send and request reply", canSend && !!state.page),
        back(),
      ];
    case "close":
      return [
        back(),
        item("close-scope", `Close ${state.close?.contexts.length ?? 0} contexts in this browser only`, false),
        item("close-warning", "Unsaved page work can be lost", false),
        ...(state.close?.contexts ?? []).map(context => item(`close-context-${context.contextId}`,
          `${context.contextKind} ${context.contextId}: ${bounded(context.title || "Untitled", 60)}`, false)),
        item("close-transfers", `Active transfers: ${state.close?.transfers.length ?? 0}`, false),
        ...(state.close?.transfers ?? []).map(transfer => item(`close-transfer-${transfer.id}`,
          `${bounded(transfer.id, 40)}: context ${transfer.contextId}, ${bounded(transfer.state, 20)}`, false)),
        item("close-confirm", "Close the approved contexts", !!state.close?.contexts.length),
      ];
    case "disconnect":
      return [
        item("receiver-info", `Disconnect: ${receiver}`, false),
        item("disconnect-info", "The browser stays open. Pending shares are discarded", false),
        item("disconnect-confirm", "Disconnect receiver", state.receiverLabel !== null),
        back(),
      ];
    case "blocking":
    case "tools":
      return [back()];
  }
}
