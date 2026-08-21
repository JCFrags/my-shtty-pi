import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type ReviewUiConfig } from "../src/config.js";
import {
  ReviewCoordinator,
  USER_REJECTION_REASON,
  type ReviewCoordinatorDependencies,
} from "../src/coordinator.js";
import type { ReviewDialogDecision, RiskDialogDecision } from "../src/dialog.js";
import type { ReviewInput, ReviewPreview } from "../src/preview.js";
import { ReviewQueue } from "../src/queue.js";
import { makeContext, makePreview, nextTick } from "./helpers.js";

function makeDependencies(options: {
  config?: Partial<ReviewUiConfig>;
  configError?: string;
  preview?: ReviewPreview;
  buildPreview?: ReviewCoordinatorDependencies["buildPreview"];
  reviewDecisions?: ReviewDialogDecision[];
  riskDecisions?: RiskDialogDecision[];
  reviewCalls?: ReviewPreview[];
  riskCalls?: Array<{ preview: ReviewPreview; kind: "outside-cwd" | "oversized" }>;
  showReview?: ReviewCoordinatorDependencies["showReview"];
  showRisk?: ReviewCoordinatorDependencies["showRisk"];
} = {}): ReviewCoordinatorDependencies {
  const config = { ...DEFAULT_CONFIG, ...options.config };
  const reviewDecisions = [...(options.reviewDecisions ?? ["approve"])];
  const riskDecisions = [...(options.riskDecisions ?? ["confirm"])];
  return {
    queue: new ReviewQueue(),
    async loadConfig(cwd) {
      if (options.configError) {
        return { ok: false, path: `${cwd}/.pi/review-ui.json`, error: options.configError };
      }
      return { ok: true, path: `${cwd}/.pi/review-ui.json`, config };
    },
    buildPreview:
      options.buildPreview ??
      (async () => options.preview ?? makePreview()),
    resolveSemantics: () => ({
      async constructEdit() {
        return "edited";
      },
      async constructWrite({ input }) {
        return input.content;
      },
      generateUnifiedDiff() {
        return "diff";
      },
    }),
    showReview:
      options.showReview ??
      (async (_ctx, preview) => {
        options.reviewCalls?.push(preview);
        return reviewDecisions.shift() ?? "approve";
      }),
    showRisk:
      options.showRisk ??
      (async (_ctx, preview, kind) => {
        options.riskCalls?.push({ preview, kind });
        return riskDecisions.shift() ?? "confirm";
      }),
  };
}

test("approval returns no block result and rejection returns the exact mandated reason", async () => {
  const approved = new ReviewCoordinator(makeDependencies({ reviewDecisions: ["approve"] }));
  const input = { path: "file.txt", content: "new" };
  assert.equal(await approved.handleWrite("call-a", input, makeContext()), undefined);
  assert.deepEqual(input, { path: "file.txt", content: "new" }, "tool arguments remain unchanged");

  const rejected = new ReviewCoordinator(makeDependencies({ reviewDecisions: ["reject"] }));
  assert.deepEqual(await rejected.handleWrite("call-r", input, makeContext()), {
    block: true,
    reason: USER_REJECTION_REASON,
  });
});

test("dialog abort blocks deterministically", async () => {
  const coordinator = new ReviewCoordinator(makeDependencies({ reviewDecisions: ["abort"] }));
  assert.deepEqual(
    await coordinator.handleWrite("call", { path: "file.txt", content: "new" }, makeContext()),
    { block: true, reason: "Review aborted: dialog dismissed" },
  );
});

test("unexpected dialog return values fail closed instead of approving", async () => {
  const invalidReview = new ReviewCoordinator(
    makeDependencies({
      showReview: async () => undefined as unknown as ReviewDialogDecision,
    }),
  );
  assert.deepEqual(
    await invalidReview.handleWrite("call", { path: "file.txt", content: "new" }, makeContext()),
    { block: true, reason: "Review failed closed: invalid review dialog decision" },
  );

  const base = makePreview();
  const outside = makePreview({
    path: {
      ...base.path,
      outsideCwd: true,
      effectiveOutsideCwd: true,
      effectivePath: "/outside/file.txt",
    },
  });
  const invalidRisk = new ReviewCoordinator(
    makeDependencies({
      preview: outside,
      showRisk: async () => undefined as unknown as RiskDialogDecision,
    }),
  );
  assert.deepEqual(
    await invalidRisk.handleWrite("call", { path: "../file.txt", content: "new" }, makeContext()),
    { block: true, reason: "Review failed closed: invalid warning dialog decision" },
  );
});

