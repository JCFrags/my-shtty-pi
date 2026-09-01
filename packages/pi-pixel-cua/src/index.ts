import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PortalHelperClient } from "./helper-client.ts";

interface CaptureResult {
  stateId: string;
  streamIdentity: string;
  geometryFingerprint: string;
  logicalSize: [number, number];
  captureSize: [number, number];
  imageSize: [number, number];
  fullFrameSha256: string;
  capturedAt: number;
  mimeType: string;
  imageBase64: string;
  pipeWireSampleStatus?: "new-sample" | "no-new-sample";
  frameBytesStatus?: "initial-captured-bytes" | "changed-bytes" | "reused-identical-bytes";
  reusedFromStateId?: string | null;
  refreshAttempted?: boolean;
  refreshSampleAvailable?: boolean;
  visualSuccessorProof?: "new-bytes" | "reused-bytes";
  delivery?: Record<string, unknown>;
  preActionDiff?: Record<string, unknown>;
  postActionDiff?: Record<string, unknown>;
  inputsReleased?: boolean;
}

const helper = new PortalHelperClient();
const helperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "helper", "server.py");
const states = new Map<string, Pick<CaptureResult, "imageSize" | "streamIdentity" | "geometryFingerprint">>();
let active = false;

function showActiveFeedback(ctx: ExtensionContext): void {
  ctx.ui.setStatus("pixel-cua-portal", ctx.ui.theme.fg("warning", "● CUA ACTIVE"));
  ctx.ui.setWidget("pixel-cua-active", [
    "● PIXEL CUA ACTIVE — one portal-selected window",
    "System cursor is embedded in screenshots. GNOME does not permit a package-drawn window border.",
    "Emergency stop: Ctrl+Shift+F12 or /pixel-cua-stop",
  ]);
}

function clearActiveFeedback(ctx: ExtensionContext): void {
  ctx.ui.setStatus("pixel-cua-portal", undefined);
  ctx.ui.setWidget("pixel-cua-active", undefined);
}

function withoutImage(result: CaptureResult) {
  const { imageBase64: _omitted, ...metadata } = result;
  return metadata;
}

function remember(result: CaptureResult): void {
  states.clear();
  states.set(result.stateId, {
    imageSize: result.imageSize,
    streamIdentity: result.streamIdentity,
    geometryFingerprint: result.geometryFingerprint,
  });
}

function imageResult(result: CaptureResult, prefix: string) {
  remember(result);
  return {
    content: [
      {
        type: "text" as const,
        text:
          `${prefix} state=${result.stateId} stream=${result.streamIdentity} ` +
          `logical=${result.logicalSize.join("x")} capture=${result.captureSize.join("x")} ` +
          `modelImage=${result.imageSize.join("x")} frameSha256=${result.fullFrameSha256} ` +
          `sample=${result.pipeWireSampleStatus ?? "unspecified"} bytes=${result.frameBytesStatus ?? "unspecified"} ` +
          `refresh=${String(result.refreshAttempted ?? false)}/${String(result.refreshSampleAvailable ?? false)} ` +
          `successorBytes=${result.visualSuccessorProof ?? "unspecified"}. ` +
          "Coordinates refer only to this image and state.",
      },
      { type: "image" as const, data: result.imageBase64, mimeType: result.mimeType },
    ],
    details: withoutImage(result),
  };
}

async function ensureHelper(): Promise<void> {
  await helper.ensureStarted(helperPath);
}

