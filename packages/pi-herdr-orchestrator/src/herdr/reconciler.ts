import type { HerdrSnapshot } from "./types.js";
import type { Agent, OrchestrationState } from "../state/types.js";
import { piSessionMatches } from "./controls.js";

export type ReconciliationKind =
  "present" | "moved" | "missing" | "replaced" | "orphaned" | "unknown";

export interface Reconciliation {
  agentId: string;
  kind: ReconciliationKind;
  paneId?: string;
  terminalId?: string;
  worktreeId?: string;
  worktreePath?: string;
  workspaceId?: string;
  reason?: string;
}

type HerdrResources = NonNullable<OrchestrationState["herdrResources"]>;

export function reconcileAgents(
  agents: readonly Agent[],
  snapshot: HerdrSnapshot,
  resources: Readonly<HerdrResources> = {},
): Reconciliation[] {
  const panes = new Map(snapshot.panes.map((pane) => [pane.id, pane]));
  const out: Reconciliation[] = [];
  for (const agent of agents) {
    const resource = resources[agent.id];
    if (resource?.state === "closed") continue;
    const recordedPaneId = resource?.paneId ?? agent.paneId;
    const recordedTerminalId = resource?.terminalId ?? agent.terminalId;
    const recordedSessionId = resource?.sessionId ?? agent.piSessionId;
    const recordedGeneration = resource?.generation;
    let pane = recordedPaneId ? panes.get(recordedPaneId) : undefined;
    if (!pane && recordedTerminalId)
      pane = snapshot.panes.find(
        (candidate) =>
          (candidate.occupant?.terminalId ?? candidate.terminalId) ===
          recordedTerminalId,
      );
    if (!pane) {
      out.push({
        agentId: agent.id,
        kind: "missing",
        reason: "Recorded pane is absent.",
      });
      continue;
    }
    const livePaneAgents = snapshot.agents.filter(
      (candidate) => candidate.paneId === pane.id,
    );
    if (livePaneAgents.length > 1) {
      out.push({
        agentId: agent.id,
        kind: "replaced",
        paneId: pane.id,
        reason: "Managed pane occupant identity is ambiguous.",
      });
      continue;
    }
    const paneOccupants = livePaneAgents.filter((candidate) => {
      const canonicalAgentId = candidate.agentId ?? candidate.id;
      return canonicalAgentId === undefined || canonicalAgentId === agent.id;
    });
    const sessionOccupants = recordedSessionId
      ? snapshot.agents.filter((candidate) =>
          piSessionMatches(
            recordedSessionId,
            candidate.sessionId,
            candidate.sessionReference,
          ),
        )
      : [];
    const modernOccupants = recordedSessionId
      ? paneOccupants.filter((candidate) =>
          piSessionMatches(
            recordedSessionId,
            candidate.sessionId,
            candidate.sessionReference,
          ),
        )
      : paneOccupants.filter(
          (candidate) =>
            recordedTerminalId === undefined ||
            candidate.terminalId === recordedTerminalId,
        );
    const occupant =
      snapshot.agents.length > 0
        ? modernOccupants.length === 1
          ? modernOccupants[0]
          : undefined
        : pane.occupant;
    if (!occupant) {
      out.push({
        agentId: agent.id,
        kind: "orphaned",
        paneId: pane.id,
        reason: "Managed pane has no verified occupant.",
      });
      continue;
    }
    const canonicalAgentId = occupant.agentId ?? occupant.id;
    const canonicalOmissionUnproven =
      canonicalAgentId === undefined &&
      (recordedSessionId === undefined ||
        sessionOccupants.length !== 1 ||
        sessionOccupants[0] !== occupant);
    const generationMismatch =
      recordedGeneration !== undefined &&
      (occupant.generation !== undefined
        ? occupant.generation !== recordedGeneration
        : snapshot.agents.length === 0);
    if (
      (canonicalAgentId !== undefined && canonicalAgentId !== agent.id) ||
      canonicalOmissionUnproven ||
      generationMismatch
    ) {
      out.push({
        agentId: agent.id,
        kind: "replaced",
        paneId: pane.id,
        reason: "Managed pane occupant identity changed.",
      });
      continue;
    }
    const terminalId = occupant.terminalId ?? pane.terminalId;
    const durableSessionMatches =
      recordedSessionId !== undefined &&
      sessionOccupants.length === 1 &&
      sessionOccupants[0] === occupant;
    const terminalChanged = Boolean(
      recordedTerminalId && terminalId && recordedTerminalId !== terminalId,
    );
    if (terminalChanged && !durableSessionMatches) {
      out.push({
        agentId: agent.id,
        kind: "replaced",
        paneId: pane.id,
        ...(terminalId ? { terminalId } : {}),
        reason: "Terminal occupant changed.",
      });
      continue;
    }

    const hasWorktreeIdentity = Boolean(
      resource?.worktreeId || resource?.worktreePath || resource?.workspaceId,
    );
    let worktreeIdentity:
      | { worktreeId: string; worktreePath: string; workspaceId: string }
      | undefined;
    if (hasWorktreeIdentity) {
      if (
        !resource?.worktreeId ||
        !resource.worktreePath ||
        !resource.workspaceId
      ) {
        out.push({
          agentId: agent.id,
          kind: "replaced",
          paneId: pane.id,
          ...(terminalId ? { terminalId } : {}),
          reason: "Recorded worktree identity is incomplete.",
        });
        continue;
      }
      const liveMatches = snapshot.worktrees.filter(
        (worktree) => worktree.id === resource.worktreeId,
      );
      if (liveMatches.length === 0) {
        out.push({
          agentId: agent.id,
          kind: "missing",
          paneId: pane.id,
          ...(terminalId ? { terminalId } : {}),
          reason: "Recorded worktree is absent.",
        });
        continue;
      }
      if (liveMatches.length !== 1) {
        out.push({
          agentId: agent.id,
          kind: "replaced",
          paneId: pane.id,
          ...(terminalId ? { terminalId } : {}),
          reason: "Recorded worktree identity is ambiguous.",
        });
        continue;
      }
      const live = liveMatches[0]!;
      if (
        live.path !== resource.worktreePath ||
        live.workspaceId !== resource.workspaceId
      ) {
        out.push({
          agentId: agent.id,
          kind: "replaced",
          paneId: pane.id,
          ...(terminalId ? { terminalId } : {}),
          reason: "Recorded worktree identity changed.",
        });
        continue;
      }
      worktreeIdentity = {
        worktreeId: resource.worktreeId,
        worktreePath: live.path,
        workspaceId: resource.workspaceId,
      };
    }

    out.push({
      agentId: agent.id,
      kind: recordedPaneId !== pane.id || terminalChanged ? "moved" : "present",
      paneId: pane.id,
      ...(terminalId ? { terminalId } : {}),
      ...worktreeIdentity,
    });
  }
  return out;
}
