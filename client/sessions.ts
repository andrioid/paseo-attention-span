import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type AgentSummary, type AttentionView, checkoutPr, sessionTitle, type Target } from "../shared/attention";
import { closedBranches } from "../shared/linked-sessions";
import { ITEM_LABEL, KIND_LABEL, LABEL, SESSION_LABELS, sessionsFrom } from "../shared/item-sessions";
import { everyPage } from "../shared/paging";
import { chooseAgent, type ReadyProvider } from "../shared/providers";
import { type AttentionConfig, codeRepoFor, githubRepoOf, SessionKind } from "../shared/config";
import * as rpc from "../shared/rpc";
import { VIEW_QUERY_KEY } from "./data";
import { sameName } from "../shared/names";

type Paseo = ReturnType<typeof usePaseo>;

// The app's session list, shared by the screen and the sidebar's count [ATT-09, ATT-22].
export const AGENTS_QUERY_KEY = ["attention-span", "agents"] as const;

// The sessions on items, polled for the screen and the sidebar alike [ATT-09, ATT-22]. When one has gone since the last
// poll, perhaps archived in Paseo, the server's view is read first (from memory, not GitHub), so the notes the server
// acknowledged for it are cleared before its Wrap up row goes, rather than showing as unread in between [HIS-07].
export function useItemAgents() {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const fetchAttention = useRpc(rpc.getAttention);
  // A list that brings other merged branches than the last poll linked by polls again at once, so a session on a branch
  // just merged reaches Wrap up without waiting for the next round [ATT-22, FRESH-03]. A poll already running finishes
  // first, then sees the change and polls once more.
  const branchesNow = () => closedBranches(queryClient.getQueryData<AttentionView>(VIEW_QUERY_KEY) ?? {});
  const pollAgain = () => {
    if (signature(branchesNow()) !== linkedBy.get(queryClient)) void queryClient.refetchQueries({ queryKey: AGENTS_QUERY_KEY }, { cancelRefetch: false });
  };
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && event.query.queryKey[1] === VIEW_QUERY_KEY[1]) pollAgain();
      }),
    [queryClient],
  );
  return useQuery({
    queryKey: AGENTS_QUERY_KEY,
    refetchInterval: 15_000,
    queryFn: async () => {
      const before = queryClient.getQueryData<AgentSummary[]>(AGENTS_QUERY_KEY);
      // My merged and closed PRs' branches, from the list already loaded, for sessions Paseo no longer links [ATT-22].
      const branches = branchesNow();
      linkedBy.set(queryClient, signature(branches));
      const agents = await itemAgents(paseo, branches);
      const now = new Set(agents.map((agent) => agent.id));
      if (before?.some((agent) => !now.has(agent.id))) {
        await fetchAttention({ cached: true })
          .then((view) => queryClient.setQueryData(VIEW_QUERY_KEY, view))
          .catch(() => {}); // the view's own poll catches up
      }
      // A list that arrived while this poll ran: once it's done, poll again.
      setTimeout(pollAgain, 0);
      return agents;
    },
  });
}

const signature = (branches: Map<string, string>) => [...branches].join("\n");
// The branches the last poll linked by, one record per app, shared by the screen's and the sidebar's copies of the poll.
const linkedBy = new WeakMap<object, string>();

// Labels tie an agent to the item it works on [ATT-07, SES-03]; kept with the rest of the session list in shared.
export { ITEM_LABEL, KIND_LABEL, LABEL };

// Agents started from Attention Span, each with the item it was started on, and the agents started outside it in a
// workspace that belongs to an item [SES-08]. Every page, so a session or sub-agent past the first isn't missed [ATT-22].
export async function itemAgents(paseo: Paseo, branches = new Map<string, string>()): Promise<AgentSummary[]> {
  const [lists, all, workspaces] = await Promise.all([
    Promise.all(SESSION_LABELS.map((label) => everyPage((page) => paseo.agents.list({ filter: { labels: { [label]: "1" } }, page })))),
    everyPage((page) => paseo.agents.list({ page })),
    paseo.workspaces.list(),
  ]);
  return sessionsFrom(
    lists.flat().map((entry) => entry.agent),
    all.map((entry) => entry.agent),
    workspaces.entries,
    branches,
  );
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
  return (await githubProjects(paseo)).find((project) => sameName(project.repo, repo)) ?? null;
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
  if (sameName(repo, target.repo)) return { repo, project, baseBranch: target.defaultBranch };
  return { repo, project, baseBranch: project ? ((await defaultBranch(repo)) ?? undefined) : undefined };
}

export function noProjectMessage(checkout: Checkout, target: Target): string {
  const where = sameName(checkout.repo, target.repo) ? checkout.repo : `${checkout.repo}, where ${target.repo}'s code lives,`;
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

// What a start asks the plugin's server: the prompt's context, a repo's default branch, and the ready providers [SES-01, SES-02].
export function useStartRpcs() {
  const fetchContext = useRpc(rpc.sessionContext);
  const fetchDefaultBranch = useRpc(rpc.defaultBranch);
  const fetchReadyProviders = useRpc(rpc.readyProviders);
  const fetchProviders: FetchProviders = () => fetchReadyProviders({}).then((result) => result.providers);
  return { fetchContext, fetchProviders, defaultBranch: async (repo: string) => (await fetchDefaultBranch({ repo })).name };
}

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
    name ? profiles.find((p) => p.id === name || sameName(p.name, name)) : undefined;
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
