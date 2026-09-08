/** Retired persisted identity metadata only. Never use this for live authorization. */
export function isHistoricalActorKind(value: unknown): boolean {
  return value === "deck";
}