test("non-TUI modes block by default and allow only with explicit configuration", async () => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const blocked = new ReviewCoordinator(makeDependencies());
    const result = await blocked.handleWrite(
      "call",
      { path: "file.txt", content: "new" },
      makeContext({ mode }),
    );
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", new RegExp(`non-interactive mode \\(${mode}\\)`));

    const allowed = new ReviewCoordinator(makeDependencies({ config: { nonInteractive: "allow" } }));
    assert.equal(
      await allowed.handleWrite(
        "call",
        { path: "file.txt", content: "new" },
        makeContext({ mode }),
      ),
      undefined,
    );
  }
});

test("nonInteractive=allow still blocks calls that require unavailable mandatory confirmations", async () => {
  const base = makePreview();
  const outside = makePreview({
    path: {
      ...base.path,
      outsideCwd: true,
      effectiveOutsideCwd: true,
      effectivePath: "/outside/file.txt",
    },
  });
  const outsideCoordinator = new ReviewCoordinator(
    makeDependencies({ config: { nonInteractive: "allow" }, preview: outside }),
  );
  const outsideResult = await outsideCoordinator.handleWrite(
    "outside",
    { path: "../file.txt", content: "new" },
    makeContext({ mode: "json" }),
  );
  assert.equal(outsideResult?.block, true);
  assert.match(outsideResult?.reason ?? "", /outside-cwd confirmation required/);

  const oversizedCoordinator = new ReviewCoordinator(
    makeDependencies({ config: { nonInteractive: "allow" }, preview: makePreview({ oversized: true }) }),
  );
  const oversizedResult = await oversizedCoordinator.handleWrite(
    "oversized",
    { path: "file.txt", content: "new" },
    makeContext({ mode: "rpc" }),
  );
  assert.equal(oversizedResult?.block, true);
  assert.match(oversizedResult?.reason ?? "", /oversized-preview confirmation required/);
});

test("nonInteractive=allow still honors outsideCwd=block", async () => {
  const base = makePreview();
  const preview = makePreview({
    path: {
      ...base.path,
      outsideCwd: true,
      effectiveOutsideCwd: true,
      effectivePath: "/outside/file.txt",
    },
  });
  const coordinator = new ReviewCoordinator(
    makeDependencies({
      config: { nonInteractive: "allow", outsideCwd: "block" },
      preview,
    }),
  );
  const result = await coordinator.handleWrite(
    "outside",
    { path: "../file.txt", content: "new" },
    makeContext({ mode: "print" }),
  );
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /outsideCwd=block/);
});

test("disabled edit/write review passes the original tool through", async () => {
  let previews = 0;
  const deps = makeDependencies({
    config: { reviewEdit: false, reviewWrite: false },
    buildPreview: async () => {
      previews += 1;
      return makePreview();
    },
  });
  const coordinator = new ReviewCoordinator(deps);
  assert.equal(
    await coordinator.handleWrite("write", { path: "x", content: "x" }, makeContext()),
    undefined,
  );
  assert.equal(
    await coordinator.handleEdit(
      "edit",
      { path: "x", edits: [{ oldText: "a", newText: "b" }] },
      makeContext(),
    ),
    undefined,
  );
  assert.equal(previews, 0);
});

test("malformed configuration blocks and reports the error", async () => {
  const notifications: string[] = [];
  const ctx = makeContext({
    ui: {
      notify(message) {
        notifications.push(message);
      },
      async custom() {
        throw new Error("unused");
      },
    },
  });
  const coordinator = new ReviewCoordinator(makeDependencies({ configError: "unknown key(s): danger" }));
  const result = await coordinator.handleWrite("call", { path: "x", content: "x" }, ctx);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /configuration error.*unknown key/);
  assert.equal(notifications.length, 1);
});

