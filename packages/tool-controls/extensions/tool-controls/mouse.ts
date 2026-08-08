import type { ComponentMouseEvent } from "./contracts.js";

export type MousePhase = "press" | "release" | "move" | "wheel";
export type MouseButton = "left" | "middle" | "right" | "none";

export interface NormalizedMouseEvent {
  phase: MousePhase;
  button: MouseButton;
  row: number;
  col: number;
  wheelDelta: number;
}

export interface HitRegion {
  id: string;
  role: "button" | "row" | "list";
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
  enabled: boolean;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function normalizePhase(value: unknown): MousePhase | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.toLowerCase()) {
    case "press":
    case "down":
    case "mousedown":
    case "mouse_down":
      return "press";
    case "release":
    case "up":
    case "mouseup":
    case "mouse_up":
      return "release";
    case "move":
    case "motion":
    case "drag":
    case "mousemove":
    case "mouse_move":
      return "move";
    case "wheel":
    case "scroll":
      return "wheel";
    default:
      return undefined;
  }
}

function normalizeButton(value: unknown): MouseButton | "wheel-up" | "wheel-down" | undefined {
  if (typeof value === "number") {
    if (value === 0) return "left";
    if (value === 1) return "middle";
    if (value === 2) return "right";
    if (value === 64) return "wheel-up";
    if (value === 65) return "wheel-down";
    return undefined;
  }

  if (typeof value !== "string") return undefined;
  switch (value.toLowerCase().replaceAll("_", "-")) {
    case "left":
    case "primary":
    case "button-1":
      return "left";
    case "middle":
    case "auxiliary":
    case "button-2":
      return "middle";
    case "right":
    case "secondary":
    case "button-3":
      return "right";
    case "wheel-up":
    case "wheelup":
    case "scroll-up":
      return "wheel-up";
    case "wheel-down":
    case "wheeldown":
    case "scroll-down":
      return "wheel-down";
    case "none":
      return "none";
    default:
      return undefined;
  }
}

export function normalizeMouseEvent(event: ComponentMouseEvent): NormalizedMouseEvent | undefined {
  const rawPhase = normalizePhase(event.kind) ?? normalizePhase(event.type) ?? normalizePhase(event.action);
  const rawButton = normalizeButton(event.button);
  const row = asFiniteNumber(event.localRow) ?? asFiniteNumber(event.row) ?? asFiniteNumber(event.y);
  const col =
    asFiniteNumber(event.localCol) ??
    asFiniteNumber(event.col) ??
    asFiniteNumber(event.column) ??
    asFiniteNumber(event.x);

  if (row === undefined || col === undefined) return undefined;

  let phase = rawPhase;
  let wheelDelta = asFiniteNumber(event.deltaY) ?? asFiniteNumber(event.delta) ?? 0;
  if (rawButton === "wheel-up") {
    phase = "wheel";
    wheelDelta = wheelDelta === 0 ? -1 : wheelDelta;
  } else if (rawButton === "wheel-down") {
    phase = "wheel";
    wheelDelta = wheelDelta === 0 ? 1 : wheelDelta;
  }

  if (phase === "wheel" && wheelDelta === 0 && typeof event.direction === "string") {
    wheelDelta = event.direction.toLowerCase() === "up" ? -1 : 1;
  }
  if (phase === undefined) return undefined;

  const button: MouseButton =
    rawButton === "wheel-up" || rawButton === "wheel-down" || rawButton === undefined
      ? "none"
      : rawButton;

  return {
    phase,
    button,
    row: Math.max(0, Math.trunc(row)),
    col: Math.max(0, Math.trunc(col)),
    wheelDelta,
  };
}

export function containsPoint(region: HitRegion, row: number, col: number): boolean {
  return (
    row >= region.rowStart &&
    row < region.rowEnd &&
    col >= region.colStart &&
    col < region.colEnd
  );
}

export function findHitRegion(
  regions: readonly HitRegion[],
  row: number,
  col: number,
  includeDisabled = false,
): HitRegion | undefined {
  return regions.find(
    (region) => (includeDisabled || region.enabled) && containsPoint(region, row, col),
  );
}

/** Implements click semantics: same-button press/release, same region, no motion. */
export class PressReleaseTracker {
  private armedRegionId: string | undefined;
  private dragged = false;

  get pressedRegionId(): string | undefined {
    return this.armedRegionId;
  }

  press(event: NormalizedMouseEvent, regions: readonly HitRegion[]): boolean {
    if (event.phase !== "press") return false;
    if (event.button !== "left") {
      this.reset();
      return false;
    }
    const region = findHitRegion(regions, event.row, event.col);
    this.armedRegionId = region?.id;
    this.dragged = false;
    return region !== undefined;
  }

  move(event: NormalizedMouseEvent): boolean {
    if (event.phase !== "move" || this.armedRegionId === undefined) return false;
    this.dragged = true;
    return true;
  }

  release(event: NormalizedMouseEvent, regions: readonly HitRegion[]): string | undefined {
    if (event.phase !== "release") return undefined;
    if (event.button !== "left") {
      this.reset();
      return undefined;
    }
    const armed = this.armedRegionId;
    const dragged = this.dragged;
    this.reset();
    if (armed === undefined || dragged) return undefined;
    const released = findHitRegion(regions, event.row, event.col);
    return released?.id === armed ? armed : undefined;
  }

  reset(): void {
    this.armedRegionId = undefined;
    this.dragged = false;
  }
}
