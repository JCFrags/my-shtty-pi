import type {
  EditToolInput,
  ExtensionContext,
  ToolCallEventResult,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { conciseError, loadConfig, type ReviewUiConfig } from "./config.js";
import {
  showReviewDialog,
  showRiskDialog,
  type ReviewDialogDecision,
  type RiskDialogDecision,
} from "./dialog.js";
import { piBuiltinSemantics } from "./pi-semantics.js";
import {
  buildReviewPreview,
  type BuildPreviewOptions,
  type BuiltinSemantics,
  type ReviewInput,
  type ReviewPreview,
} from "./preview.js";
import { QueueAbortError, ReviewQueue, type QueueRunContext } from "./queue.js";
import { renderControlCharacters } from "./text-safety.js";

export const USER_REJECTION_REASON = "Rejected by user";

export interface ReviewCoordinatorDependencies {
  queue: ReviewQueue;
  loadConfig: typeof loadConfig;
  buildPreview: (request: ReviewInput, options: BuildPreviewOptions) => Promise<ReviewPreview>;
  resolveSemantics: (tool: "edit" | "write") => BuiltinSemantics;
  showReview: (
    ctx: ExtensionContext,
    preview: ReviewPreview,
    allowApproveAllForTurn: boolean,
    queueContext: QueueRunContext,
  ) => Promise<ReviewDialogDecision>;
  showRisk: (
    ctx: ExtensionContext,
    preview: ReviewPreview,
    kind: "outside-cwd" | "oversized",
    queueContext: QueueRunContext,
  ) => Promise<RiskDialogDecision>;
}

const DEFAULT_DEPENDENCIES: ReviewCoordinatorDependencies = {
  queue: new ReviewQueue(),
  loadConfig,
  buildPreview: buildReviewPreview,
  resolveSemantics: () => piBuiltinSemantics,
  showReview: (ctx, preview, allowApproveAllForTurn, queueContext) =>
    showReviewDialog(ctx.ui, preview, allowApproveAllForTurn, queueContext),
  showRisk: (ctx, preview, kind, queueContext) =>
    showRiskDialog(ctx.ui, preview, kind, queueContext.signal, queueContext),
};

export class ReviewCoordinator {
  private currentTurnIndex: number | undefined;
  private approvedTurnIndex: number | undefined;
  private readonly dependencies: ReviewCoordinatorDependencies;

  constructor(dependencies: Partial<ReviewCoordinatorDependencies> = {}) {
    this.dependencies = {
      ...DEFAULT_DEPENDENCIES,
      queue: dependencies.queue ?? new ReviewQueue(),
      ...dependencies,
    };
  }

  onTurnStart(turnIndex: number): void {
    this.currentTurnIndex = turnIndex;
    this.approvedTurnIndex = undefined;
  }

  onTurnEnd(turnIndex: number): void {
    if (this.currentTurnIndex === turnIndex) this.currentTurnIndex = undefined;
    if (this.approvedTurnIndex === turnIndex) this.approvedTurnIndex = undefined;
  }

  onSessionBoundary(reason: string): void {
    this.currentTurnIndex = undefined;
    this.approvedTurnIndex = undefined;
    this.dependencies.queue.abortAll(`Review aborted: ${reason}`);
  }

  async handleEdit(
    toolCallId: string,
    input: EditToolInput,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | void> {
    return this.handle({ tool: "edit", toolCallId, input }, ctx);
  }

  async handleWrite(
    toolCallId: string,
    input: WriteToolInput,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | void> {
    return this.handle({ tool: "write", toolCallId, input }, ctx);
  }

  private async handle(request: ReviewInput, ctx: ExtensionContext): Promise<ToolCallEventResult | void> {
    const requestTurnIndex = this.currentTurnIndex;
    try {
      // Enqueue before any asynchronous config or preview work. Otherwise two
      // parallel tool_call handlers could reach the queue in filesystem-latency
      // order rather than tool-call arrival order.
      return await this.dependencies.queue.enqueue(async (queueContext) => {
        const configResult = await this.dependencies.loadConfig(ctx.cwd);
        throwIfReviewAborted(queueContext.signal);
        if (!configResult.ok) {
          const reason = safeReason(
            `Review UI configuration error in ${configResult.path}: ${configResult.error}`,
          );
          this.notifyError(ctx, reason);
          return { block: true, reason };
        }

        const config = configResult.config;
        if (!isReviewEnabled(request, config)) return;

        if (ctx.mode !== "tui" && config.nonInteractive === "block") {
          return {
            block: true,
            reason:
              `Review UI unavailable in non-interactive mode (${ctx.mode}); ` +
              "blocked by nonInteractive=block",
          };
        }

        return ctx.mode === "tui"
          ? this.processInteractive(request, ctx, config, requestTurnIndex, queueContext)
          : this.processNonInteractiveAllow(request, ctx, config, queueContext);
      }, ctx.signal);
    } catch (error: unknown) {
      if (error instanceof QueueAbortError) {
        return { block: true, reason: error.blockReason };
      }
      const reason = safeReason(`Review failed closed: ${conciseError(error)}`);
      this.notifyError(ctx, reason);
      return { block: true, reason };
    }
  }

  private async processNonInteractiveAllow(
    request: ReviewInput,
    ctx: ExtensionContext,
    config: ReviewUiConfig,
    queueContext: QueueRunContext,
  ): Promise<ToolCallEventResult | void> {
    const preview = await this.dependencies.buildPreview(request, {
      cwd: ctx.cwd,
      maxPreviewBytes: config.maxPreviewBytes,
      signal: queueContext.signal,
      semantics: this.dependencies.resolveSemantics(request.tool),
    });
    throwIfReviewAborted(queueContext.signal);

    if (preview.path.outsideCwd) {
      return {
        block: true,
        reason:
          config.outsideCwd === "block"
            ? safeReason(`Blocked by outsideCwd=block: ${preview.path.effectivePath}`)
            : safeReason(
                `Review UI unavailable in non-interactive mode (${ctx.mode}); ` +
                  `outside-cwd confirmation required for ${preview.path.effectivePath}`,
              ),
      };
    }

    if (preview.oversized) {
      return {
        block: true,
        reason:
          `Review UI unavailable in non-interactive mode (${ctx.mode}); ` +
          "oversized-preview confirmation required",
      };
    }

    // nonInteractive=allow is an explicit opt-in for ordinary in-cwd calls.
    // Mandatory per-call outside-cwd and oversized confirmations are never
    // converted into an implicit approval.
    return;
  }

  private async processInteractive(
    request: ReviewInput,
    ctx: ExtensionContext,
    config: ReviewUiConfig,
    requestTurnIndex: number | undefined,
    queueContext: QueueRunContext,
  ): Promise<ToolCallEventResult | void> {
    const preview = await this.dependencies.buildPreview(request, {
      cwd: ctx.cwd,
      maxPreviewBytes: config.maxPreviewBytes,
      signal: queueContext.signal,
      semantics: this.dependencies.resolveSemantics(request.tool),
    });
    throwIfReviewAborted(queueContext.signal);

    if (preview.path.outsideCwd && config.outsideCwd === "block") {
      return {
        block: true,
        reason: safeReason(`Blocked by outsideCwd=block: ${preview.path.effectivePath}`),
      };
    }

    const requestStillInActiveTurn =
      requestTurnIndex !== undefined && this.currentTurnIndex === requestTurnIndex;
    const perTurnApproved =
      config.allowApproveAllForTurn &&
      requestStillInActiveTurn &&
      this.approvedTurnIndex === requestTurnIndex;

    let requestedTurnApproval = false;
    if (!perTurnApproved) {
      const decision = await this.dependencies.showReview(
        ctx,
        preview,
        config.allowApproveAllForTurn && requestStillInActiveTurn,
        queueContext,
      );
      throwIfReviewAborted(queueContext.signal);
      const decisionResult = decisionToBlock(decision);
      if (decisionResult) return decisionResult;
      requestedTurnApproval = decision === "approve-turn";
    }

    if (preview.path.outsideCwd) {
      const outsideDecision = await this.dependencies.showRisk(
        ctx,
        preview,
        "outside-cwd",
        queueContext,
      );
      throwIfReviewAborted(queueContext.signal);
      const outsideResult = riskDecisionToBlock(outsideDecision);
      if (outsideResult) return outsideResult;
    }

    if (preview.oversized) {
      const oversizedDecision = await this.dependencies.showRisk(
        ctx,
        preview,
        "oversized",
        queueContext,
      );
      throwIfReviewAborted(queueContext.signal);
      const oversizedResult = riskDecisionToBlock(oversizedDecision);
      if (oversizedResult) return oversizedResult;
    }

    if (
      requestedTurnApproval &&
      requestTurnIndex !== undefined &&
      this.currentTurnIndex === requestTurnIndex
    ) {
      // Set the state only after all mandatory path/size confirmations for the
      // current call succeed and only while the originating turn remains active.
      // Future calls still receive their own outside-cwd and oversized confirmations.
      this.approvedTurnIndex = requestTurnIndex;
    }
    throwIfReviewAborted(queueContext.signal);

    // Returning no result allows Pi's original built-in tool to execute with
    // the original argument object. This extension never writes the file.
    return;
  }

  private notifyError(ctx: ExtensionContext, message: string): void {
    if (ctx.mode !== "tui") return;
    try {
      ctx.ui.notify(message, "error");
    } catch {
      // Notification failure must not replace the deterministic block result.
    }
  }
}

function isReviewEnabled(request: ReviewInput, config: ReviewUiConfig): boolean {
  return request.tool === "edit" ? config.reviewEdit : config.reviewWrite;
}

function decisionToBlock(decision: ReviewDialogDecision): ToolCallEventResult | undefined {
  switch (decision) {
    case "approve":
    case "approve-turn":
      return undefined;
    case "reject":
      return { block: true, reason: USER_REJECTION_REASON };
    case "abort":
      return { block: true, reason: "Review aborted: dialog dismissed" };
    default:
      return { block: true, reason: "Review failed closed: invalid review dialog decision" };
  }
}

function riskDecisionToBlock(decision: RiskDialogDecision): ToolCallEventResult | undefined {
  switch (decision) {
    case "confirm":
      return undefined;
    case "reject":
      return { block: true, reason: USER_REJECTION_REASON };
    case "abort":
      return { block: true, reason: "Review aborted: warning dialog dismissed" };
    default:
      return { block: true, reason: "Review failed closed: invalid warning dialog decision" };
  }
}

function throwIfReviewAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new QueueAbortError("Review aborted");
}

function safeReason(reason: string): string {
  return renderControlCharacters(reason);
}
