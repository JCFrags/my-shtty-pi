import type { BrowserControl } from "../agent/control";
import { browserMenuItems, type BrowserMenuEntryPage, type BrowserMenuPage, type BrowserMenuState } from "../ui/browser-menu";
import type { PageMenuItem } from "../ui/types";
import type { ClosePreview, CompanionService, HumanCapture, ReceiverBinding } from "./companion-service";

interface BrowserMenuHost {
  service: CompanionService;
  control: BrowserControl;
  selectMode(mode: "agent" | "human" | "shared"): void;
  show(entryPage: BrowserMenuEntryPage): void;
  close(): void;
  focusPage(): void;
  render(): void;
  toast(text: string, failed?: boolean): void;
  blockingItems(): PageMenuItem[];
  toolItems(): PageMenuItem[];
}

/** Native user choices use the same service as the owner-scoped CLI. */
export class NativeBrowserMenu {
  private page: BrowserMenuPage = "main";
  private entryPage: BrowserMenuEntryPage = "main";
  private preview: { page: HumanCapture; receiver: ReceiverBinding } | null = null;
  private closePreview: ClosePreview | null = null;
  private disconnectPreview: ReceiverBinding | null = null;
  private generation = 0;
  private busy = false;

  constructor(private readonly host: BrowserMenuHost) {}

  open(entryPage: BrowserMenuEntryPage = "main"): void {
    this.closed();
    this.entryPage = entryPage;
    this.show(entryPage);
  }

  closed(): void {
    this.generation++;
    this.page = "main";
    this.entryPage = "main";
    this.preview = null;
    this.closePreview = null;
    this.disconnectPreview = null;
  }

  back(): void {
    if (this.page === this.entryPage) this.host.close();
    else this.show(this.page === "send-link" || this.page === "send-visual" ? "send"
      : this.page === "disconnect" ? "settings" : "main");
  }

  items(): PageMenuItem[] {
    const status = this.host.service.status();
    const receiver = this.page === "send-link" || this.page === "send-visual" ? this.preview?.receiver
      : this.page === "disconnect" ? this.disconnectPreview : status.binding;
    const state: BrowserMenuState = {
      mode: status.mode,
      receiverLabel: receiver ? `${receiver.receiverKind}: ${receiver.receiverSessionId}` : null,
      receiverOnline: status.receiverOnline,
      pendingShare: status.pendingShareId !== null,
      updatesEnabled: status.updates.enabled,
      updatesSuspended: status.updates.suspended,
      updatesActive: status.updates.active,
      ...(this.preview ? { page: this.preview.page } : {}),
      ...(this.closePreview ? { close: this.closePreview } : {}),
    };
    let items = browserMenuItems(this.page, state);
    if (this.page === "blocking") items = [...this.host.blockingItems(), ...items];
    if (this.page === "tools") items = [...this.host.toolItems().filter(item => !item.id.startsWith("blocking:")), ...items];
    if (this.page === this.entryPage && this.entryPage !== "main") {
      items = items.map(item => item.id === "browser:back" ? { ...item, label: "Dismiss" } : item);
    }
    return this.busy ? items.map(item => ({ ...item, enabled: item.id === "browser:back" && item.enabled })) : items;
  }

  detail(): string {
    const status = this.host.service.status();
    return status.pendingShareId ? "Send pending" : status.updates.suspended ? "updates suspended" : status.updates.active
      ? status.receiverOnline ? "updates on" : "receiver offline" : "";
  }

  async run(id: string): Promise<void> {
    if (!this.items().some(item => item.id === id && item.enabled)) return;
    const action = id.slice("browser:".length);
    if (action === "back") { this.back(); return; }
    if (this.busy) return;
    if (["control", "settings", "send", "blocking", "tools"].includes(action)) {
      this.show(action as BrowserMenuPage);
      return;
    }
    this.busy = true;
    this.host.render();
    try {
      const service = this.host.service;
      if (action === "open") {
        this.host.close();
        this.host.focusPage();
      } else if (action === "mode-agent" || action === "mode-human" || action === "mode-shared") {
        const mode = action === "mode-agent" ? "agent" : action === "mode-human" ? "human" : "shared";
        this.host.selectMode(mode);
        this.host.close();
      } else if (action === "updates") {
        const status = service.status();
        if (!status.binding) throw new Error("No receiver is associated.");
        service.setUpdates({ ...status.binding, enabled: !status.updates.enabled });
      } else if (action === "send-link-preview" || action === "send-visual-preview") {
        const receiver = service.status().binding;
        if (!receiver) throw new Error("No receiver is associated.");
        const generation = this.generation;
        const page = await service.capture("link");
        if (generation !== this.generation) return;
        const current = service.status().binding;
        if (current?.bindingId !== receiver.bindingId || current.receiverGeneration !== receiver.receiverGeneration) {
          throw new Error("Receiver changed. Preview the current association.");
        }
        this.preview = { page, receiver };
        this.show(action === "send-visual-preview" ? "send-visual" : "send-link");
      } else if (action === "send-link-confirm" || action === "send-visual-confirm") {
        const preview = this.preview;
        if (!preview) throw new Error("Preview the current page before Send.");
        this.host.close();
        await service.share({ ...preview.receiver, format: action === "send-visual-confirm" ? "visual" : "link",
          expectedContextId: preview.page.contextId, expectedDocumentGeneration: preview.page.documentGeneration });
        this.host.toast("Send queued for the associated receiver. Submission is not yet confirmed.");
      } else if (action === "close") {
        this.closePreview = service.previewClose();
        this.show("close");
      } else if (action === "close-confirm") {
        const preview = this.closePreview;
        if (!preview) throw new Error("Preview the close scope first.");
        this.host.close();
        const result = await service.confirmClose(preview.revision);
        if (result.status !== "closed") this.host.toast(`Close: ${result.status}. Remaining contexts: ${result.remainingContextIds.join(", ") || "none"}. Human mode remains selected.`);
      } else if (action === "disconnect") {
        const receiver = service.status().binding;
        if (!receiver) throw new Error("No receiver is associated.");
        this.disconnectPreview = receiver;
        this.show("disconnect");
      } else if (action === "disconnect-confirm") {
        const receiver = this.disconnectPreview;
        if (!receiver) throw new Error("Preview the receiver before disconnecting.");
        service.unbind(receiver);
        this.host.close();
        this.host.toast("Receiver disconnected. The browser stays open.");
      }
    } catch (error) {
      this.host.toast(error instanceof Error ? error.message : "The browser operation failed. It was not replayed.", true);
    } finally {
      this.busy = false;
      this.host.render();
    }
  }

  private show(page: BrowserMenuPage): void {
    this.page = page;
    this.host.show(this.entryPage);
  }
}
