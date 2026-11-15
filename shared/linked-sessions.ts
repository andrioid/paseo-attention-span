// Sessions started outside Attention Span, on the item their workspace belongs to [SES-08].
import type { AgentSummary } from "./attention";

// The parts of a Paseo agent entry this needs.
export interface PaseoAgentEntry {
  id: string;
  labels?: Record<string, string>;
  archivedAt?: string | null;
  status: string;
  requiresAttention?: boolean;
  title?: string | null;
  workspaceId?: string | null;
  updatedAt?: string | null;
}

// The parts of a Paseo workspace entry this needs.
export interface PaseoWorkspaceEntry {
  id: string;
  workspaceKind: string;
  archivingAt?: string | null;
  githubRuntime?: { pullRequest?: { url: string; number?: number } | null } | null;
}

// Agents another agent started belong to that agent's session, not to the item.
export const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

// The unarchived sub-agents under these sessions, and theirs in turn: part of their session, so archived with it and never
// "another session" in its worktree [ATT-22]. An archived one in between is walked through, where the list has it, so an
// open sub-agent below it is still found. Deepest last.
export function subAgentsOf<A extends Pick<PaseoAgentEntry, "id" | "labels" | "archivedAt">>(agents: A[], sessionIds: string[]): A[] {
  const found: A[] = [];
  const seen = new Set(sessionIds);
  for (let parents = [...seen]; parents.length; ) {
    const children = agents.filter((agent) => !seen.has(agent.id) && parents.includes(agent.labels?.[PARENT_AGENT_LABEL] ?? ""));
    for (const child of children) seen.add(child.id);
    found.push(...children);
    parents = children.map((child) => child.id);
  }
  return found.filter((agent) => !agent.archivedAt);
}

// "owner/name#number" for a GitHub pull request URL.
export function pullRequestKey(url: string): string | null {
  const match = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url);
  return match ? `${match[1]}#${match[2]}` : null;
}

// Unlabelled agents, keyed to the PR Paseo linked their workspace to, or else to the item of the
// Attention Span session whose worktree they share. Main and local checkouts never pass an item on,
// and a worktree with sessions for two items passes on neither.
export function linkedSessions(labelled: AgentSummary[], agents: PaseoAgentEntry[], workspaces: PaseoWorkspaceEntry[]): AgentSummary[] {
  const known = new Set(labelled.map((agent) => agent.id));
  const items = new Map<string, Set<string>>();
  for (const agent of labelled) {
    if (!agent.workspaceId) continue;
    const keys = items.get(agent.workspaceId) ?? new Set<string>();
    keys.add(agent.itemKey.toLowerCase());
    items.set(agent.workspaceId, keys);
  }
  const itemOf = new Map<string, string>();
  for (const workspace of workspaces) {
    if (workspace.archivingAt) continue;
    const pr = workspace.githubRuntime?.pullRequest;
    const linked = pr ? pullRequestKey(pr.url) : null;
    const shared = workspace.workspaceKind === "worktree" ? items.get(workspace.id) : undefined;
    const key = linked ?? (shared?.size === 1 ? [...shared][0] : null);
    if (key) itemOf.set(workspace.id, key);
  }
  return agents.flatMap((agent) => {
    const itemKey = agent.workspaceId ? itemOf.get(agent.workspaceId) : undefined;
    if (!itemKey || known.has(agent.id) || agent.archivedAt || agent.labels?.[PARENT_AGENT_LABEL]) return [];
    return [
      {
        id: agent.id,
        itemKey,
        status: agent.status,
        requiresAttention: !!agent.requiresAttention,
        title: agent.title ?? null,
        workspaceId: agent.workspaceId ?? null,
        lastActivityAt: agent.updatedAt ?? null,
      },
    ];
  });
}