export default function pixelCuaPortal(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cua_portal_start",
    label: "Pixel CUA Start",
    description:
      "Start one new non-persistent GNOME Wayland portal session. The user must select exactly one window and separately allow pointer and keyboard interaction in the visible portal dialog. This tool captures no pixels.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error("Pixel CUA requires an interactive Pi consent UI");
      const confirmed = await ctx.ui.confirm(
        "Start Pixel CUA portal session?",
        "One user-selected WINDOW only. Pointer + keyboard requested. Non-persistent grant. Pointer moves do not repeat this Pi prompt; clicks and keyboard actions do. Pixels stay in memory, except screenshots returned to this Pi session. The system cursor is embedded in screenshots. GNOME does not expose an active-window border overlay through this portal. Emergency stop: Ctrl+Shift+F12 or /pixel-cua-stop. Continue to the GNOME portal?",
        { timeout: 120_000 },
      );
      if (!confirmed) throw new Error("Pixel CUA start was not approved");
      await ensureHelper();
      onUpdate?.({ content: [{ type: "text", text: "Waiting for the visible GNOME portal decision…" }] });
      const abort = () => { void helper.stop().catch(() => undefined); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await helper.request<Record<string, unknown>>(
          "start",
          { consentTimeoutSeconds: 900 },
          signal,
          950_000,
        );
        active = true;
        states.clear();
        showActiveFeedback(ctx);
        ctx.ui.notify("Pixel CUA is active for one portal-selected window", "warning");
        return {
          content: [{
            type: "text",
            text:
              `Portal session active. stream=${String(result.streamIdentity)}; source=one window; ` +
              "devices=pointer+keyboard; persistent=false; cursor=embedded; windowBorderOverlay=unavailable; helper screenshot files=none. Call cua_portal_observe before any action.",
          }],
          details: result,
        };
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  });

  pi.registerTool({
    name: "cua_portal_observe",
    label: "Pixel CUA Observe",
    description:
      "Capture current pixels from the exact selected portal stream. Return one bounded PNG and immutable state metadata. It exposes no window list, OCR, DOM, accessibility, or semantic data.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, onUpdate) {
      if (!active) throw new Error("Start a Pixel CUA portal session first");
      await ensureHelper();
      onUpdate?.({ content: [{ type: "text", text: "Capturing selected-stream pixels…" }] });
      const result = await helper.request<CaptureResult>("capture", { maxDimension: 1024 }, signal, 15_000);
      return imageResult(result, "Selected-stream screenshot.");
    },
  });

  pi.registerTool({
    name: "cua_portal_act",
    label: "Pixel CUA Act",
    description:
      "Perform one bounded visible action against the exact newest selected-stream state. Pointer moves use the active portal consent without another Pi prompt. Clicks and keyboard actions require explicit Pi confirmation. Dynamic changes outside the guarded target region are rebased safely; changed geometry or target pixels are rejected.",
    parameters: Type.Object({
      stateId: Type.String({ description: "Exact newest state from observe or the prior action" }),
      intent: Type.String({ minLength: 1, maxLength: 200, description: "Plain statement of the one harmless intended action" }),
      action: Type.Object({
        type: StringEnum(["move", "click", "type", "key"] as const),
        x: Type.Optional(Type.Number({ minimum: 0, description: "X in the returned model image" })),
        y: Type.Optional(Type.Number({ minimum: 0, description: "Y in the returned model image" })),
        button: Type.Optional(StringEnum(["left", "middle", "right"] as const)),
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Printable ASCII only; not retained in helper logs" })),
        key: Type.Optional(StringEnum(["enter", "escape", "tab", "backspace", "space"] as const)),
      }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!active) throw new Error("Start a Pixel CUA portal session first");
      if (!ctx.hasUI) throw new Error("Pixel CUA actions require an interactive Pi UI");
      const state = states.get(params.stateId);
      if (!state) throw new Error("Unknown or superseded state. Observe again.");
      const action = { ...params.action, imageSize: state.imageSize };
      const actionSummary = params.action.type === "type"
        ? `type ${params.action.text?.length ?? 0} printable character(s)`
        : params.action.type === "key"
          ? `press and release ${params.action.key}`
          : `${params.action.type} at (${params.action.x}, ${params.action.y})`;
      if (params.action.type !== "move") {
        const confirmed = await ctx.ui.confirm(
          "Allow one Pixel CUA action?",
          `Intent: ${params.intent}\nAction: ${actionSummary}\nStream: ${state.streamIdentity}\nState: ${params.stateId}\nThe action is visible and limited to the selected portal stream.`,
          { timeout: 60_000 },
        );
        if (!confirmed) throw new Error("Pixel CUA action was not approved");
      }
      onUpdate?.({ content: [{ type: "text", text: "Checking fresh pixels, then sending one portal action…" }] });
      const abort = () => { void helper.stop().catch(() => undefined); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await helper.request<CaptureResult>(
          "act",
          { stateId: params.stateId, action, maxDimension: 1024 },
          signal,
          20_000,
        );
        return imageResult(result, `Action delivered (${String(result.delivery?.kind ?? params.action.type)}); inputsReleased=${String(result.inputsReleased)}.`);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  });

  pi.registerTool({
    name: "cua_portal_stop",
    label: "Pixel CUA Stop",
    description:
      "Emergency-stop Pixel CUA. Release tracked input, close PipeWire and the exact portal session, discard helper pixels, and require a new visible grant for later use.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const result = await helper.stop();
      active = false;
      states.clear();
      clearActiveFeedback(ctx);
      return { content: [{ type: "text", text: "Pixel CUA stopped. Input released, selected stream closed, helper pixels discarded, and the grant cannot resume." }], details: result };
    },
  });

  pi.registerCommand("pixel-cua-stop", {
    description: "Emergency-stop the active Pixel CUA portal session",
    handler: async (_args, ctx) => {
      try { await helper.stop(); } finally {
        active = false;
        states.clear();
        clearActiveFeedback(ctx);
      }
      ctx.ui.notify("Pixel CUA stopped and cleaned up", "info");
    },
  });

  pi.registerCommand("pixel-cua-status", {
    description: "Show local Pixel CUA helper and capability state",
    handler: async (_args, ctx) => {
      ctx.ui.notify(JSON.stringify({ active, states: states.size, helper: helper.status() }), "info");
    },
  });

  pi.registerShortcut("ctrl+shift+f12", {
    description: "Emergency-stop Pixel CUA",
    handler: async (ctx) => {
      try { await helper.stop(); } finally {
        active = false;
        states.clear();
        clearActiveFeedback(ctx);
      }
      ctx.ui.notify("Pixel CUA emergency stop complete", "warning");
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    active = false;
    states.clear();
    clearActiveFeedback(ctx);
    await helper.shutdown();
  });
}
