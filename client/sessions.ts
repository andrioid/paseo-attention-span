import type { usePaseo } from "@getpaseo/plugin/client";
import type { InboxConfig, SessionKind } from "../shared/config";
import type { Target } from "../shared/inbox";

type Paseo = ReturnType<typeof usePaseo>;

// Labels tie an agent to the inbox item it works on [ATT-07, SES-03].
export const LABEL = "github-attention";
export const ITEM_LABEL = "github-attention-item";
// Sessions started before the plugin was renamed from "GitHub inbox".
const OLD_LABEL = "github-inbox";
const OLD_ITEM_LABEL = "github-inbox-item";

export interface AgentSummary {
  id: string;
  status: string;
  requiresAttention: boolean;
  title: string | null;
  workspaceId: string | null;
}

// Agents started from the inbox, keyed by item.
export async function inboxAgents(paseo: Paseo): Promise<Record<string, AgentSummary>> {
  const lists = await Promise.all([LABEL, OLD_LABEL].map((label) => paseo.agents.list({ filter: { labels: { [label]: "1" } } })));
  const byItem: Record<string, AgentSummary> = {};
  for (const { agent } of lists.flatMap((list) => list.entries)) {
    const key = agent.labels?.[ITEM_LABEL] ?? agent.labels?.[OLD_ITEM_LABEL];
    if (!key || agent.archivedAt) continue;
    byItem[key] = {
      id: agent.id,
      status: agent.status,
      requiresAttention: !!agent.requiresAttention,
      title: agent.title ?? null,
      workspaceId: agent.workspaceId ?? null,
    };
  }
  return byItem;
}

export interface ProjectMatch {
  projectId: string;
  rootPath: string;
}

// The local checkout is the registered Paseo project with the item's GitHub remote [SES-05].
export async function findProject(paseo: Paseo, repo: string): Promise<ProjectMatch | null> {
  const { projects } = await paseo.projects.list();
  const wanted = `remote:github.com/${repo.toLowerCase()}`;
  const project = projects.find((candidate) => candidate.projectKey?.toLowerCase() === wanted);
  return project ? { projectId: project.projectId, rootPath: project.projectRootPath } : null;
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

// The profile configured for the session type, then "default", then Paseo's defaults [SES-01, SES-06].
export async function resolveAgentConfig(
  paseo: Paseo,
  kind: SessionKind,
  config: InboxConfig,
  profileId?: string,
): Promise<{ agent: AgentConfig; label: string }> {
  const { config: daemon } = await paseo.config.get();
  const profiles = daemon.agentProfiles ?? [];
  const byName = (name: string | undefined) =>
    name ? profiles.find((p) => p.id === name || p.name.toLowerCase() === name.toLowerCase()) : undefined;
  const profile = profileId ? byName(profileId) : (byName(config.profiles[kind]) ?? byName(config.profiles.default));

  const snapshot = await paseo.providers.snapshot();
  const providers = snapshot.entries.filter((entry) => entry.status === "ready" && entry.enabled);
  const defaultModel = (provider: string) => {
    const entry = providers.find((candidate) => candidate.provider === provider);
    return (entry?.models ?? []).find((model) => model.isDefault)?.id ?? entry?.models?.[0]?.id;
  };

  if (profile) {
    const model = profile.model ?? defaultModel(profile.provider);
    return {
      label: profile.name,
      agent: {
        provider: model ? `${profile.provider}/${model}` : profile.provider,
        modeId: profile.modeId,
        thinkingOptionId: profile.thinkingOptionId,
        featureValues: profile.featureValues,
      },
    };
  }
  const fallback = providers.find((entry) => defaultModel(entry.provider));
  if (!fallback) throw new Error("No agent provider is ready on this host.");
  return {
    label: `Paseo default (${fallback.label})`,
    agent: { provider: `${fallback.provider}/${defaultModel(fallback.provider)}`, modeId: fallback.defaultModeId ?? undefined },
  };
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
  config: InboxConfig;
  profileId?: string;
  workspaceId?: string; // an existing workspace; otherwise a new worktree
}

// A new worktree: checkout-pr for PRs, branch-off from the default branch for issues.
export async function startSession(paseo: Paseo, input: StartSession): Promise<string> {
  const { target } = input;
  const project = await findProject(paseo, target.repo);
  if (!project) throw new Error(`No Paseo project has ${target.repo} as its GitHub remote. Add the repository as a project first.`);
  const { agent: agentConfig } = await resolveAgentConfig(paseo, input.kind, input.config, input.profileId);
  const title = `${target.kind === "pr" ? "PR" : "Issue"} ${target.number}: ${target.title}`.slice(0, 120);

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
                checkoutSource: { kind: "change_request", forge: "github", number: target.number },
              }
            : {
                kind: "worktree",
                cwd: project.rootPath,
                projectId: project.projectId,
                action: "branch-off",
                baseBranch: target.defaultBranch,
                branchName: `issue-${target.number}-${slug(target.title)}`,
              },
      });
  const agent = await workspace.agents.create({
    config: agentConfig,
    title,
    prompt: input.prompt,
    labels: { [LABEL]: "1", [ITEM_LABEL]: input.itemKey },
  });
  return agent.id;
}
