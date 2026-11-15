// Sessions started outside Attention Span, on the item their workspace belongs to [SES-08].
import type { AgentSummary, AttentionView } from "./attention";

// The parts of a Paseo agent entry this needs.
export interface PaseoAgentEntry {
  id: string;
  labels?: Record<string, string>;
  archivedAt?: string | null;
  status: string;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  title?: string | null;
  workspaceId?: string | null;
  updatedAt?: string | null;
}

// The parts of a Paseo workspace entry this needs.
export interface PaseoWorkspaceEntry {
  id: string;
  workspaceKind: string;
  archivingAt?: string | null;
  gitRuntime?: { currentBranch?: string | null; remoteUrl?: string | null } | null;
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

// "owner/name" of a GitHub remote, https or ssh.
function repoOfRemote(url: string | null | undefined): string | null {
  return /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url ?? "")?.[1] ?? null;
}

const branchKey = (repo: string, branch: string) => `${repo.toLowerCase()}\0${branch}`;

// My merged and closed PRs by repo and branch, the latest close winning when a branch was used twice: where a session on
// a worktree finds its item once Paseo no longer links the worktree to the PR [ATT-22, SES-08].
// A branch an open PR of mine is on maps to nothing: Paseo links that PR itself, and a session there is the open PR's work.
export function closedBranches(view: Partial<Pick<AttentionView, "history" | "ownClosed" | "doing" | "waiting">>): Map<string, string> {
  const found: { key: string; repo: string; branch: string; at: string }[] = [];
  for (const item of [...(view.history ?? []), ...(view.ownClosed ?? [])]) {
    if (item.section !== "done" || !item.closedAt) continue;
    if (item.kind === "pr" && item.target.headRefName) found.push({ key: item.key, repo: item.repo, branch: item.target.headRefName, at: item.closedAt });
    for (const child of item.children) {
      if (child.headRefName) found.push({ key: child.key, repo: child.key.split("#")[0], branch: child.headRefName, at: child.mergedAt ?? item.closedAt });
    }
  }
  const open = new Set(
    [...(view.doing ?? []).flatMap((section) => section.items), ...(view.waiting ?? []).flatMap((group) => group.items)].flatMap((item) => [
      ...(item.target.headRefName ? [branchKey(item.target.repo, item.target.headRefName)] : []),
      ...(item.target.stack ?? []).flatMap((pr) => (pr.head ? [branchKey(item.target.repo, pr.head)] : [])),
    ]),
  );
  found.sort((a, b) => a.at.localeCompare(b.at));
  return new Map(found.map(({ key, repo, branch }) => [branchKey(repo, branch), key] as const).filter(([branch]) => !open.has(branch)));
}

// Unlabelled agents, keyed to the PR Paseo linked their workspace to, or else to the item of the Attention Span session
// whose worktree they share, or else to my merged or closed PR whose branch the worktree is on (`branches`, from
// closedBranches). Main and local checkouts never pass an item on, and a worktree with sessions for two items passes on
// neither.
export function linkedSessions(labelled: AgentSummary[], agents: PaseoAgentEntry[], workspaces: PaseoWorkspaceEntry[], branches = new Map<string, string>()): AgentSummary[] {
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
    const worktree = workspace.workspaceKind === "worktree";
    const shared = worktree ? items.get(workspace.id) : undefined;
    const repo = repoOfRemote(workspace.gitRuntime?.remoteUrl);
    const branch = workspace.gitRuntime?.currentBranch;
    const closed = worktree && !shared && repo && branch ? branches.get(branchKey(repo, branch)) : undefined;
    const key = linked ?? (shared?.size === 1 ? [...shared][0] : null) ?? closed ?? null;
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