test("outside-cwd targets always take the additional warning path", async () => {
  const riskCalls: Array<{ preview: ReviewPreview; kind: "outside-cwd" | "oversized" }> = [];
  const preview = makePreview({
    path: {
      ...makePreview().path,
      outsideCwd: true,
      effectiveOutsideCwd: true,
      effectivePath: "/outside/file.txt",
    },
  });
  const coordinator = new ReviewCoordinator(
    makeDependencies({ preview, reviewDecisions: ["approve"], riskDecisions: ["confirm"], riskCalls }),
  );
  assert.equal(
    await coordinator.handleWrite("call", { path: "../file.txt", content: "x" }, makeContext()),
    undefined,
  );
  assert.deepEqual(riskCalls.map((call) => call.kind), ["outside-cwd"]);
});

test("outsideCwd=block fails before an approval dialog can override it", async () => {
  const reviewCalls: ReviewPreview[] = [];
  const preview = makePreview({
    path: {
      ...makePreview().path,
      outsideCwd: true,
      effectiveOutsideCwd: true,
      effectivePath: "/outside/file.txt",
    },
  });
  const coordinator = new ReviewCoordinator(
    makeDependencies({
      config: { outsideCwd: "block" },
      preview,
      reviewDecisions: ["approve"],
      reviewCalls,
    }),
  );
  const result = await coordinator.handleWrite("call", { path: "../file.txt", content: "x" }, makeContext());
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /outsideCwd=block/);
  assert.equal(reviewCalls.length, 0);
});

test("oversized previews require a second explicit confirmation", async () => {
  const riskCalls: Array<{ preview: ReviewPreview; kind: "outside-cwd" | "oversized" }> = [];
  const preview = makePreview({ oversized: true });
  const coordinator = new ReviewCoordinator(
    makeDependencies({ preview, riskDecisions: ["reject"], riskCalls }),
  );
  const result = await coordinator.handleWrite("call", { path: "file.txt", content: "x" }, makeContext());
  assert.deepEqual(result, { block: true, reason: USER_REJECTION_REASON });
  assert.deepEqual(riskCalls.map((call) => call.kind), ["oversized"]);
});

test("outside-cwd and oversized confirmations are independent", async () => {
  const riskCalls: Array<{ preview: ReviewPreview; kind: "outside-cwd" | "oversized" }> = [];
  const base = makePreview();
  const preview = makePreview({
    oversized: true,
    path: {
      ...base.path,
      outsideCwd: true,
      effectiveOutsideCwd: true,
      effectivePath: "/outside/file.txt",
    },
  });
  const coordinator = new ReviewCoordinator(
    makeDependencies({ preview, riskDecisions: ["confirm", "confirm"], riskCalls }),
  );
  assert.equal(
    await coordinator.handleWrite("call", { path: "../file.txt", content: "x" }, makeContext()),
    undefined,
  );
  assert.deepEqual(riskCalls.map((call) => call.kind), ["outside-cwd", "oversized"]);
});

test("approve-all applies only within the active turn and resets on turn end", async () => {
  const reviewCalls: ReviewPreview[] = [];
  const deps = makeDependencies({
    config: { allowApproveAllForTurn: true },
    reviewDecisions: ["approve-turn", "approve"],
    reviewCalls,
  });
  const coordinator = new ReviewCoordinator(deps);
  coordinator.onTurnStart(7);

  assert.equal(
    await coordinator.handleWrite("one", { path: "one.txt", content: "one" }, makeContext()),
    undefined,
  );
  assert.equal(
    await coordinator.handleWrite("two", { path: "two.txt", content: "two" }, makeContext()),
    undefined,
  );
  assert.equal(reviewCalls.length, 1, "second call deliberately inherits approve-all for turn 7");

  coordinator.onTurnEnd(7);
  coordinator.onTurnStart(8);
  assert.equal(
    await coordinator.handleWrite("three", { path: "three.txt", content: "three" }, makeContext()),
    undefined,
  );
  assert.equal(reviewCalls.length, 2, "new turn requires a new decision");
});

