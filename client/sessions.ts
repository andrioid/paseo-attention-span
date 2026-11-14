import type { usePaseo } from "@getpaseo/plugin/client";
import { type AgentSummary, checkoutPr, type SessionWorkspace, sessionTitle, type Target } from "../shared/attention";
import { linkedSessions } from "../shared/linked-sessions";
import { chooseAgent, type ReadyProvider } from "../shared/providers";
import { type AttentionConfig, codeRepoFor, githubRepoOf, SessionKind } from "../shared/config";

type Paseo = ReturnType<typeof usePaseo>;

// The app's session list, shared by the screen and the sidebar's count [ATT-09, ATT-22].
export const AGENTS_QUERY_KEY = ["attention-span", "agents"] as const;

// Labels tie an agent to the item it works on [ATT-07, SES-03].
export const LABEL = "attention-span";
export const ITEM_LABEL = "attention-span-item";
// The action it was started for, so the sheet shows it in that action's line.
export const KIND_LABEL = "attention-span-kind";
// Sessions started under the plugin's earlier names, "GitHub attention" and "GitHub inbox".
const OLD_LABELS = ["github-attention", "github-inbox"];

// What Paseo knows about the workspace a session runs in, for Wrap up's unsaved-work check [ATT-22].
function sessionWorkspace(workspace: (Awaited<ReturnType<Paseo["workspaces"]["list"]>>["entries"][number])): SessionWorkspace {
  const git = workspace.gitRuntime;
  return {
    kind: workspace.workspaceKind,
    name: workspace.title ?? workspace.name,
    directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
    ...(git?.currentBranch ? { branch: git.currentBranch } : {}),
    ...(typeof git?.isDirty === "boolean" ? { dirty: git.isDirty } : {}),
    ...(typeof git?.aheadOfOrigin === "number" ? { ahead: git.aheadOfOrigin } : {}),
    ownedWorktree: workspace.workspaceKind === "worktree",
  };
}

