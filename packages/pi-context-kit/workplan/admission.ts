import { cancelled, StateToolError } from "@grounded/pi-core/state";
import { WORKPLAN_LIMITS } from "@grounded/pi-core/workplan";

export const PLAN_BYTES = WORKPLAN_LIMITS.canonicalPlanBytes;
export const PLAN_OBJECT_BYTES = PLAN_BYTES + 512;
export const ROOT_BYTES = 1024 * 1024;
export const PROJECTION_BYTES = 64 * 1024;
export const LEGACY_PAGE_BYTES = PLAN_BYTES + 1024 * 1024;

/** Admit Workplan JSON before the native reducer's unrestricted JSON traversal.
 * This is a selected-object bound, not a constant-cost operation. Descriptor
 * checks reject getters and sparse arrays without invoking user code.
 */
export function admitWorkplanJson(value: unknown, maxBytes = PLAN_BYTES, maxNodes = 32_000_000): number {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const limit = (): never => { throw new StateToolError("STATE_LIMIT_EXCEEDED", "Workplan operation exceeds its admitted JSON budget"); };
  const invalid = (): never => { throw new StateToolError("STATE_CORRUPT", "Workplan operation is not plain JSON"); };
  const count = (amount: number) => { bytes += amount; if (bytes > maxBytes) limit(); };
  const text = (item: string) => {
    if (item.length > maxBytes - bytes) limit();
    count(2);
    // Count escaped JSON in bounded chunks. Do not split a surrogate pair.
    for (let from = 0; from < item.length;) {
      let to = Math.min(item.length, from + 16 * 1024);
      if (to < item.length && /[\uD800-\uDBFF]/u.test(item[to - 1]!)) to--;
      count(Buffer.byteLength(JSON.stringify(item.slice(from, to)), "utf8") - 2);
      from = to;
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > maxNodes || depth > 32) limit();
    if (item === null) { count(4); return; }
    if (typeof item === "string") { text(item); return; }
    if (typeof item === "boolean") { count(item ? 4 : 5); return; }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) invalid();
      count(JSON.stringify(item).length); return;
    }
    if (typeof item !== "object" || ancestors.has(item)) throw invalid();
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) invalid();
    ancestors.add(item); count(2);
    if (Array.isArray(item)) {
      if (item.length > maxNodes - nodes || item.length > maxBytes - bytes) limit();
      for (let index = 0; index < item.length; index++) {
        if (index) count(1);
        const property = Object.getOwnPropertyDescriptor(item, String(index));
        if (!property || !("value" in property)) throw invalid();
        visit(property.value, depth + 1);
      }
    } else {
      let index = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) invalid();
        if (index++) count(1);
        text(key); count(1);
        const property = Object.getOwnPropertyDescriptor(item, key)!;
        if (!("value" in property)) invalid();
        visit(property.value, depth + 1);
      }
      if (Object.getOwnPropertySymbols(item).length) invalid();
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return bytes;
}

/** Yield between admitted CPU phases and asynchronous object I/O. */
export async function planBoundary(signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  cancelled(signal);
}

export function boundedText(value: string, bytes: number): { text: string; omitted: boolean } {
  let text = "", used = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point, "utf8");
    if (used + size > bytes) return { text, omitted: true };
    text += point; used += size;
  }
  return { text, omitted: false };
}