test("approve-all cannot be installed after its originating turn has ended", async () => {
  const reviewCalls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let decisionIndex = 0;
  const deps = makeDependencies({
    config: { allowApproveAllForTurn: true },
    buildPreview: async (request: ReviewInput) => makePreview({ toolCallId: request.toolCallId }),
    showReview: async (_ctx, preview) => {
      reviewCalls.push(preview.toolCallId);
      decisionIndex += 1;
      if (decisionIndex === 1) {
        await firstGate;
        return "approve-turn";
      }
      return "approve";
    },
  });
  const coordinator = new ReviewCoordinator(deps);
  coordinator.onTurnStart(12);
  const first = coordinator.handleWrite("one", { path: "one", content: "one" }, makeContext());
  const second = coordinator.handleWrite("two", { path: "two", content: "two" }, makeContext());
  await nextTick();
  coordinator.onTurnEnd(12);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(reviewCalls, ["one", "two"]);
});

test("approve-all never suppresses per-call outside-cwd warnings", async () => {
  const reviewCalls: ReviewPreview[] = [];
  const riskCalls: Array<{ preview: ReviewPreview; kind: "outside-cwd" | "oversized" }> = [];
  const base = makePreview();
  const outside = makePreview({
    path: {
      ...base.path,
      outsideCwd: true,
      effectiveOutsideCwd: true,
      effectivePath: "/outside/file.txt",
    },
  });
  const deps = makeDependencies({
    config: { allowApproveAllForTurn: true },
    preview: outside,
    reviewDecisions: ["approve-turn"],
    riskDecisions: ["confirm", "confirm"],
    reviewCalls,
    riskCalls,
  });
  const coordinator = new ReviewCoordinator(deps);
  coordinator.onTurnStart(1);
  await coordinator.handleWrite("one", { path: "../one", content: "one" }, makeContext());
  await coordinator.handleWrite("two", { path: "../two", content: "two" }, makeContext());
  assert.equal(reviewCalls.length, 1);
  assert.deepEqual(riskCalls.map((call) => call.kind), ["outside-cwd", "outside-cwd"]);
});

test("FIFO order is based on handler arrival, not asynchronous config-load completion", async () => {
  const started: string[] = [];
  let configCall = 0;
  let releaseFirstConfig: (() => void) | undefined;
  const firstConfigGate = new Promise<void>((resolve) => {
    releaseFirstConfig = resolve;
  });
  const deps = makeDependencies({
    showReview: async (_ctx, preview) => {
      started.push(preview.toolCallId);
      return "approve";
    },
    buildPreview: async (request: ReviewInput) => makePreview({ toolCallId: request.toolCallId }),
  });
  const baseLoadConfig = deps.loadConfig;
  deps.loadConfig = async (cwd) => {
    configCall += 1;
    if (configCall === 1) await firstConfigGate;
    return baseLoadConfig(cwd);
  };

  const coordinator = new ReviewCoordinator(deps);
  const first = coordinator.handleWrite("first", { path: "first", content: "first" }, makeContext());
  const second = coordinator.handleWrite("second", { path: "second", content: "second" }, makeContext());
  await nextTick();
  assert.deepEqual(started, [], "the second call cannot overtake the first config load");
  releaseFirstConfig?.();
  await Promise.all([first, second]);
  assert.deepEqual(started, ["first", "second"]);
});

test("parallel calls retain FIFO decisions", async () => {
  const decisions: ReviewDialogDecision[] = ["approve", "reject", "approve"];
  const started: string[] = [];
  const deps = makeDependencies({
    showReview: async (_ctx, preview) => {
      started.push(preview.toolCallId);
      await nextTick();
      return decisions.shift() ?? "reject";
    },
    buildPreview: async (request: ReviewInput) => makePreview({ toolCallId: request.toolCallId }),
  });
  const coordinator = new ReviewCoordinator(deps);
  const calls = [
    coordinator.handleWrite("a", { path: "a", content: "a" }, makeContext()),
    coordinator.handleWrite("b", { path: "b", content: "b" }, makeContext()),
    coordinator.handleWrite("c", { path: "c", content: "c" }, makeContext()),
  ];
  const results = await Promise.all(calls);
  assert.deepEqual(started, ["a", "b", "c"]);
  assert.deepEqual(results, [undefined, { block: true, reason: USER_REJECTION_REASON }, undefined]);
});

