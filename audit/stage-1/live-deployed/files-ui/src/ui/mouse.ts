import type { BrowserMouseEvent, MouseHandlingResult } from "../types.ts";

export type BrowserMouseHandler = (event: BrowserMouseEvent) => MouseHandlingResult;

export interface MouseAttachment {
  available: boolean;
  source: "addMouseListener" | "registerMouseHandler" | "onMouse" | "component" | "none";
  dispose(): void;
}

interface MouseCapableTui {
  addMouseListener?: (listener: (event: unknown) => unknown) => unknown;
  registerMouseHandler?: (listener: (event: unknown) => unknown) => unknown;
  onMouse?: (listener: (event: unknown) => unknown) => unknown;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function normalizeButton(value: unknown): BrowserMouseEvent["button"] {
  if (value === "left" || value === "primary" || value === 0) return "left";
  if (value === "middle" || value === "auxiliary" || value === 1) return "middle";
  if (value === "right" || value === "secondary" || value === 2) return "right";
  return undefined;
}

function normalizeButtonsBitmask(value: unknown): BrowserMouseEvent["button"] {
  if (typeof value !== "number") return undefined;
  if ((value & 1) !== 0) return "left";
  if ((value & 2) !== 0) return "right";
  if ((value & 4) !== 0) return "middle";
  return undefined;
}

/** Normalize likely first-class mouse event shapes without coupling to a private API. */
export function normalizeMouseEvent(value: unknown): BrowserMouseEvent | undefined {
  const event = record(value);
  if (!event) return undefined;
  const modifiers = record(event.modifiers);
  const rawX = numeric(event.x) ?? numeric(event.column) ?? numeric(event.col) ?? numeric(event.clientX);
  const rawY = numeric(event.y) ?? numeric(event.row) ?? numeric(event.clientY);
  if (rawX === undefined || rawY === undefined) return undefined;
  const coordinateBase = numeric(event.coordinateBase) ?? (event.oneBased === true ? 1 : 0);
  const x = Math.max(0, Math.floor(rawX - coordinateBase));
  const y = Math.max(0, Math.floor(rawY - coordinateBase));
  const type = String(event.kind ?? event.type ?? event.action ?? "").toLowerCase();
  const deltaY = numeric(event.deltaY) ?? numeric(event.wheelDeltaY) ?? numeric(event.wheelDelta);
  let kind: BrowserMouseEvent["kind"];
  let wheelDelta: number | undefined;
  if (type.includes("wheel") || deltaY !== undefined) {
    kind = "wheel";
    const direction = deltaY ?? (type.includes("up") ? -1 : 1);
    wheelDelta = direction === 0 ? 0 : direction > 0 ? 1 : -1;
  } else if (type.includes("release") || type.includes("up")) {
    kind = "release";
  } else if (type.includes("move") || type.includes("drag")) {
    kind = "move";
  } else if (type.includes("press") || type.includes("down") || type.includes("click")) {
    kind = type.includes("click") ? "release" : "press";
  } else {
    return undefined;
  }
  const normalized: BrowserMouseEvent = {
    kind,
    x,
    y,
    shift: boolean(event.shift) || boolean(event.shiftKey) || boolean(modifiers?.shift),
    alt: boolean(event.alt) || boolean(event.altKey) || boolean(modifiers?.alt),
    ctrl: boolean(event.ctrl) || boolean(event.ctrlKey) || boolean(modifiers?.ctrl),
    raw: value,
  };
  const button = event.button === undefined ? normalizeButtonsBitmask(event.buttons) : normalizeButton(event.button);
  if (button) normalized.button = button;
  else if (type.includes("click")) normalized.button = "left";
  if (wheelDelta !== undefined) normalized.wheelDelta = wheelDelta;
  return normalized;
}

/** Parse an SGR mouse sequence for unit tests and compatible host adapters. */
export function parseSgrMouse(data: string): BrowserMouseEvent | undefined {
  const match = data.match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (!match) return undefined;
  const code = Number.parseInt(match[1] ?? "", 10);
  const x = Math.max(0, Number.parseInt(match[2] ?? "1", 10) - 1);
  const y = Math.max(0, Number.parseInt(match[3] ?? "1", 10) - 1);
  const release = match[4] === "m";
  const shift = (code & 4) !== 0;
  const alt = (code & 8) !== 0;
  const ctrl = (code & 16) !== 0;
  if ((code & 64) !== 0) {
    return {
      kind: "wheel",
      x,
      y,
      shift,
      alt,
      ctrl,
      wheelDelta: (code & 1) === 0 ? -1 : 1,
      raw: data,
    };
  }
  const buttonCode = code & 3;
  const button = buttonCode === 0 ? "left" : buttonCode === 1 ? "middle" : buttonCode === 2 ? "right" : undefined;
  const kind = release ? "release" : (code & 32) !== 0 ? "move" : "press";
  const event: BrowserMouseEvent = { kind, x, y, shift, alt, ctrl, raw: data };
  if (button) event.button = button;
  return event;
}

function cleanupFromRegistration(registration: unknown, owner: MouseCapableTui, method: keyof MouseCapableTui, listener: (event: unknown) => unknown): () => void {
  if (typeof registration === "function") return registration as () => void;
  const value = record(registration);
  if (value && typeof value.dispose === "function") return () => (value.dispose as () => void)();
  if (value && typeof value.unsubscribe === "function") return () => (value.unsubscribe as () => void)();
  const removalName = method === "addMouseListener" ? "removeMouseListener" : method === "onMouse" ? "offMouse" : "unregisterMouseHandler";
  const removal = (owner as Record<string, unknown>)[removalName];
  return typeof removal === "function" ? () => (removal as (callback: (event: unknown) => unknown) => void).call(owner, listener) : () => {};
}

/**
 * Prefer a host's first-class mouse API. No raw terminal mouse mode is enabled as
 * a fallback because doing so would break Pi's application-owned preview text
 * selection. Components still expose handleMouse/handleMouseEvent for hosts that
 * dispatch mouse events directly to the focused component.
 */
export function attachFirstClassMouse(tui: MouseCapableTui, handler: BrowserMouseHandler): MouseAttachment {
  const methods = ["addMouseListener", "registerMouseHandler", "onMouse"] as const;
  for (const method of methods) {
    const register = tui[method];
    if (typeof register !== "function") continue;
    const listener = (event: unknown): unknown => {
      const normalized = normalizeMouseEvent(event);
      if (!normalized) return false;
      const raw = record(event);
      const type = String(raw?.kind ?? raw?.type ?? raw?.action ?? "").toLowerCase();
      if (type.includes("click")) {
        const pressed = handler({ ...normalized, kind: "press" });
        const released = handler({ ...normalized, kind: "release" });
        return pressed.handled || released.handled;
      }
      const result = handler(normalized);
      return result.handled;
    };
    const registration = register.call(tui, listener);
    const dispose = cleanupFromRegistration(registration, tui, method, listener);
    return { available: true, source: method, dispose };
  }
  return { available: false, source: "none", dispose: () => {} };
}