// Agents started from Attention Span, each with the item it was started on, and the agents
// started outside it in a workspace that belongs to an item [SES-08].
export async function itemAgents(paseo: Paseo): Promise<AgentSummary[]> {
  const labels = [LABEL, ...OLD_LABELS];
  const [lists, all, workspaces] = await Promise.all([
    Promise.all(labels.map((label) => paseo.agents.list({ filter: { labels: { [label]: "1" } } }))),
    paseo.agents.list(),
    paseo.workspaces.list(),
  ]);
  const byId = new Map<string, AgentSummary>();
  for (const { agent } of lists.flatMap((list) => list.entries)) {
    const itemKey = labels.map((label) => agent.labels?.[`${label}-item`]).find(Boolean);
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
  const labelled = [...byId.values()];
  const unlabelled = all.entries.map((entry) => entry.agent).filter((agent) => !labels.some((label) => agent.labels?.[label]));
  const byWorkspace = new Map(workspaces.entries.map((workspace) => [workspace.id, sessionWorkspace(workspace)]));
  return [...labelled, ...linkedSessions(labelled, unlabelled, workspaces.entries)].map((agent) => {
    const workspace = agent.workspaceId ? byWorkspace.get(agent.workspaceId) : undefined;
    return workspace ? { ...agent, workspace } : agent;
  });
}

export interface ProjectMatch {
  projectId: string;
  rootPath: string;
}

export interface GitHubProject extends ProjectMatch {
  repo: string;
}

// Registered Paseo projects with a GitHub remote, by "owner/name".
export async function githubProjects(paseo: Paseo): Promise<GitHubProject[]> {
  const { projects } = await paseo.projects.list();
  return projects.flatMap((project) => {
    const repo = githubRepoOf(project.projectKey);
    return repo ? [{ repo, projectId: project.projectId, rootPath: project.projectRootPath }] : [];
  });
}

// The local checkout is the registered Paseo project with the repo's GitHub remote [SES-05].
export async function findProject(paseo: Paseo, repo: string): Promise<ProjectMatch | null> {
  return (await githubProjects(paseo)).find((project) => project.repo.toLowerCase() === repo.toLowerCase()) ?? null;
}

export interface Checkout {
  repo: string;
  project: ProjectMatch | null;
  // Where a new branch for an issue starts.
  baseBranch?: string;
}

// The item's own repo, or for an issue the repo its code lives in [SES-05, SES-07].
export async function findCheckout(
  paseo: Paseo,
  config: Pick<AttentionConfig, "codeRepos">,
  target: Target,
  defaultBranch: (repo: string) => Promise<string | null>,
): Promise<Checkout> {
  const repo = target.kind === "issue" ? codeRepoFor(config, target.repo) : target.repo;
  const project = await findProject(paseo, repo);
  if (repo.toLowerCase() === target.repo.toLowerCase()) return { repo, project, baseBranch: target.defaultBranch };
  return { repo, project, baseBranch: project ? ((await defaultBranch(repo)) ?? undefined) : undefined };
}

export function noProjectMessage(checkout: Checkout, target: Target): string {
  const where = checkout.repo === target.repo ? checkout.repo : `${checkout.repo}, where ${target.repo}'s code lives,`;
  return `No Paseo project has ${where} as its GitHub remote. Add the repository as a project first.`;
}

export interface WorkspaceChoice {
  id: string;
  name: string;
}

// Existing workspaces of the project that have the PR's branch checked out.
export async function branchWorkspaces(paseo: Paseo, projectId: string, branch: string | undefined): Promise<WorkspaceChoice[]> {
  if (!branch) return [];
  const { entries } = await paseo.workspaces.list();
  return entries
    .filter((workspace) => workspace.projectId === projectId && workspace.gitRuntime?.currentBranch === branch && !workspace.archivingAt)
    .map((workspace) => ({ id: workspace.id, name: workspace.title ?? workspace.name }));
}

export interface ProfileChoice {
  id: string;
  name: string;
}

export async function listProfiles(paseo: Paseo): Promise<ProfileChoice[]> {
  const { config } = await paseo.config.get();
  return (config.agentProfiles ?? []).map((profile) => ({ id: profile.id, name: profile.name }));
}

type AgentConfig = Parameters<Paseo["agents"]["create"]>[0]["config"];
// Asks the plugin's server, whose snapshot always has the entries [SES-06].
export type FetchProviders = () => Promise<ReadyProvider[]>;

// The profile configured for the session type, then "default", then Paseo's defaults [SES-01, SES-06].
export async function resolveAgentConfig(
  paseo: Paseo,
  fetchProviders: FetchProviders,
  kind: SessionKind,
  config: AttentionConfig,
  profileId?: string,
): Promise<{ agent: AgentConfig; label: string }> {
  const { config: daemon } = await paseo.config.get();
  const profiles = daemon.agentProfiles ?? [];
  const byName = (name: string | undefined) =>
    name ? profiles.find((p) => p.id === name || p.name.toLowerCase() === name.toLowerCase()) : undefined;
  const profile = profileId ? byName(profileId) : (byName(config.profiles[kind]) ?? byName(config.profiles.default));
  // A profile that names its model needs no provider lookup.
  const providers = profile?.model ? [] : await fetchProviders();
  return chooseAgent(profile, providers);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export interface StartSession {
  itemKey: string;
  kind: SessionKind;
  target: Target;
  prompt: string;
  config: AttentionConfig;
  fetchProviders: FetchProviders;
  checkout: Checkout;
  profileId?: string;
  workspaceId?: string; // an existing workspace; otherwise a new worktree
}

// A new worktree: checkout-pr for PRs, branch-off from the default branch for issues.
export async function startSession(paseo: Paseo, input: StartSession): Promise<string> {
  const { target, checkout } = input;
  const project = checkout.project;
  if (!project) throw new Error(noProjectMessage(checkout, target));
  const { agent: agentConfig } = await resolveAgentConfig(paseo, input.fetchProviders, input.kind, input.config, input.profileId);
  const title = sessionTitle(input.kind, target);

  const workspace = input.workspaceId
    ? paseo.workspaces.ref(input.workspaceId)
    : await paseo.workspaces.create({
        title,
        source:
          target.kind === "pr"
            ? {
                kind: "worktree",
                cwd: project.rootPath,
                projectId: project.projectId,
                action: "checkout",
                checkoutSource: { kind: "change_request", forge: "github", number: checkoutPr(input.kind, target).number },
              }
            : {
                kind: "worktree",
                cwd: project.rootPath,
                projectId: project.projectId,
                action: "branch-off",
                baseBranch: checkout.baseBranch,
                branchName: `issue-${target.number}-${slug(target.title)}`,
              },
      });
  const agent = await workspace.agents.create({
    config: agentConfig,
    title,
    prompt: input.prompt,
    labels: { [LABEL]: "1", [ITEM_LABEL]: input.itemKey, [KIND_LABEL]: input.kind },
  });
  return agent.id;
}