test("preview and dialog exceptions fail closed while unblocking the next call", async () => {
  let buildCount = 0;
  const buildFailure = new ReviewCoordinator(
    makeDependencies({
      buildPreview: async () => {
        buildCount += 1;
        if (buildCount === 1) throw new Error("diff exploded");
        return makePreview();
      },
    }),
  );
  const first = buildFailure.handleWrite("first", { path: "a", content: "a" }, makeContext());
  const second = buildFailure.handleWrite("second", { path: "b", content: "b" }, makeContext());
  assert.match((await first)?.reason ?? "", /Review failed closed: diff exploded/);
  assert.equal(await second, undefined);

  const dialogFailure = new ReviewCoordinator(
    makeDependencies({
      showReview: async () => {
        throw new Error("overlay creation failed");
      },
    }),
  );
  const result = await dialogFailure.handleWrite("call", { path: "a", content: "a" }, makeContext());
  assert.match(result?.reason ?? "", /Review failed closed: overlay creation failed/);
});

test("session boundaries abort active and queued dialogs deterministically", async () => {
  const never = new Promise<ReviewDialogDecision>(() => {});
  const deps = makeDependencies({ showReview: async () => never });
  const coordinator = new ReviewCoordinator(deps);
  const first = coordinator.handleWrite("first", { path: "a", content: "a" }, makeContext());
  const second = coordinator.handleWrite("second", { path: "b", content: "b" }, makeContext());
  await nextTick();
  coordinator.onSessionBoundary("session shutdown (reload)");
  const results = await Promise.all([first, second]);
  for (const result of results) {
    assert.deepEqual(result, { block: true, reason: "Review aborted: session shutdown (reload)" });
  }
});

test("late async work cannot create dialogs or warnings after tool-call abort", async () => {
  let releasePreview: (() => void) | undefined;
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  let reviewCalls = 0;
  const previewAbortDependencies = makeDependencies({
    buildPreview: async () => {
      await previewGate;
      return makePreview();
    },
    showReview: async () => {
      reviewCalls += 1;
      return "approve";
    },
  });
  const previewAbortCoordinator = new ReviewCoordinator(previewAbortDependencies);
  const previewController = new AbortController();
  const previewResultPromise = previewAbortCoordinator.handleWrite(
    "preview",
    { path: "file.txt", content: "new" },
    makeContext({ signal: previewController.signal }),
  );
  await nextTick();
  previewController.abort();
  assert.deepEqual(await previewResultPromise, {
    block: true,
    reason: "Review aborted: tool call was cancelled",
  });
  releasePreview?.();
  await nextTick();
  assert.equal(reviewCalls, 0);

  let releaseDialog: (() => void) | undefined;
  const dialogGate = new Promise<void>((resolve) => {
    releaseDialog = resolve;
  });
  let riskCalls = 0;
  const base = makePreview();
  const outside = makePreview({
    path: {
      ...base.path,
      outsideCwd: true,
      effectiveOutsideCwd: true,
      effectivePath: "/outside/file.txt",
    },
  });
  const dialogAbortDependencies = makeDependencies({
    preview: outside,
    showReview: async () => {
      await dialogGate;
      return "approve";
    },
    showRisk: async () => {
      riskCalls += 1;
      return "confirm";
    },
  });
  const dialogAbortCoordinator = new ReviewCoordinator(dialogAbortDependencies);
  const dialogController = new AbortController();
  const dialogResultPromise = dialogAbortCoordinator.handleWrite(
    "dialog",
    { path: "../file.txt", content: "new" },
    makeContext({ signal: dialogController.signal }),
  );
  await nextTick();
  dialogController.abort();
  assert.deepEqual(await dialogResultPromise, {
    block: true,
    reason: "Review aborted: tool call was cancelled",
  });
  releaseDialog?.();
  await nextTick();
  assert.equal(riskCalls, 0);
});
