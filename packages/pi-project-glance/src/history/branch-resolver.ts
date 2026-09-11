import { createHash, randomUUID } from "node:crypto";

export interface SourceNode {
  id: string;
  parentId: string | null;
  ordinal: number;
}

export function opaqueItemId(sessionKey: string, sourceEntryId: string, sourceKind: string): string {
  return `item-${createHash("sha256").update(sessionKey).update("\0").update(sourceEntryId).update("\0").update(sourceKind).digest("hex")}`;
}

export function newBranchId(): string {
  return `branch-${randomUUID()}`;
}

export function pathToLeaf(nodes: readonly SourceNode[], leafId: string | null): string[] {
  if (leafId === null) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const reversed: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(leafId);
  while (current) {
    if (seen.has(current.id)) throw new Error("GLANCE_HISTORY_SOURCE_CYCLE");
    seen.add(current.id);
    reversed.push(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return reversed.reverse();
}

export function allLeafPaths(nodes: readonly SourceNode[]): Array<{ leafId: string; path: string[] }> {
  const parentIds = new Set(nodes.flatMap((node) => node.parentId === null ? [] : [node.parentId]));
  return nodes
    .filter((node) => !parentIds.has(node.id))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((node) => ({ leafId: node.id, path: pathToLeaf(nodes, node.id) }));
}
