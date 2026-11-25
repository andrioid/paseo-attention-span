import { type AgentSummary, type SessionWorkspace, subAgentBusy } from "./attention";
import { SessionKind } from "./config";
import { linkedSessions, type PaseoAgentEntry, type PaseoWorkspaceEntry, subAgentsOf } from "./linked-sessions";

// The sessions on items, as the screen and the sidebar's count see them, from Paseo's lists [SES-03, SES-08, ATT-22].
// Pure, so the rules test in node; the client fetches every page and hands them over.

// Labels tie an agent to the item it works on [ATT-07, SES-03].
export const LABEL = "attention-span";
export const ITEM_LABEL = "attention-span-item";
// The action it was started for, so the sheet shows it in that action's line.
export const KIND_LABEL = "attention-span-kind";
// Sessions started under the plugin's earlier names, "GitHub attention" and "GitHub inbox", count too.
export const SESSION_LABELS = [LABEL, "github-attention", "github-inbox"];

// A workspace as Paseo lists it, as far as Wrap up reads it.
export type SessionWorkspaceEntry = PaseoWorkspaceEntry & {
  workspaceKind: SessionWorkspace["kind"];
  title?: string | null;
  name: string;
  workspaceDirectory?: string | null;
  projectRootPath?: string | null;
  gitRuntime?: { currentBranch?: string | null; remoteUrl?: string | null; isDirty?: boolean | null; aheadOfOrigin?: number | null } | null;
};

// What Paseo knows about the workspace a session runs in, for Wrap up's unsaved-work check [ATT-22].
function sessionWorkspace(workspace: SessionWorkspaceEntry): SessionWorkspace {
  const git = workspace.gitRuntime;
  const directory = workspace.workspaceDirectory ?? workspace.projectRootPath;
  return {
    kind: workspace.workspaceKind,
    name: workspace.title ?? workspace.name,
    ...(directory ? { directory } : {}),
    ...(git?.currentBranch ? { branch: git.currentBranch } : {}),
    ...(typeof git?.isDirty === "boolean" ? { dirty: git.isDirty } : {}),
    ...(typeof git?.aheadOfOrigin === "number" ? { ahead: git.aheadOfOrigin } : {}),
  };
}

// Agents started from Attention Span (labelled by SESSION_LABELS), each with the item it was started on, and the agents
// started outside it in a workspace that belongs to an item, all from one list of Paseo's agents. Each with its workspace,
// and the sub-agents that go with it: one still busy keeps its Wrap up row out [SES-08, ATT-22]. `branches` are closedBranches.
export function sessionsFrom(
  all: PaseoAgentEntry[],
  workspaces: SessionWorkspaceEntry[],
  branches = new Map<string, string>(),
): AgentSummary[] {
  const labelled = (agent: PaseoAgentEntry) => SESSION_LABELS.some((label) => agent.labels?.[label]);
  const byId = new Map<string, AgentSummary>();
  for (const agent of all.filter(labelled)) {
    const itemKey = SESSION_LABELS.map((label) => agent.labels?.[`${label}-item`]).find(Boolean);
    if (!itemKey || agent.archivedAt) continue;
    byId.set(agent.id, {
      id: agent.id,
      itemKey,
      kind: SessionKind.safeParse(agent.labels?.[KIND_LABEL]).data,
      status: agent.status,
      requiresAttention: !!agent.requiresAttention,
      title: agent.title ?? null,
      workspaceId: agent.workspaceId ?? null,
      lastActivityAt: agent.updatedAt ?? null,
    });
  }
  const started = [...byId.values()];
  const unlabelled = all.filter((agent) => !labelled(agent));
  const byWorkspace = new Map(workspaces.map((workspace) => [workspace.id, sessionWorkspace(workspace)]));
  return [...started, ...linkedSessions(started, unlabelled, workspaces, branches)].map((agent) => {
    const workspace = agent.workspaceId ? byWorkspace.get(agent.workspaceId) : undefined;
    const subAgents = subAgentsOf(all, [agent.id]);
    return {
      ...agent,
      ...(workspace ? { workspace } : {}),
      ...(subAgents.length ? { subAgents: { count: subAgents.length, working: subAgents.some(subAgentBusy) } } : {}),
    };
  });
}
